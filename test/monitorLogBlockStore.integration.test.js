const enabled = process.env.RUN_LOG_BLOCK_DB === 'true';
const { randomUUID, createHash } = require('crypto');

(enabled ? describe : describe.skip)('压缩日志块隔离数据库正确性', () => {
  const { sequelize, AosDevice, MonitorLogEntry } = require('../src/models');
  const policy = require('../src/services/monitorLogPolicy');
  const store = require('../src/services/monitorLogBlockStore');
  const service = require('../src/services/monitorLogService');
  const deviceId = randomUUID();
  const localId = randomUUID();
  const fileId = randomUUID();
  const today = policy.retention().today;
  const at = Date.parse(`${today}T00:00:00+08:00`);
  function entry(offset, extra = {}) {
    const value = policy.entry({
      id: randomUUID(),
      localId,
      fileId,
      fileName: `Log${today.replace(/-/g, '')}_block.txt`,
      businessDate: today,
      loggedAt: new Date(at + offset).toISOString(),
      accountNumber: '00128',
      lineNumber: offset + 1,
      partIndex: 0,
      byteOffset: offset,
      message: '相同正文并非重复上传\r\n',
      rawBase64: null,
      parseState: 'parsed',
      ...extra,
    });
    return {
      ...value,
      deviceId,
      sortAt: value.loggedAt || value.contextAt || new Date(at).toISOString(),
      payloadHash: policy.digest(value),
      createdAt: new Date(at),
      updatedAt: new Date(at),
    };
  }
  const query = extra => policy.query({ deviceId, localId, date: today, ...extra });
  async function append(rows) {
    try {
      await sequelize.transaction(async transaction => {
        try {
          await store.append(rows, transaction);
        } catch (error) {
          throw new Error(`压缩存储事务失败:${error.name}`);
        }
      });
    } catch (error) {
      throw new Error(error.message);
    }
  }
  beforeAll(async () => {
    try {
      if (
        sequelize.config.database !== 'aos_log_test_blocks_regression' ||
        process.env.DATABASE_URL ||
        process.env.DB_HOST !== 'postgres'
      )
        throw new Error('必须使用独立压缩日志回归空库');
      await AosDevice.create({
        id: deviceId,
        name: '合成压缩回归',
        credentialHash: createHash('sha256').update(deviceId).digest('hex'),
      });
    } catch (error) {
      throw new Error(`隔离初始化失败:${error.name}`);
    }
  });
  beforeEach(async () => {
    try {
      await sequelize.query(
        'TRUNCATE monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,' +
          'monitor_log_files,monitor_log_storage_scopes,monitor_log_storage_metrics,monitor_log_entries RESTART IDENTITY CASCADE'
      );
    } catch (error) {
      throw new Error(`隔离重置失败:${error.name}`);
    }
  });
  afterAll(async () => {
    try {
      await sequelize.query(
        'TRUNCATE monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,' +
          'monitor_log_files,monitor_log_storage_scopes,monitor_log_storage_metrics,monitor_log_entries RESTART IDENTITY CASCADE'
      );
      await AosDevice.destroy({ where: { id: deviceId } });
    } catch (error) {
      throw new Error(error.name);
    } finally {
      await sequelize.close();
    }
  });
  test('中文、特殊字符、异常字节、XML续行、长片段和来源属性无损', async () => {
    const rows = [
      entry(0, { message: '\ufeff中文🙂100%_\\\r\n' }),
      entry(1, { message: '<Order><Item>中文</Item>\n', parseState: 'continuation' }),
      entry(2, {
        loggedAt: null,
        contextAt: new Date(at + 2).toISOString(),
        accountNumber: null,
        parseState: 'encoding_error',
        rawBase64: '/wAB',
        message: '\ufffd\n',
      }),
      entry(3, { message: '长'.repeat(8000), partIndex: 1 }),
      entry(4, { message: '无换行文件尾部' }),
    ];
    await append(rows);
    for (const row of rows) {
      const restored = await store.findById(row.id);
      for (const key of [
        'id',
        'deviceId',
        'localId',
        'fileId',
        'fileName',
        'businessDate',
        'message',
        'rawBase64',
        'accountNumber',
        'parseState',
        'partIndex',
      ])
        expect(restored[key]).toEqual(row[key]);
      expect(Number(restored.byteOffset)).toBe(row.byteOffset);
      expect(Number(restored.lineNumber)).toBe(row.lineNumber);
      expect(new Date(restored.sortAt).toISOString()).toBe(row.sortAt);
      const [receipts] = await sequelize.query(
        "SELECT encode(payload_hash,'hex') AS hash FROM monitor_log_receipts WHERE id=:id",
        { replacements: { id: row.id } }
      );
      expect(receipts[0].hash).toEqual(row.payloadHash);
    }
  });
  test('多块乱序与同毫秒跨文件按原排序归并，深锚点前后无遗漏', async () => {
    const secondFile = randomUUID();
    const sameTime = new Date(at + 50).toISOString();
    const groups = [
      Array.from({ length: 140 }, (_, offset) => entry(offset, { loggedAt: sameTime })),
      Array.from({ length: 140 }, (_, offset) =>
        entry(offset + 200, { fileId: secondFile, loggedAt: sameTime })
      ),
      [
        entry(900, { loggedAt: new Date(at + 1).toISOString() }),
        entry(901, { loggedAt: new Date(at + 5000).toISOString() }),
      ],
    ];
    for (const rows of groups) {
      await append(rows);
      await MonitorLogEntry.bulkCreate(rows);
    }
    const expected = await MonitorLogEntry.findAll({
      order: [
        ['sortAt', 'ASC'],
        ['fileId', 'ASC'],
        ['byteOffset', 'ASC'],
      ],
    });
    const collected = [];
    let anchor = null;
    while (collected.length < expected.length) {
      const page = await store.select(query(), anchor, 'ASC', 50);
      if (!page.length) break;
      collected.push(...page.map(row => row.id));
      anchor = page.at(-1);
      if (collected.length > expected.length) throw new Error('游标未推进');
    }
    expect(collected).toEqual(expected.map(row => row.id));
    anchor = expected[141].toJSON();
    expect((await store.select(query(), anchor, 'DESC', 20)).map(row => row.id)).toEqual(
      expected
        .slice(121, 141)
        .reverse()
        .map(row => row.id)
    );
  });
  test('关键词签名无漏检；字面通配符、emoji、单字、双字及跨片段边界', async () => {
    const messages = ['Alpha %_\\ 中文🙂完整', '另一个正文', 'abc', 'def', 'xml\ncontinuation'];
    const rows = messages.map((message, offset) => entry(offset, { message }));
    await append(rows);
    for (const keyword of [
      '%',
      '_',
      '\\',
      '中文',
      '文',
      '🙂',
      '%_\\',
      'Alpha',
      'continuation',
      'absent',
      'cde',
    ]) {
      expect((await store.select(query({ keyword }), null, 'ASC', 100)).map(row => row.id)).toEqual(
        rows.filter(row => row.message.includes(keyword)).map(row => row.id)
      );
    }
  });
  test('账号前导零、未识别账号、日期、设备与实例隔离；loggedAt空不通过时间筛选', async () => {
    const rows = [
      entry(0),
      entry(1, { accountNumber: '128' }),
      entry(2, { accountNumber: null, loggedAt: null, parseState: 'unparsed' }),
      entry(3, { localId: randomUUID() }),
    ];
    await append(rows);
    expect(
      (await store.select(query({ account: '00128' }), null, 'ASC', 100)).map(row => row.id)
    ).toEqual([rows[0].id]);
    expect(
      (await store.select(query({ account: '__unassigned__' }), null, 'ASC', 100)).map(
        row => row.id
      )
    ).toEqual([rows[2].id]);
    expect(
      (
        await store.select(query({ fromTime: '00:00:00', toTime: '00:00:00' }), null, 'ASC', 100)
      ).map(row => row.id)
    ).toEqual([rows[0].id, rows[1].id]);
    const accounts = await store.accounts(query(), {});
    expect(accounts.items).toEqual(['00128', '128']);
  });
  test('真实重复正文保留、冲突唯一约束整批回滚、块损坏不能返回成功', async () => {
    const rows = [entry(0), entry(1)];
    await append(rows);
    expect((await store.select(query(), null, 'ASC', 100)).map(row => row.id)).toEqual(
      rows.map(row => row.id)
    );
    await expect(
      append([entry(2), entry(0, { id: rows[0].id, message: '已变化' })])
    ).rejects.toThrow();
    expect((await store.select(query(), null, 'ASC', 100)).map(row => row.id)).toEqual(
      rows.map(row => row.id)
    );
    await sequelize.query("UPDATE monitor_log_blocks SET payload='\\x00'::bytea");
    await expect(store.findById(rows[0].id)).rejects.toThrow();
    await expect(store.select(query(), null, 'ASC', 50)).rejects.toThrow();
  });
  test('新存储接收路径并发可靠回执、重传去重、冲突批次回滚和旧ID上下文', async () => {
    await sequelize.query(
      "INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode,generation) VALUES(:deviceId,:localId,'blocks',1)",
      { replacements: { deviceId, localId } }
    );
    const rows = [entry(0), entry(1), entry(2)];
    const toInput = row => {
      const value = { ...row };
      for (const key of ['deviceId', 'sortAt', 'payloadHash', 'createdAt', 'updatedAt'])
        delete value[key];
      return value;
    };
    const entries = rows.map(toInput);
    const responses = await Promise.all([
      service.receive(deviceId, { entries }),
      service.receive(deviceId, { entries }),
    ]);
    for (const response of responses) expect(response.accepted).toEqual(rows.map(row => row.id));
    const [counts] = await sequelize.query(
      'SELECT count(*)::integer AS count FROM monitor_log_receipts'
    );
    expect(counts[0].count).toBe(3);
    expect(await MonitorLogEntry.count()).toBe(0);
    await expect(
      service.receive(deviceId, {
        entries: [toInput(entry(3)), { ...entries[0], message: '载荷变化' }],
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    const page = await service.list(query());
    expect(page.items.map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(page.items[0].payloadHash).toBeUndefined();
    expect(page.items[0].contextAt).toBeUndefined();
    const context = await service.context(rows[1].id, { scope: 'account' });
    expect(context.items.map(row => row.id)).toEqual(rows.map(row => row.id));
  });
  test('设备删除仍级联删除其文件、压缩块、回执与账号目录', async () => {
    const otherDevice = await AosDevice.create({
      id: randomUUID(),
      name: '合成级联删除',
      credentialHash: createHash('sha256').update(randomUUID()).digest('hex'),
    });
    const row = { ...entry(0), deviceId: otherDevice.id };
    await append([row]);
    await otherDevice.destroy();
    expect(await store.findById(row.id)).toBeNull();
    const [counts] = await sequelize.query(
      'SELECT (SELECT count(*) FROM monitor_log_blocks)::integer AS blocks,' +
        '(SELECT count(*) FROM monitor_log_receipts)::integer AS receipts,' +
        '(SELECT count(*) FROM monitor_log_block_accounts)::integer AS accounts'
    );
    expect(counts[0]).toEqual({ blocks: 0, receipts: 0, accounts: 0 });
  });
  test('切换前后的旧游标继续按稳定事件ID定位；空游标与缺省一致', async () => {
    const rows = Array.from({ length: 5 }, (_, offset) => entry(offset));
    await MonitorLogEntry.bulkCreate(rows);
    await append(rows);
    const before = await service.list(query({ limit: 2 }));
    const expected = await service.list(query({ limit: 2, cursor: before.nextCursor }));
    await sequelize.query(
      "INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode,generation) VALUES(:deviceId,:localId,'blocks',1)",
      { replacements: { deviceId, localId } }
    );
    const after = await service.list(query({ limit: 2, cursor: before.nextCursor }));
    expect(after.items.map(row => row.id)).toEqual(expected.items.map(row => row.id));
    expect(await service.list(query({ limit: 2, cursor: '' }))).toEqual(
      await service.list(query({ limit: 2 }))
    );
  });
  test('30天边界有界回收且不误删首日；预算未追平时保留日分区', async () => {
    const first = policy.retention().first;
    const previous = new Date(Date.parse(first) - 86400000).toISOString().slice(0, 10);
    const old = entry(0, {
      businessDate: previous,
      loggedAt: `${previous}T00:00:00.000Z`,
    });
    const oldSecond = entry(1, {
      businessDate: previous,
      loggedAt: `${previous}T00:00:00.001Z`,
    });
    const kept = entry(2, {
      businessDate: first,
      loggedAt: `${first}T00:00:00.002Z`,
    });
    await append([old, oldSecond, kept]);
    const initial = await sequelize.transaction(async transaction => {
      try {
        return await store.cleanup(first, transaction, 1);
      } catch (error) {
        throw new Error(error.name);
      }
    });
    expect(initial.deleted).toBe(1);
    const [partitions] = await sequelize.query('SELECT to_regclass(:name) AS name', {
      replacements: { name: `monitor_log_blocks_${previous.replace(/-/g, '')}` },
    });
    expect(partitions[0].name).not.toBeNull();
    await sequelize.transaction(async transaction => {
      try {
        await store.cleanup(first, transaction, 10);
      } catch (error) {
        throw new Error(`${error.name}:${error.message}`);
      }
    });
    expect(await store.findById(old.id)).toBeNull();
    expect(await store.findById(oldSecond.id)).toBeNull();
    expect((await store.findById(kept.id)).id).toBe(kept.id);
  });
  test('全局默认只让新空实例进入块存储，已有旧日志实例继续旧表读取', async () => {
    const previous = entry(0);
    await MonitorLogEntry.bulkCreate([previous]);
    await sequelize.query(
      'INSERT INTO monitor_log_storage_metrics(name,value) VALUES(\'storage-default\',\'{"mode":"blocks"}\'::jsonb)'
    );
    expect(await store.mode(deviceId, localId)).toBe('rows');
    const newLocalId = randomUUID();
    const created = entry(1, { localId: newLocalId });
    const value = { ...created };
    for (const key of ['deviceId', 'sortAt', 'payloadHash', 'createdAt', 'updatedAt'])
      delete value[key];
    await service.receive(deviceId, { entries: [value] });
    expect(await store.mode(deviceId, newLocalId)).toBe('blocks');
    expect((await service.list(query({ localId: newLocalId }))).items.map(row => row.id)).toEqual([
      created.id,
    ]);
    expect((await service.list(query())).items.map(row => row.id)).toEqual([previous.id]);
    expect(await MonitorLogEntry.count()).toBe(1);
  });
  test('加速模拟完整30天滚动生命周期，每日新块即时可查且逐日回收旧分区', async () => {
    const first = policy.retention().first;
    const day = delta => new Date(Date.parse(first) + delta * 86400000).toISOString().slice(0, 10);
    const rowForDay = delta =>
      entry(delta, {
        businessDate: day(delta),
        fileName: `Log${day(delta).replace(/-/g, '')}_rolling.txt`,
        loggedAt: `${day(delta)}T00:00:00.000Z`,
      });
    await append(Array.from({ length: 30 }, (_, index) => rowForDay(index)));
    for (let step = 1; step <= 30; step++) {
      const fresh = rowForDay(29 + step);
      await append([fresh]);
      await sequelize.transaction(async transaction => {
        try {
          await store.cleanup(day(step), transaction, 5);
        } catch (error) {
          throw new Error(error.message);
        }
      });
      const [counts] = await sequelize.query(
        'SELECT count(*)::integer AS count,min(business_date)::text AS first FROM monitor_log_receipts'
      );
      expect(counts[0]).toEqual({ count: 30, first: day(step) });
      expect((await store.findById(fresh.id)).id).toBe(fresh.id);
    }
  });
  test('跨设备争用全局事件ID在rows/shadow/blocks均返回409且失败整批回滚', async () => {
    for (const mode of ['rows', 'shadow', 'blocks']) {
      await sequelize.query(
        'TRUNCATE monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,' +
          'monitor_log_files,monitor_log_storage_scopes,monitor_log_storage_metrics,monitor_log_entries RESTART IDENTITY CASCADE'
      );
      const anotherLocalId = randomUUID();
      const otherDevice = await AosDevice.create({
        id: randomUUID(),
        name: `合成全局ID并发${mode}`,
        credentialHash: createHash('sha256').update(randomUUID()).digest('hex'),
      });
      await sequelize.query(
        'INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) ' +
          'VALUES(:firstDevice,:firstLocal,:mode),(:secondDevice,:secondLocal,:mode)',
        {
          replacements: {
            firstDevice: deviceId,
            firstLocal: localId,
            secondDevice: otherDevice.id,
            secondLocal: anotherLocalId,
            mode,
          },
        }
      );
      const eventId = randomUUID();
      const firstRows = [entry(0, { id: eventId, message: '第一设备载荷' }), entry(1)];
      const secondRows = [
        entry(2, { id: eventId, localId: anotherLocalId, message: '另一设备不同载荷' }),
        entry(3, { localId: anotherLocalId }),
      ];
      const toInput = row => {
        const value = { ...row };
        for (const key of ['deviceId', 'sortAt', 'payloadHash', 'createdAt', 'updatedAt'])
          delete value[key];
        return value;
      };
      const results = await Promise.allSettled([
        service.receive(deviceId, { entries: firstRows.map(toInput) }),
        service.receive(otherDevice.id, { entries: secondRows.map(toInput) }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find(result => result.status === 'rejected');
      expect(failed.reason.statusCode).toBe(409);
      const loser = results[0].status === 'rejected' ? firstRows[1] : secondRows[1];
      expect(await MonitorLogEntry.findByPk(loser.id)).toBeNull();
      expect(await store.findById(loser.id)).toBeNull();
      expect(await MonitorLogEntry.count()).toBe(mode === 'blocks' ? 0 : 2);
      const [counts] = await sequelize.query(
        'SELECT count(*)::integer AS count FROM monitor_log_receipts'
      );
      expect(counts[0].count).toBe(mode === 'rows' ? 0 : 2);
      await otherDevice.destroy();
    }
  });
});
