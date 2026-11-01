const enabled = process.env.RUN_LOG_QUERY_DB === 'true';
const { randomUUID, createHash } = require('crypto');

(enabled ? describe : describe.skip)('日志UI真实查询边界（隔离PostgreSQL）', () => {
  const { sequelize, AosDevice, MonitorLogEntry } = require('../src/models');
  const policy = require('../src/services/monitorLogPolicy');
  const service = require('../src/services/monitorLogService');
  const store = require('../src/services/monitorLogBlockStore');
  const deviceId = randomUUID();
  const localId = randomUUID();
  const anotherId = randomUUID();
  const today = policy.retention().today;
  const day = offset => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
  const range = {
    deviceId,
    localId,
    startAt: `${day(-9)}T16:23:55`,
    endAt: `${day(-7)}T12:23:20`,
    timeBasis: 'loggedAt',
  };
  let rows;
  let server;
  let base;
  beforeAll(async () => {
    try {
      if (sequelize.config.database !== 'aos_log_test_query' || process.env.DATABASE_URL)
        throw new Error('只能使用专用日志UI查询测试库');
      await sequelize.query('TRUNCATE aos_devices CASCADE');
      await AosDevice.create({
        id: deviceId,
        name: '合成边界服务器',
        credentialHash: createHash('sha256').update(deviceId).digest('hex'),
      });
      const express = require('express');
      const app = express();
      app.use((req, _res, next) => {
        req.user = { id: 1, role: 'operator', permissions: ['monitor.logs.read'] };
        next();
      });
      app.use('/api/server-monitor', require('../src/routes/serverMonitor'));
      app.use(require('../src/middleware/errorHandler'));
      server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      });
      base = `http://127.0.0.1:${server.address().port}/api/server-monitor/logs`;
    } catch (error) {
      throw new Error(`隔离初始化：${error.message}`);
    }
  });
  afterAll(async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      await AosDevice.destroy({ where: { id: deviceId } });
    } finally {
      await sequelize.close();
    }
  });
  describe.each(['rows', 'blocks'])('%s存储', mode => {
    beforeEach(async () => {
      try {
        await sequelize.query(
          'TRUNCATE monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,monitor_log_files,monitor_log_storage_scopes,monitor_log_entries RESTART IDENTITY CASCADE'
        );
        await sequelize.query(
          'INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode,generation) VALUES(:deviceId,:localId,:mode,1)',
          { replacements: { deviceId, localId, mode } }
        );
        const moments = [
          `${day(-9)}T16:23:54.999`,
          `${day(-9)}T16:23:55.000`,
          `${day(-8)}T00:00:00.000`,
          `${day(-8)}T12:00:00.000`,
          `${day(-8)}T23:59:59.999`,
          `${day(-7)}T12:23:20.000`,
          `${day(-7)}T12:23:20.999`,
          `${day(-7)}T12:23:21.000`,
        ];
        const files = new Map();
        rows = moments.map((at, index) => {
          const date = at.slice(0, 10);
          if (!files.has(date)) files.set(date, randomUUID());
          const item = policy.entry({
            id: randomUUID(),
            localId,
            fileId: files.get(date),
            fileName: `Log${date.replace(/-/g, '')}_test.txt`,
            businessDate: date,
            loggedAt: new Date(`${at}+08:00`).toISOString(),
            accountNumber: index === 0 || index === 7 ? '999' : '001',
            lineNumber: index + 1,
            partIndex: 0,
            byteOffset: index * 100,
            message: '<script>字面%_\\</script>\r\n',
            rawBase64: null,
            parseState: 'parsed',
          });
          return { ...item, deviceId, sortAt: item.loggedAt, payloadHash: policy.digest(item) };
        });
        const unknown = {
          ...rows[3],
          id: randomUUID(),
          byteOffset: 9999,
          loggedAt: null,
          accountNumber: '777',
          parseState: 'continuation',
        };
        unknown.payloadHash = policy.digest(unknown);
        rows.push(unknown);
        if (mode === 'rows') await MonitorLogEntry.bulkCreate(rows);
        else
          await sequelize.transaction(async transaction => {
            try {
              await store.append(rows, transaction);
            } catch (error) {
              throw new Error(`隔离压缩事务失败：${error.message}`);
            }
          });
      } catch (error) {
        throw new Error(`准备失败：${error.message}`);
      }
    });
    test('连续三日毫秒边界、中间整天、真实HTTP和旧调用兼容', async () => {
      const items = [];
      let cursor;
      do {
        const response = await fetch(
          base + '?' + new URLSearchParams({ ...range, limit: 2, ...(cursor ? { cursor } : {}) })
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const page = (await response.json()).data;
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(items.map(row => row.id)).toEqual(rows.slice(1, 7).map(row => row.id));
      expect(items.every(row => row.loggedAt)).toBe(true);
      const { timeBasis, ...compatible } = range;
      expect(timeBasis).toBe('loggedAt');
      expect((await service.list(compatible)).items).toHaveLength(7);
      expect((await service.list({ deviceId, localId, date: day(-8) })).items).toHaveLength(4);
      expect((await service.list({ ...range, keyword: '%_\\' })).items).toHaveLength(6);
      const second = await service.list({
        ...range,
        startAt: `${day(-7)}T12:23:20`,
        endAt: `${day(-7)}T12:23:20`,
      });
      expect(second.items.map(row => row.id)).toEqual(rows.slice(5, 7).map(row => row.id));
    });
    test('秒级账号候选与列表同范围、前导零、无时间排除和字面search', async () => {
      expect((await service.accounts(range)).items).toEqual(['001']);
      expect((await service.accounts({ ...range, search: '00' })).items).toEqual(['001']);
      expect((await service.accounts({ ...range, search: '%' })).items).toEqual([]);
      expect((await service.accounts({ deviceId, localId, date: day(-8) })).items).toEqual([
        '001',
        '777',
      ]);
      await expect(service.accounts({ ...range, date: today })).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(service.accounts({ ...range, after: '001' })).rejects.toMatchObject({
        statusCode: 400,
      });
    });
    test('列表游标绑定口径、范围、资源、关键词及账号', async () => {
      const first = await service.list({ ...range, limit: 2 });
      for (const change of [
        { timeBasis: undefined },
        { endAt: `${day(-7)}T12:23:21` },
        { account: '001' },
        { keyword: '字面' },
        { localId: anotherId },
      ])
        await expect(
          service.list({ ...range, limit: 2, cursor: first.nextCursor, ...change })
        ).rejects.toMatchObject({ statusCode: 400 });
    });
    test('十万片段精确列表与账号候选有界读取', async () => {
      const at = Date.parse(`${day(-8)}T10:00:00+08:00`);
      if (mode === 'rows') {
        await sequelize.query(
          `INSERT INTO monitor_log_entries (id,device_id,local_id,file_id,file_name,business_date,logged_at,sort_at,account_number,line_number,part_index,byte_offset,message,parse_state,payload_hash)
          SELECT gen_random_uuid(),:deviceId::uuid,:localId::uuid,:fileId::uuid,:fileName,:day::date,
          :at::timestamptz+n*interval '1 millisecond',:at::timestamptz+n*interval '1 millisecond',
          (1000+n%200)::text,n+1,0,n+100000,'合成性能原文','parsed',repeat('a',64) FROM generate_series(0,99999) n`,
          {
            replacements: {
              deviceId,
              localId,
              fileId: rows[3].fileId,
              fileName: rows[3].fileName,
              day: day(-8),
              at: new Date(at).toISOString(),
            },
          }
        );
      } else {
        const entries = Array.from({ length: 100000 }, (_, index) => {
          const loggedAt = new Date(at + index).toISOString();
          const item = {
            ...rows[3],
            id: randomUUID(),
            accountNumber: String(1000 + (index % 200)),
            loggedAt,
            sortAt: loggedAt,
            byteOffset: 100000 + index,
            lineNumber: index + 1,
            message: '合成性能原文',
          };
          return { ...item, payloadHash: policy.digest(item) };
        });
        // 按正式上传上限200个片段构造，避免一次性巨型回执SQL偏离真实链路。
        for (let offset = 0; offset < entries.length; offset += 200) {
          await sequelize.transaction(async transaction => {
            try {
              await store.append(entries.slice(offset, offset + 200), transaction);
            } catch (error) {
              throw new Error(`合成性能准备失败：${error.message}`);
            }
          });
        }
      }
      const query = {
        deviceId,
        localId,
        startAt: `${day(-8)}T10:00:00`,
        endAt: `${day(-8)}T10:00:00`,
        timeBasis: 'loggedAt',
      };
      const started = performance.now();
      const list = await service.list({ ...query, limit: 100 });
      const listMs = performance.now() - started;
      const accountStarted = performance.now();
      const candidates = await service.accounts(query);
      const accountMs = performance.now() - accountStarted;
      expect(list.items).toHaveLength(100);
      expect(candidates.items).toHaveLength(100);
      expect(candidates.nextCursor).toBeTruthy();
      expect(listMs).toBeLessThan(5000);
      expect(accountMs).toBeLessThan(5000);
      require('../src/utils/logger').info('日志UI十万片段隔离验证', { mode, listMs, accountMs });
    }, 60000);
    test('跨月和跨年的真实查询保持连续区间', async () => {
      // 只替换Date，保留网络、PostgreSQL与超时计时器为真实运行。
      jest.useFakeTimers({
        now: new Date('2026-01-02T00:00:00Z'),
        doNotFake: [
          'nextTick',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
          'performance',
          'hrtime',
          'queueMicrotask',
        ],
      });
      try {
        const values = ['2025-12-31T23:59:59.000', '2026-01-01T00:00:00.999'].map((at, index) => {
          const loggedAt = new Date(`${at}+08:00`).toISOString();
          const item = policy.entry({
            ...Object.fromEntries(
              Object.entries(rows[0]).filter(
                ([key]) =>
                  !['deviceId', 'sortAt', 'payloadHash', 'createdAt', 'updatedAt'].includes(key)
              )
            ),
            id: randomUUID(),
            fileId: randomUUID(),
            fileName: `Log${at.slice(0, 10).replace(/-/g, '')}_year.txt`,
            businessDate: at.slice(0, 10),
            loggedAt,
            contextAt: null,
            byteOffset: index,
          });
          return { ...item, deviceId, sortAt: loggedAt, payloadHash: policy.digest(item) };
        });
        if (mode === 'rows') await MonitorLogEntry.bulkCreate(values);
        else
          await sequelize.transaction(async transaction => {
            try {
              await store.append(values, transaction);
            } catch (error) {
              throw new Error(`隔离压缩事务失败：${error.message}`);
            }
          });
        const result = await service.list({
          deviceId,
          localId,
          startAt: '2025-12-31T23:59:59',
          endAt: '2026-01-01T00:00:00',
          timeBasis: 'loggedAt',
        });
        expect(result.items.map(item => item.id)).toEqual(values.map(item => item.id));
      } finally {
        jest.useRealTimers();
      }
    });
    test('同范围账号候选分页与完整游标绑定', async () => {
      const extra = Array.from({ length: 110 }, (_, index) => {
        const item = {
          ...rows[3],
          id: randomUUID(),
          accountNumber: String(index + 1000),
          byteOffset: 20000 + index,
        };
        return { ...item, payloadHash: policy.digest(item) };
      });
      if (mode === 'rows') await MonitorLogEntry.bulkCreate(extra);
      else
        await sequelize.transaction(async transaction => {
          try {
            await store.append(extra, transaction);
          } catch (error) {
            throw new Error(`隔离压缩事务失败：${error.message}`);
          }
        });
      const first = await service.accounts(range);
      expect(first.items).toHaveLength(100);
      const second = await service.accounts({ ...range, cursor: first.nextCursor });
      expect(second.items).toHaveLength(11);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items]).size).toBe(111);
      for (const change of [
        { endAt: `${day(-7)}T12:23:21` },
        { search: '1' },
        { timeBasis: undefined },
        { localId: anotherId },
      ])
        await expect(
          service.accounts({ ...range, cursor: first.nextCursor, ...change })
        ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
