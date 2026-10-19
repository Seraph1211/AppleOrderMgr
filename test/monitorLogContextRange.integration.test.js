const enabled = process.env.RUN_MONITOR_LOG_CONTEXT_DB === 'true';
const { randomUUID, createHash } = require('crypto');

(enabled ? describe : describe.skip)('跨天连续上下文隔离数据库回归', () => {
  const { sequelize, AosDevice, MonitorLogEntry } = require('../src/models');
  const policy = require('../src/services/monitorLogPolicy');
  const service = require('../src/services/monitorLogService');
  const store = require('../src/services/monitorLogBlockStore');
  const deviceId = randomUUID();
  const foreignDeviceId = randomUUID();
  const localId = randomUUID();
  const otherLocalId = randomUUID();
  const today = policy.retention().today;
  const day = offset => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
  const anchorDay = day(-2);
  let server;
  let base;
  let mode;
  let ordinal = 0;

  function row(date, offset = 0, extra = {}) {
    ordinal++;
    const sortAt = new Date(Date.parse(`${date}T00:00:00+08:00`) + offset).toISOString();
    const item = policy.entry({
      id: randomUUID(),
      localId,
      fileId: randomUUID(),
      fileName: `Log${date.replace(/-/g, '')}_context.txt`,
      businessDate: date,
      loggedAt: sortAt,
      accountNumber: '001',
      lineNumber: ordinal,
      partIndex: 0,
      byteOffset: ordinal * 100,
      message: `合成上下文 ${ordinal}\r\n`,
      rawBase64: null,
      parseState: 'parsed',
      ...extra,
    });
    return {
      ...item,
      deviceId,
      sortAt: item.loggedAt || item.contextAt || sortAt,
      payloadHash: policy.digest(item),
    };
  }

  async function save(rows) {
    try {
      if (mode === 'rows') await MonitorLogEntry.bulkCreate(rows);
      else
        await sequelize.transaction(async transaction => {
          try {
            await store.append(rows, transaction);
          } catch (error) {
            throw new Error(`跨天上下文回归失败：${error.message}`);
          }
        });
    } catch (error) {
      throw new Error(`跨天上下文回归失败：${error.message}`);
    }
  }

  function sorted(rows) {
    return [...rows].sort((a, b) => store.compare(a, b) || a.id.localeCompare(b.id));
  }

  async function loadAll(anchor, scope, initial) {
    try {
      const items = [...initial.items];
      let before = initial.hasMoreBefore;
      let after = initial.hasMoreAfter;
      let beforePages = 0;
      let afterPages = 0;
      while (before) {
        const page = await service.context(anchor.id, {
          scope,
          cursor: items[0].id,
          direction: 'before',
          limit: 23,
        });
        expect(page.anchorId).toBe(anchor.id);
        expect(page.direction).toBe('before');
        expect(page.items.length).toBeLessThanOrEqual(23);
        items.unshift(...page.items);
        before = page.hasMore;
        beforePages++;
        expect(beforePages).toBeLessThan(30);
      }
      while (after) {
        const page = await service.context(anchor.id, {
          scope,
          cursor: items.at(-1).id,
          direction: 'after',
          limit: 23,
        });
        expect(page.anchorId).toBe(anchor.id);
        expect(page.direction).toBe('after');
        expect(page.items.length).toBeLessThanOrEqual(23);
        items.push(...page.items);
        after = page.hasMore;
        afterPages++;
        expect(afterPages).toBeLessThan(30);
      }
      return { items, beforePages, afterPages };
    } catch (error) {
      throw new Error(`跨天上下文回归失败：${error.message}`);
    }
  }

  beforeAll(async () => {
    try {
      if (
        sequelize.config.database !== 'aos_log_test_context_backend' ||
        process.env.DATABASE_URL ||
        process.env.DB_HOST !== 'postgres'
      )
        throw new Error('必须使用独立跨天上下文回归空库');
      for (const id of [deviceId, foreignDeviceId])
        await AosDevice.create({
          id,
          name: '上下文合成服务器',
          credentialHash: createHash('sha256').update(id).digest('hex'),
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
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      });
      base = `http://127.0.0.1:${server.address().port}`;
    } catch (error) {
      throw new Error(`跨天上下文回归失败：${error.message}`);
    }
  });
  afterAll(async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      await AosDevice.destroy({ where: { id: [deviceId, foreignDeviceId] } });
      await sequelize.close();
    } catch (error) {
      throw new Error(`跨天上下文回归失败：${error.message}`);
    }
  });

  describe.each(['rows', 'blocks'])('%s存储', storageMode => {
    beforeEach(async () => {
      try {
        mode = storageMode;
        ordinal = 0;
        await sequelize.query(
          'TRUNCATE monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,' +
            'monitor_log_files,monitor_log_storage_scopes,monitor_log_storage_metrics,monitor_log_entries RESTART IDENTITY CASCADE'
        );
        await sequelize.query(
          'INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode,generation) VALUES(:deviceId,:localId,:mode,1)',
          { replacements: { deviceId, localId, mode } }
        );
      } catch (error) {
        throw new Error(`跨天上下文回归失败：${error.message}`);
      }
    });

    test.each(['account', 'instance'])(
      '三日%s初始居中及双向多页跨午夜，稳定排序无重复与终页',
      async scope => {
        const rows = [];
        for (const [date, count] of [
          [day(-3), 160],
          [anchorDay, 40],
          [day(-1), 160],
        ]) {
          const files = [randomUUID(), randomUUID()];
          for (let index = 0; index < count; index++) {
            const offset =
              (date === day(-3) || (date === anchorDay && index >= 20) ? 86399000 : 0) +
              Math.floor(index / 4);
            rows.push(row(date, offset, { fileId: files[index % 2] }));
          }
        }
        const anchor = sorted(rows.filter(item => item.businessDate === anchorDay))[20];
        anchor.message = '锚点命中\n';
        const payload = { ...anchor };
        for (const key of ['deviceId', 'sortAt', 'payloadHash']) delete payload[key];
        anchor.payloadHash = policy.digest(payload);
        const noise = [
          row(day(-3), 86399002, { accountNumber: '002' }),
          row(day(-1), 3, { loggedAt: null, accountNumber: null, parseState: 'unparsed' }),
          row(anchorDay, 6, { localId: otherLocalId }),
        ];
        await save([...rows, ...noise]);
        const filtered = await service.list({
          deviceId,
          localId,
          startAt: `${anchorDay}T00:00:00`,
          endAt: `${anchorDay}T23:59:59`,
          account: '001',
          keyword: '锚点命中',
        });
        expect(filtered.items.map(item => item.id)).toEqual([anchor.id]);
        const response = await fetch(
          `${base}/api/server-monitor/logs/${anchor.id}/context?scope=${scope}`
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const initial = (await response.json()).data;
        expect(initial.items).toHaveLength(201);
        expect(initial.items[100].id).toBe(anchor.id);
        expect(initial.hasMoreBefore).toBe(true);
        expect(initial.hasMoreAfter).toBe(true);
        expect([...new Set(initial.items.map(item => item.businessDate))].sort()).toEqual([
          day(-3),
          anchorDay,
          day(-1),
        ]);
        const all = await loadAll(anchor, scope, initial);
        const expected = sorted(
          [...rows, ...noise].filter(
            item =>
              item.localId === localId && (scope === 'instance' || item.accountNumber === '001')
          )
        );
        expect(all.items.map(item => item.id)).toEqual(expected.map(item => item.id));
        expect(new Set(all.items.map(item => item.id)).size).toBe(all.items.length);
        expect(all.beforePages).toBeGreaterThan(1);
        expect(all.afterPages).toBeGreaterThan(1);
        if (scope === 'instance')
          expect(all.items.find(item => item.id === noise[1].id).loggedAt).toBeNull();
        for (const [direction, cursor] of [
          ['before', all.items[0].id],
          ['after', all.items.at(-1).id],
        ]) {
          const end = await service.context(anchor.id, { scope, direction, cursor });
          expect(end.items).toEqual([]);
          expect(end.hasMore).toBe(false);
          expect(end.anchorId).toBe(anchor.id);
        }
      }
    );

    test('跨无日志日期衔接，外部实例、设备和账号游标拒绝', async () => {
      const before = row(day(-7));
      const anchor = row(day(-4));
      const after = row(day(-1));
      const otherAccount = row(day(-6), 0, { accountNumber: '002' });
      const unassigned = row(day(-5), 0, {
        loggedAt: null,
        accountNumber: null,
        parseState: 'unparsed',
      });
      const otherInstance = row(day(-5), 0, { localId: otherLocalId });
      const otherDevice = { ...row(day(-3)), deviceId: foreignDeviceId };
      await save([before, anchor, after, otherAccount, unassigned, otherInstance, otherDevice]);
      const result = await service.context(anchor.id, { scope: 'account', limit: 1 });
      expect(result.items.map(item => item.id)).toEqual([before.id, anchor.id, after.id]);
      expect(result.hasMoreBefore).toBe(false);
      expect(result.hasMoreAfter).toBe(false);
      for (const cursor of [
        otherAccount.id,
        unassigned.id,
        otherInstance.id,
        otherDevice.id,
        randomUUID(),
      ]) {
        await expect(
          service.context(anchor.id, { scope: 'account', cursor, direction: 'before' })
        ).rejects.toMatchObject({ statusCode: 400 });
      }
      for (const cursor of [otherInstance.id, otherDevice.id])
        await expect(
          service.context(anchor.id, {
            scope: 'instance',
            cursor,
            direction: 'after',
          })
        ).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.context(unassigned.id, { scope: 'account' })).rejects.toMatchObject({
        statusCode: 400,
      });
      // 同账号的跨日边界可续载，路径锚点保持原值。
      expect(
        (
          await service.context(anchor.id, {
            scope: 'account',
            cursor: before.id,
            direction: 'after',
            limit: 1,
          })
        ).items[0].id
      ).toBe(anchor.id);
      expect(
        (
          await service.context(anchor.id, {
            scope: 'account',
            cursor: after.id,
            direction: 'before',
            limit: 1,
          })
        ).items[0].id
      ).toBe(anchor.id);
    });

    test('当日凑齐lookahead即停止，仅以日期等值查询当前日候选', async () => {
      const anchor = row(anchorDay, 500);
      const sameDay = [100, 200, 300, 400, 600, 700, 800, 900].map(offset =>
        row(anchorDay, offset)
      );
      await save([row(day(-7)), ...sameDay, anchor, row(day(-1))]);
      const spy = jest.spyOn(sequelize, 'query');
      try {
        for (const direction of ['before', 'after']) {
          spy.mockClear();
          const result = await service.context(anchor.id, {
            scope: 'instance',
            cursor: anchor.id,
            direction,
            limit: 2,
          });
          const expected = sorted(
            sameDay.filter(item =>
              direction === 'before'
                ? store.compare(item, anchor) < 0
                : store.compare(item, anchor) > 0
            )
          );
          expect(result.items.map(item => item.id)).toEqual(
            (direction === 'before' ? expected.slice(-2) : expected.slice(0, 2)).map(
              item => item.id
            )
          );
          expect(result.hasMore).toBe(true);
          const selects = spy.mock.calls.filter(
            ([sql]) =>
              typeof sql === 'string' &&
              (mode === 'rows'
                ? sql.includes('FROM monitor_log_entries WHERE')
                : sql.includes('FROM monitor_log_blocks b '))
          );
          expect(selects).toHaveLength(1);
          expect(selects[0][1].replacements).toMatchObject({ date: anchorDay });
          expect(selects[0][1].replacements.startDate).toBeUndefined();
          expect(selects[0][1].replacements.endDate).toBeUndefined();
          expect(selects[0][0]).not.toContain('BETWEEN');
        }
      } finally {
        spy.mockRestore();
      }
    });

    test('边界日恰好limit仍跨空日寻找lookahead，双向续页不丢远日片段', async () => {
      const anchor = row(anchorDay, 500);
      const before = [row(anchorDay, 100), row(anchorDay, 200)];
      const after = [row(anchorDay, 600), row(anchorDay, 700)];
      const older = row(day(-4));
      const newer = row(today);
      await save([older, ...before, anchor, ...after, newer]);
      for (const [direction, expected, remote] of [
        ['before', before, older],
        ['after', after, newer],
      ]) {
        const first = await service.context(anchor.id, {
          scope: 'instance',
          cursor: anchor.id,
          direction,
          limit: 2,
        });
        expect(first.items.map(item => item.id)).toEqual(expected.map(item => item.id));
        expect(first.hasMore).toBe(true);
        const next = await service.context(anchor.id, {
          scope: 'instance',
          direction,
          limit: 2,
          cursor: direction === 'before' ? first.items[0].id : first.items.at(-1).id,
        });
        expect(next.items.map(item => item.id)).toEqual([remote.id]);
        expect(next.hasMore).toBe(false);
        expect(next.anchorId).toBe(anchor.id);
      }
    });

    test('前后恰好100片段且其余日期为空，终页不误报hasMore', async () => {
      const before = Array.from({ length: 100 }, (_, index) => row(day(-3), index));
      const anchor = row(anchorDay);
      const after = Array.from({ length: 100 }, (_, index) => row(day(-1), index));
      await save([...before, anchor, ...after]);
      const initial = await service.context(anchor.id, { scope: 'account' });
      expect(initial.items.map(item => item.id)).toEqual(
        [...before, anchor, ...after].map(item => item.id)
      );
      expect(initial.hasMoreBefore).toBe(false);
      expect(initial.hasMoreAfter).toBe(false);
      for (const [direction, expected] of [
        ['before', before],
        ['after', after],
      ]) {
        const page = await service.context(anchor.id, {
          scope: 'account',
          cursor: anchor.id,
          direction,
          limit: 100,
        });
        expect(page.items.map(item => item.id)).toEqual(expected.map(item => item.id));
        expect(page.items).toHaveLength(100);
        expect(page.hasMore).toBe(false);
        expect(page.anchorId).toBe(anchor.id);
      }
    });

    test('90日首尾包含、过期与未来锚点404，过期游标400且不越界', async () => {
      const first = policy.retention().first;
      const previous = new Date(Date.parse(first) - 86400000).toISOString().slice(0, 10);
      const expired = row(previous);
      const oldest = row(first);
      const anchor = row(anchorDay);
      const newest = row(today, 86399999);
      const future = row(day(1));
      await save([expired, oldest, anchor, newest, future]);
      const result = await service.context(anchor.id, { scope: 'account' });
      expect(result.items.map(item => item.id)).toEqual([oldest.id, anchor.id, newest.id]);
      expect(result.hasMoreBefore).toBe(false);
      expect(result.hasMoreAfter).toBe(false);
      for (const item of [expired, future]) {
        await expect(service.context(item.id, { scope: 'instance' })).rejects.toMatchObject({
          statusCode: 404,
        });
        await expect(
          service.context(anchor.id, { scope: 'account', cursor: item.id, direction: 'before' })
        ).rejects.toMatchObject({ statusCode: 400 });
      }
      const fromOldest = await service.context(oldest.id, { scope: 'account', limit: 1 });
      expect(fromOldest.hasMoreBefore).toBe(false);
      expect(fromOldest.items.map(item => item.id)).toEqual([oldest.id, anchor.id]);
      const fromNewest = await service.context(newest.id, { scope: 'account', limit: 1 });
      expect(fromNewest.hasMoreAfter).toBe(false);
      expect(fromNewest.items.map(item => item.id)).toEqual([anchor.id, newest.id]);
    });
  });
});
