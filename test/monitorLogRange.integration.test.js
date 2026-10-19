const enabled = process.env.RUN_MONITOR_LOG_RANGE_DB === 'true';
const { randomUUID, createHash } = require('crypto');

(enabled ? describe : describe.skip)('跨天完整日志隔离数据库回归', () => {
  const { sequelize, AosDevice, MonitorLogEntry } = require('../src/models');
  const policy = require('../src/services/monitorLogPolicy');
  const service = require('../src/services/monitorLogService');
  const store = require('../src/services/monitorLogBlockStore');
  const deviceId = randomUUID();
  const localId = randomUUID();
  const today = policy.retention().today;
  const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  const range = {
    deviceId,
    localId,
    startAt: `${yesterday}T23:59:59`,
    endAt: `${today}T00:00:00`,
  };
  const start = Date.parse(`${range.startAt}+08:00`);
  let rows;

  beforeAll(async () => {
    try {
      if (sequelize.config.database !== 'aos_log_test_range_backend' || process.env.DATABASE_URL)
        throw new Error('必须使用独立日志范围回归空库');
      await AosDevice.create({
        id: deviceId,
        name: '跨天合成测试',
        credentialHash: createHash('sha256').update(deviceId).digest('hex'),
      });
    } catch (error) {
      throw new Error(`隔离初始化失败:${error.name}`);
    }
  });
  afterAll(async () => {
    try {
      await AosDevice.destroy({ where: { id: deviceId } });
    } finally {
      await sequelize.close();
    }
  });

  describe.each(['rows', 'blocks'])('%s存储', mode => {
    beforeEach(async () => {
      try {
        await sequelize.query(
          'TRUNCATE monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,' +
            'monitor_log_files,monitor_log_storage_scopes,monitor_log_storage_metrics,monitor_log_entries RESTART IDENTITY CASCADE'
        );
        await sequelize.query(
          'INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode,generation) VALUES(:deviceId,:localId,:mode,1)',
          { replacements: { deviceId, localId, mode } }
        );
        const files = [randomUUID(), randomUUID()];
        rows = [-1, ...Array.from({ length: 205 }, (_, i) => i * 9), 1999, 2000].map((ms, i) => {
          const loggedAt = new Date(start + ms).toISOString();
          const businessDate = policy.retention(new Date(loggedAt)).today;
          const value = policy.entry({
            id: randomUUID(),
            localId,
            fileId: files[businessDate === yesterday ? 0 : 1],
            fileName: `Log${businessDate.replace(/-/g, '')}_range.txt`,
            businessDate,
            loggedAt: i === 8 ? null : loggedAt,
            contextAt: i === 8 ? loggedAt : null,
            accountNumber: i === 8 ? null : i % 2 ? '001' : '002',
            lineNumber: i + 1,
            partIndex: 0,
            byteOffset: i * 100,
            message: i === 8 ? '无时间原文\n' : `范围日志 ${i}\r\n`,
            rawBase64: null,
            parseState: i === 8 ? 'unparsed' : 'parsed',
          });
          return { ...value, deviceId, sortAt: loggedAt, payloadHash: policy.digest(value) };
        });
        if (mode === 'rows') await MonitorLogEntry.bulkCreate(rows);
        else
          await sequelize.transaction(async transaction => {
            try {
              await store.append(rows, transaction);
            } catch (error) {
              throw new Error(`压缩存储事务失败:${error.name}`);
            }
          });
      } catch (error) {
        throw new Error(`隔离准备失败:${error.message}`);
      }
    });

    test('跨午夜稳定游标分页、结束秒毫秒、无时间片段不丢失', async () => {
      const items = [];
      let cursor;
      do {
        const page = await service.list({ ...range, limit: 37, cursor });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(items.map(row => row.id)).toEqual(rows.slice(1, -1).map(row => row.id));
      expect(items.find(row => row.id === rows[8].id).loggedAt).toBeNull();
      expect(items.at(-1).id).toBe(rows.at(-2).id);
      expect(new Set(items.map(row => row.id)).size).toBe(items.length);
    });

    test('游标绑定起止日期、账号、关键词和limit', async () => {
      const page = await service.list({ ...range, limit: 3 });
      for (const change of [
        { startAt: `${yesterday}T23:59:58` },
        { endAt: `${today}T00:00:01` },
        { account: '001' },
        { keyword: '日志' },
        { limit: 4 },
      ])
        await expect(
          service.list({ ...range, limit: 3, cursor: page.nextCursor, ...change })
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    test('关键词、未识别账号、日期范围账号去重及兼容旧单日时间', async () => {
      expect(
        (await service.list({ ...range, keyword: '无时间' })).items.map(row => row.id)
      ).toEqual([rows[8].id]);
      expect(
        (await service.list({ ...range, account: '__unassigned__' })).items.map(row => row.id)
      ).toEqual([rows[8].id]);
      const accounts = await service.accounts({
        deviceId,
        localId,
        startDate: yesterday,
        endDate: today,
      });
      expect(accounts.items).toEqual(['001', '002']);
      expect(
        (
          await service.accounts({
            deviceId,
            localId,
            startDate: yesterday,
            endDate: today,
            after: '001',
          })
        ).items
      ).toEqual(['002']);
      const legacy = await service.list({
        deviceId,
        localId,
        date: today,
        fromTime: '00:00:00',
        toTime: '00:00:00',
        limit: 100,
      });
      expect(legacy.items.map(row => row.id)).toEqual(
        rows
          .filter(
            row =>
              row.loggedAt &&
              Date.parse(row.loggedAt) >= start + 1000 &&
              Date.parse(row.loggedAt) < start + 2000
          )
          .map(row => row.id)
      );
      await expect(
        service.accounts({ deviceId, localId, date: today, startDate: yesterday, endDate: today })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    test('跨天导出超过两页且保留原文顺序、换行、范围绑定', async () => {
      const prepared = await service.prepareExport(range);
      const chunks = [];
      const result = await service.writeExport(prepared, message => {
        chunks.push(message);
        return true;
      });
      expect(result).toMatchObject({ exported: rows.length - 2, aborted: false });
      expect(chunks.join('')).toBe(
        rows
          .slice(1, -1)
          .map(row => row.message)
          .join('')
      );
      expect(prepared.fileName).toContain(yesterday);
      expect(prepared.fileName).toContain(today);
      await expect(service.prepareExport({ ...range, keyword: '范围日志' })).rejects.toMatchObject({
        statusCode: 400,
      });
      const old = await service.prepareExport({ deviceId, localId, date: yesterday });
      expect(old.rows[0].id).toBe(rows[0].id);
    });

    test('导出断开立即停止、上下文仍限制锚点当天', async () => {
      const result = await service.writeExport(await service.prepareExport(range), () => false);
      expect(result).toMatchObject({ exported: 0, aborted: true });
      const context = await service.context(rows[8].id, { scope: 'instance' });
      expect(context.items.every(row => row.businessDate === yesterday)).toBe(true);
    });
  });
});
