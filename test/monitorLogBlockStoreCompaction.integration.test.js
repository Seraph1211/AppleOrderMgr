const enabled = process.env.RUN_LOG_BLOCK_DB === 'true';
const { randomUUID, createHash } = require('crypto');

(enabled ? describe : describe.skip)('当前日与结束日不可变块压实的隔离回归', () => {
  const { sequelize, AosDevice } = require('../src/models');
  const { QueryTypes } = require('sequelize');
  const policy = require('../src/services/monitorLogPolicy');
  const store = require('../src/services/monitorLogBlockStore');
  const { compact } = require('../src/services/monitorLogBlockCompactor');
  const deviceId = randomUUID();
  const localId = randomUUID();
  const fileId = randomUUID();
  const today = policy.retention().today;
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const at = Date.parse(`${today}T00:00:00+08:00`);
  const query = extra => policy.query({ deviceId, localId, date: today, ...extra });
  async function collectRows(current) {
    try {
      const rows = [];
      let anchor = null;
      for (let page = 0; page < 100; page++) {
        const batch = await store.select(current, anchor, 'ASC', 100);
        rows.push(...batch);
        if (batch.length < 100) return rows;
        anchor = batch.at(-1);
      }
      throw new Error('压实测试游标未收敛');
    } catch (error) {
      throw new Error(`压实全页读取失败:${error.message}`);
    }
  }

  function row(index, overrides = {}) {
    const value = policy.entry({
      id: randomUUID(),
      localId,
      fileId,
      fileName: `Log${today.replace(/-/g, '')}_compact.txt`,
      businessDate: today,
      loggedAt: index % 9 === 0 ? null : new Date(at + 123).toISOString(),
      contextAt: index % 9 === 0 ? new Date(at + 123).toISOString() : null,
      accountNumber: index % 9 === 0 ? null : `00${index % 3}`,
      lineNumber: index + 1,
      partIndex: index % 2,
      byteOffset: index * 100,
      message: index % 5 ? '重复原文🙂\r\n' : '\ufeff字面100%_\\中文🙂\r\n',
      rawBase64: index % 9 === 0 ? 'AP8=' : null,
      parseState: index % 9 === 0 ? 'encoding_error' : 'parsed',
      ...overrides,
    });
    return {
      ...value,
      deviceId,
      sortAt: new Date(at + 123).toISOString(),
      payloadHash: policy.digest(value),
      createdAt: new Date(at),
      updatedAt: new Date(at),
    };
  }
  async function seed(requestSize = 1) {
    try {
      const rows = Array.from({ length: 200 }, (_, index) => row(index));
      for (let start = 0; start < rows.length; start += requestSize) {
        const batch = rows.slice(start, start + requestSize);
        await sequelize.transaction(async transaction => {
          try {
            await store.append(batch, transaction);
          } catch (error) {
            throw new Error(`压实夹具事务失败:${error.name}`);
          }
        });
        expect(await store.findById(batch.at(-1).id)).toMatchObject({
          id: batch.at(-1).id,
          message: batch.at(-1).message,
        });
      }
      return rows;
    } catch (error) {
      throw new Error(`压实夹具写入失败:${error.message}`);
    }
  }
  async function receipts() {
    try {
      return await sequelize.query(
        `SELECT id,file_key,byte_offset,encode(payload_hash,'hex') AS hash,
        business_date FROM monitor_log_receipts ORDER BY byte_offset`,
        { type: QueryTypes.SELECT }
      );
    } catch (error) {
      throw new Error(`压实回执读取失败:${error.name}`);
    }
  }
  async function blockCount() {
    try {
      return Number(
        (
          await sequelize.query('SELECT count(*)::text AS value FROM monitor_log_blocks', {
            type: QueryTypes.SELECT,
          })
        )[0].value
      );
    } catch (error) {
      throw new Error(`压实块数读取失败:${error.name}`);
    }
  }
  beforeAll(async () => {
    try {
      if (
        sequelize.config.database !== 'aos_log_test_blocks_regression' ||
        process.env.DB_HOST !== 'postgres' ||
        process.env.DATABASE_URL
      )
        throw new Error('压实回归仅允许隔离专库');
      await AosDevice.create({
        id: deviceId,
        name: '合成压实回归',
        credentialHash: createHash('sha256').update(deviceId).digest('hex'),
      });
    } catch (error) {
      throw new Error(`压实初始化失败:${error.name}`);
    }
  });
  beforeEach(async () => {
    try {
      await sequelize.query(
        'TRUNCATE monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,monitor_log_files,monitor_log_storage_scopes,monitor_log_storage_metrics,monitor_log_entries RESTART IDENTITY CASCADE'
      );
      await sequelize.query(
        `INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:deviceId,:localId,'blocks');
        INSERT INTO monitor_log_storage_metrics(name,value) VALUES('storage-default','{"mode":"blocks"}')`,
        { replacements: { deviceId, localId } }
      );
    } catch (error) {
      throw new Error(`压实重置失败:${error.name}`);
    }
  });
  afterAll(async () => {
    try {
      await sequelize.query(
        'TRUNCATE monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,monitor_log_files,monitor_log_storage_scopes,monitor_log_storage_metrics,monitor_log_entries RESTART IDENTITY CASCADE'
      );
      await AosDevice.destroy({ where: { id: deviceId } });
    } catch (error) {
      throw new Error(`压实清理失败:${error.name}`);
    } finally {
      await sequelize.close();
    }
  });
  test.each([1, 10, 200])(
    '每请求%s片段立即可见，次日压实保持全部字段、回执、游标和账号关键词',
    async requestSize => {
      const rows = await seed(requestSize);
      const before = await collectRows(query());
      const beforeReceipts = await receipts();
      const beforeAccounts = await store.accounts(query(), {});
      const oldCount = await blockCount();
      for (let round = 0; round < 4; round++)
        await compact({
          today: tomorrow,
          maxBatches: 20,
          budgetMs: 10000,
          maxRows: 1000,
          maxSourceBlocks: 64,
        });
      const after = await collectRows(query());
      expect(after).toEqual(before);
      expect(await receipts()).toEqual(beforeReceipts);
      expect(await store.accounts(query(), {})).toEqual(beforeAccounts);
      if (requestSize < 200) expect(await blockCount()).toBeLessThan(oldCount);
      for (const value of rows)
        expect(await store.findById(value.id)).toEqual(before.find(item => item.id === value.id));
      expect(await store.select(query(), before[49], 'ASC', 50)).toEqual(before.slice(50, 100));
      expect(await store.select(query(), before[141], 'DESC', 20)).toEqual(
        before.slice(121, 141).reverse()
      );
      for (const keyword of ['%', '_', '\\', '中文', '文', '🙂', '无匹配'])
        expect(await collectRows(query({ keyword }))).toEqual(
          before.filter(value => value.message.includes(keyword))
        );
      expect(await collectRows(query({ account: '001' }))).toEqual(
        before.filter(value => value.accountNumber === '001')
      );
      expect(await collectRows(query({ account: '__unassigned__' }))).toEqual(
        before.filter(value => value.accountNumber === null)
      );
    },
    120000
  );
  test('当前业务日可压实，CLI维护水位仍跳过', async () => {
    await seed();
    const before = await blockCount();
    await compact({ today, maxBatches: 20, budgetMs: 10000 });
    expect(await blockCount()).toBeLessThan(before);
    await sequelize.transaction(async transaction => {
      try {
        await store.append([row(201)], transaction);
      } catch (error) {
        throw new Error(`维护夹具写入失败:${error.name}`);
      }
    });
    const compacted = await blockCount();
    await sequelize.query(
      'INSERT INTO monitor_log_storage_metrics(name,value) VALUES(:name,\'{"maintenance":true}\') ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value',
      { replacements: { name: `migration:${deviceId}:${localId}` } }
    );
    await compact({ today: tomorrow, maxBatches: 20, budgetMs: 10000 });
    expect(await blockCount()).toBe(compacted);
  }, 120000);
  test('2MiB目标下大块组不会饿死其他可合并小块组', async () => {
    const prior = process.env.MONITOR_LOG_BLOCK_BYTES;
    process.env.MONITOR_LOG_BLOCK_BYTES = '2097152';
    try {
      const otherFile = randomUUID();
      for (const [start, count, file] of [
        [0, 1000, fileId],
        [1000, 1000, fileId],
        [2000, 10, otherFile],
        [2010, 10, otherFile],
      ]) {
        const values = Array.from({ length: count }, (_, i) => row(start + i, { fileId: file }));
        await sequelize.transaction(async transaction => {
          try {
            await store.append(values, transaction);
          } catch (error) {
            throw new Error(`目标块大小夹具失败:${error.name}`);
          }
        });
      }
      const before = await receipts();
      expect(await blockCount()).toBe(4);
      const result = await compact({ today, maxRows: 1000, maxBatches: 10, budgetMs: 5000 });
      expect(result.batches).toBeGreaterThan(0);
      expect(await blockCount()).toBe(3);
      expect(await receipts()).toEqual(before);
      const counts = await sequelize.query(
        'SELECT entry_count FROM monitor_log_blocks ORDER BY entry_count',
        { type: QueryTypes.SELECT }
      );
      expect(counts.map(value => value.entry_count)).toEqual([20, 1000, 1000]);
    } finally {
      if (prior === undefined) delete process.env.MONITOR_LOG_BLOCK_BYTES;
      else process.env.MONITOR_LOG_BLOCK_BYTES = prior;
    }
  }, 120000);
  test('搬回执后的事务故障不留下新块、残留目录或破坏原定位', async () => {
    await seed();
    const before = await collectRows(query());
    const beforeReceipts = await receipts();
    const beforeCount = await blockCount();
    const original = sequelize.query.bind(sequelize);
    let moved = false;
    let injected = false;
    const spy = jest.spyOn(sequelize, 'query').mockImplementation(async (sql, options) => {
      try {
        const text = typeof sql === 'string' ? sql : sql.query;
        if (moved && /DELETE\s+FROM\s+monitor_log_blocks/i.test(text)) {
          injected = true;
          throw new Error('synthetic-compaction-rollback');
        }
        const result = await original(sql, options);
        if (/UPDATE\s+monitor_log_receipts/i.test(text)) moved = true;
        return result;
      } catch (error) {
        throw new Error(error.message);
      }
    });
    try {
      await compact({ today: tomorrow, maxBatches: 1, budgetMs: 10000 });
    } catch (error) {
      expect(error.message).toContain('synthetic-compaction-rollback');
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await blockCount()).toBe(beforeCount);
    expect(await receipts()).toEqual(beforeReceipts);
    expect(await collectRows(query())).toEqual(before);
    for (const item of before) expect(await store.findById(item.id)).toEqual(item);
  }, 120000);
});
