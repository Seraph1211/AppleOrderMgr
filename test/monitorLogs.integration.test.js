const enabled = process.env.RUN_FULL_LOG_DB === 'true';
const { randomUUID, createHash } = require('crypto');
(enabled ? describe : describe.skip)('完整日志隔离数据库与真实HTTP', () => {
  const {
    sequelize,
    AosDevice,
    MonitorLogEntry,
    MonitorLogState,
    MonitorAlert,
  } = require('../src/models');
  const service = require('../src/services/monitorLogService');
  const policy = require('../src/services/monitorLogPolicy');
  const migration = require('../migrations/20260929000001-add-monitor-full-logs');
  let server;
  let base;
  let device;
  let second;
  const token = 'aos_' + 'l'.repeat(43);
  const localId = randomUUID();
  const anotherId = randomUUID();
  const fileId = randomUUID();
  const today = policy.retention().today;
  const at = new Date(`${today}T00:00:00+08:00`).toISOString();
  const entry = (offset = 0, changes = {}) => ({
    id: randomUUID(),
    localId,
    fileId,
    fileName: `Log${today.replace(/-/g, '')}_123.txt`,
    businessDate: today,
    loggedAt: at,
    accountNumber: '128',
    lineNumber: offset + 1,
    partIndex: 0,
    byteOffset: offset,
    message: `日志${offset}\n`,
    rawBase64: null,
    parseState: 'parsed',
    ...changes,
  });
  const params = extra => ({ deviceId: device.id, localId, date: today, ...extra });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const website = { 'x-monitor-permission': 'yes' };
  async function post(path, body, customHeaders = headers) {
    try {
      return await fetch(base + path, {
        method: 'POST',
        headers: customHeaders,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`合成HTTP调用失败：${error.name}`);
    }
  }
  beforeAll(async () => {
    if (!/^aos_log_test_/.test(sequelize.config.database) || process.env.DATABASE_URL)
      throw new Error('必须使用完整日志专用空测试库');
    await sequelize.query('TRUNCATE monitor_log_entries, monitor_log_states, aos_devices CASCADE');
    device = await AosDevice.create({
      id: randomUUID(),
      name: '日志合成服务器',
      credentialHash: createHash('sha256').update(token).digest('hex'),
    });
    headers['x-aos-device-id'] = device.id;
    second = await AosDevice.create({
      id: randomUUID(),
      name: '另一服务器',
      credentialHash: createHash('sha256').update('other').digest('hex'),
    });
    const express = require('express');
    const app = express();
    app.use('/api/aos-collector/v1', require('../src/routes/aosCollector'));
    app.use((req, _res, next) => {
      req.user = {
        id: 1,
        role: 'operator',
        permissions: req.get('x-monitor-permission') === 'yes' ? ['monitor.manage'] : [],
      };
      next();
    });
    app.use('/api/server-monitor', require('../src/routes/serverMonitor'));
    app.use(require('../src/middleware/errorHandler'));
    server = await new Promise(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      await sequelize.close();
    } catch (error) {
      throw new Error(error.name);
    }
  });
  beforeEach(async () => {
    try {
      await MonitorLogEntry.destroy({ where: {} });
      await MonitorLogState.destroy({ where: {} });
    } catch (error) {
      throw new Error(error.name);
    }
  });
  test('独立用户权限、设备认证、no-store及设备停用', async () => {
    expect((await fetch(base + '/api/server-monitor/logs/states')).status).toBe(403);
    const allowed = await fetch(base + '/api/server-monitor/logs/states', { headers: website });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    expect(await allowed.text()).not.toContain(token);
    expect((await fetch(base + '/api/aos-collector/v1/logs/context')).status).toBe(401);
    expect((await fetch(base + '/api/aos-collector/v1/logs/context', { headers })).status).toBe(
      200
    );
    expect((await post('/api/aos-collector/v1/logs/entries', { entries: [entry()] }, { ...headers, 'x-aos-device-id': second.id })).status).toBe(403);
    await device.update({ enabled: false });
    expect((await post('/api/aos-collector/v1/logs/entries', { entries: [entry()] })).status).toBe(
      403
    );
    await device.update({ enabled: true });
  });
  test('批量HTTP可靠回执、重传幂等、真实重复行保留、载荷冲突整体回滚', async () => {
    const items = [entry(0, { message: '真实相同行\n' }), entry(30, { message: '真实相同行\n' })];
    for (let i = 0; i < 2; i++) {
      const response = await post('/api/aos-collector/v1/logs/entries', { entries: items });
      expect(response.status).toBe(200);
      expect((await response.json()).data.accepted).toEqual(items.map(item => item.id));
    }
    expect(await MonitorLogEntry.count()).toBe(2);
    const response = await post('/api/aos-collector/v1/logs/entries', {
      entries: [entry(90), { ...items[0], message: '冲突' }],
    });
    expect(response.status).toBe(409);
    expect(await MonitorLogEntry.count()).toBe(2);
    expect((await post('/api/aos-collector/v1/logs/entries', { entries: [entry(0)] })).status).toBe(
      409
    );
    await expect(service.receive(second.id, { entries: [items[0]] })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  test('并发同批次仅一次保存，伪造设备字段及超大请求拒绝', async () => {
    const items = [entry()];
    await Promise.all([
      service.receive(device.id, { entries: items }),
      service.receive(device.id, { entries: items }),
    ]);
    expect(await MonitorLogEntry.count()).toBe(1);
    expect(
      (
        await post('/api/aos-collector/v1/logs/entries', {
          entries: [entry(3)],
          deviceId: second.id,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await post('/api/aos-collector/v1/logs/entries', {
          entries: [entry(4, { message: 'x'.repeat(1100000) })],
        })
      ).status
    ).toBe(413);
  });
  test('同号账号跨实例／设备隔离，时间、字面关键词、无账号筛选', async () => {
    await service.receive(device.id, {
      entries: [
        entry(0, { message: '100%_正常\n' }),
        entry(10, { localId: anotherId }),
        entry(20, { accountNumber: null, parseState: 'unparsed', loggedAt: null }),
        entry(30, { accountNumber: '129' }),
      ],
    });
    await service.receive(second.id, { entries: [entry(40)] });
    const list = await service.list(params({ account: '128' }));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty('payloadHash');
    expect((await service.list(params({ keyword: '%_' }))).items).toHaveLength(1);
    expect((await service.list(params({ account: '__unassigned__' }))).items).toHaveLength(1);
    expect(
      (await service.list(params({ fromTime: '00:00:00', toTime: '00:00:00' }))).items
    ).toHaveLength(2);
    expect((await service.list(params({ fromTime: '00:00:01' }))).items).toHaveLength(0);
    const response = await fetch(
      base + '/api/server-monitor/logs?' + new URLSearchParams(params({ account: '128' })),
      { headers: website }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  test('同毫秒150行稳定游标，改变筛选拒绝旧游标', async () => {
    await service.receive(device.id, { entries: Array.from({ length: 150 }, (_, i) => entry(i)) });
    const a = await service.list(params());
    const b = await service.list(params({ cursor: a.nextCursor }));
    const c = await service.list(params({ cursor: b.nextCursor }));
    const items = [...a.items, ...b.items, ...c.items];
    expect(items).toHaveLength(150);
    expect(new Set(items.map(item => item.id)).size).toBe(150);
    expect(c.nextCursor).toBeNull();
    expect(items.map(item => Number(item.byteOffset))).toEqual(
      Array.from({ length: 150 }, (_, i) => i)
    );
    await expect(
      service.list(params({ account: '129', cursor: a.nextCursor }))
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.list(params({ cursor: 'invalid' }))).rejects.toMatchObject({
      statusCode: 400,
    });
  });
  test('无时间行在原文件上下文中排序，仍保持无时间和无账号', async () => {
    const first = entry(0, { loggedAt: new Date(Date.parse(at) + 1000).toISOString() });
    const middle = entry(10, {
      loggedAt: null,
      accountNumber: null,
      parseState: 'unparsed',
      contextAt: first.loggedAt,
    });
    const last = entry(20, { loggedAt: new Date(Date.parse(at) + 2000).toISOString() });
    await service.receive(device.id, { entries: [first, middle, last] });
    const result = await service.context(first.id, { scope: 'instance' });
    expect(result.items.map(row => row.id)).toEqual([first.id, middle.id, last.id]);
    expect(result.items[1].loggedAt).toBeNull();
    expect(result.items[1].accountNumber).toBeNull();
  });
  test('账号候选分页及输入搜索', async () => {
    await service.receive(device.id, {
      entries: Array.from({ length: 105 }, (_, i) => entry(i, { accountNumber: String(1000 + i) })),
    });
    const first = await service.accounts(params());
    const last = await service.accounts(params({ after: first.nextCursor }));
    expect(first.items).toHaveLength(100);
    expect(last.items).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
    expect((await service.accounts(params({ search: '100' }))).items).toHaveLength(11);
  });
  test('账号／实例上下文不混入其他实例，无账号保留原文', async () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      entry(i, { accountNumber: i % 2 ? '128' : '129' })
    );
    await service.receive(device.id, { entries: [...items, entry(60, { localId: anotherId })] });
    const account = await service.context(items[25].id, { scope: 'account' });
    expect(account.items.every(item => item.accountNumber === '128')).toBe(true);
    const instance = await service.context(items[25].id, { scope: 'instance' });
    expect(instance.items).toHaveLength(41);
    expect(instance.items.every(item => item.localId === localId)).toBe(true);
    const response = await fetch(
      base + `/api/server-monitor/logs/${items[25].id}/context?scope=instance`,
      { headers: website }
    );
    expect(response.status).toBe(200);
    await expect(service.context(randomUUID(), { scope: 'account' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
  test('新鲜进度覆盖，迟到报告不能倒退，缺失日期不伪装完整', async () => {
    const observedAt = new Date(Date.now() - 1000).toISOString();
    const item = {
      localId,
      label: '实例一',
      state: 'catching_up',
      dates: [today],
      fileCount: 1,
      totalBytes: 200,
      scannedBytes: 100,
      pending: 3,
      issues: 0,
      expired: 0,
    };
    expect(
      (await post('/api/aos-collector/v1/logs/states', { observedAt, instances: [item] })).status
    ).toBe(200);
    await service.receiveStates(device.id, {
      observedAt: new Date(Date.parse(observedAt) - 1000).toISOString(),
      instances: [{ ...item, scannedBytes: 0 }],
    });
    expect(
      (await service.states()).instances.find(row => row.localId === localId).snapshot.scannedBytes
    ).toBe(100);
    await expect(
      service.receiveStates(device.id, { observedAt, instances: [{ ...item, scannedBytes: 201 }] })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  test('过期回执、30天清理与90天告警独立，未来日志拒绝', async () => {
    const old = entry(0, { businessDate: '2020-01-01', loggedAt: '2019-12-31T16:00:00.000Z' });
    expect((await service.receive(device.id, { entries: [old] })).expired).toEqual([old.id]);
    const fresh = entry(1);
    await service.receive(device.id, { entries: [fresh] });
    await MonitorLogEntry.update({ businessDate: '2020-01-01' }, { where: { id: fresh.id } });
    const alerts = await MonitorAlert.count();
    await service.cleanup();
    expect(await MonitorLogEntry.count()).toBe(0);
    expect(await MonitorAlert.count()).toBe(alerts);
    await expect(
      service.receive(device.id, {
        entries: [entry(3, { businessDate: '2099-01-01', loggedAt: '2098-12-31T16:00:00.000Z' })],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  test('gzip上传协议保留完整原文', async () => {
    const item = entry(7, { message: '完整原文'.repeat(1000) + '\n' });
    const response = await fetch(base + '/api/aos-collector/v1/logs/entries', {
      method: 'POST',
      headers: { ...headers, 'content-encoding': 'gzip' },
      body: require('zlib').gzipSync(JSON.stringify({ entries: [item] })),
    });
    expect(response.status).toBe(200);
    expect((await service.list(params())).items[0].message).toBe(item.message);
  });
  test('十万行合成日志索引查询与关键词性能', async () => {
    await sequelize.query(
      `INSERT INTO monitor_log_entries (id,device_id,local_id,file_id,file_name,business_date,logged_at,sort_at,account_number,line_number,part_index,byte_offset,message,parse_state,payload_hash)
      SELECT gen_random_uuid(), :device::uuid, :local::uuid, :file::uuid, 'Log20260929_scale.txt', :day::date, :at::timestamptz, :at::timestamptz, (128 + n % 5)::text, n+1, 0, n, '合成性能日志：继续监控店铺 ' || n, 'parsed', repeat('a',64) FROM generate_series(0,99999) n`,
      { replacements: { device: device.id, local: localId, file: fileId, day: today, at } }
    );
    await sequelize.query('ANALYZE monitor_log_entries');
    const start = Date.now();
    const result = await service.list(params({ account: '128' }));
    const accountMs = Date.now() - start;
    const searchStart = Date.now();
    const found = await service.list(params({ keyword: '99999' }));
    const keywordMs = Date.now() - searchStart;
    expect(result.items).toHaveLength(50);
    expect(found.items).toHaveLength(1);
    expect(accountMs).toBeLessThan(5000);
    expect(keywordMs).toBeLessThan(5000);
    require('../src/utils/logger').info('完整日志十万行合成查询验证', { accountMs, keywordMs });
  }, 30000);
  test('正式迁移down/up可回退且不改变设备', async () => {
    const count = await AosDevice.count();
    await migration.down(sequelize.getQueryInterface());
    await migration.up(sequelize.getQueryInterface(), require('sequelize'));
    expect(await MonitorLogEntry.count()).toBe(0);
    expect(await AosDevice.count()).toBe(count);
  });
});
