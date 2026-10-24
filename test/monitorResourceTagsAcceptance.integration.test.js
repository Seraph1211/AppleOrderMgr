const { randomUUID, createHash } = require('crypto');
const enabled = process.env.MONITOR_TAG_TEST_DB_HOST === 'monitor-tags-test-postgres';

(enabled ? describe : describe.skip)('人工监控标签：独立 PostgreSQL 与真实 HTTP 验收', () => {
  const {
    sequelize,
    AosDevice,
    MonitorInstance,
    MonitorLogState,
    MonitorLogEntry,
    MonitorResourceTag,
  } = require('../src/models');
  const migration = require('../migrations/20261024000001-add-monitor-resource-tags');
  const { Sequelize } = require('sequelize');
  const service = require('../src/services/monitorResourceTagService');
  let server;
  let base;
  let device;
  let secondDevice;
  const localId = randomUUID();
  const historicalId = randomUUID();
  const credential = `aos_${'t'.repeat(43)}`;
  const collectorHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential}`,
  };
  const now = new Date();

  async function request(body, access = 'allowed', method = 'PUT', resourcePath = '/logs/tags') {
    try {
      const response = await fetch(`${base}/api/server-monitor${resourcePath}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Test-Access': access },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        cache: response.headers.get('cache-control'),
        body: await response.json(),
      };
    } catch (error) {
      throw new Error(`隔离 HTTP 验收失败：${error.message}`);
    }
  }

  beforeAll(async () => {
    if (
      sequelize.config.host !== 'monitor-tags-test-postgres' ||
      sequelize.config.database !== 'monitor_tags_test' ||
      process.env.DATABASE_URL
    ) {
      throw new Error('只允许可销毁标签专用数据库，禁止业务库');
    }
    await sequelize.query('TRUNCATE aos_devices CASCADE');
    device = await AosDevice.create({
      id: randomUUID(),
      name: 'US Server No.1',
      credentialHash: createHash('sha256').update(credential).digest('hex'),
    });
    secondDevice = await AosDevice.create({
      id: randomUUID(),
      name: 'US Server No.2',
      enabled: false,
      credentialHash: createHash('sha256').update('second-fixture').digest('hex'),
    });
    collectorHeaders['X-AOS-Device-Id'] = device.id;
    await MonitorInstance.bulkCreate([
      { id: randomUUID(), deviceId: device.id, localId, label: '心蓝01', active: false },
      {
        id: randomUUID(),
        deviceId: secondDevice.id,
        localId,
        label: '同标识另一实例',
        active: true,
      },
    ]);
    await MonitorLogState.create({
      id: randomUUID(),
      deviceId: device.id,
      localId: historicalId,
      label: '历史实例',
      observedAt: now,
      snapshot: {},
    });
    const express = require('express');
    const app = express();
    app.use('/api/aos-collector/v1', require('../src/routes/aosCollector'));
    app.use(express.json());
    app.use((req, _res, next) => {
      const access = req.get('X-Test-Access');
      if (access !== 'anonymous')
        req.user = {
          id: 1,
          username: 'synthetic-tags-test',
          sessionId: 'synthetic-tags-session',
          role: 'operator',
          permissions:
            access === 'allowed'
              ? ['monitor.manage', 'monitor.logs.read']
              : access === 'read-only'
                ? ['monitor.logs.read']
                : [],
        };
      next();
    });
    app.use('/api/server-monitor', require('../src/routes/serverMonitor'));
    app.use(require('../src/middleware/errorHandler'));
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    await MonitorResourceTag.destroy({ where: {} });
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });

  test('正式 migration down/up 保留原设备、实例和采集日志状态', async () => {
    const before = await AosDevice.findAll({ order: [['id', 'ASC']], raw: true });
    const instances = await MonitorInstance.findAll({ order: [['id', 'ASC']], raw: true });
    const states = await MonitorLogState.findAll({ raw: true });
    await migration.down(sequelize.getQueryInterface());
    expect(await sequelize.getQueryInterface().showAllTables()).not.toContain(
      'monitor_resource_tags'
    );
    await migration.up(sequelize.getQueryInterface(), Sequelize);
    expect(await AosDevice.findAll({ order: [['id', 'ASC']], raw: true })).toEqual(before);
    expect(await MonitorInstance.findAll({ order: [['id', 'ASC']], raw: true })).toEqual(instances);
    expect(await MonitorLogState.findAll({ raw: true })).toEqual(states);
    expect(await MonitorResourceTag.count()).toBe(0);
  });

  test('匿名401、无权限403；读写均 no-store 且无凭据', async () => {
    const body = { deviceId: device.id, tag: '禁止保存', expectedVersion: 0 };
    expect((await request(body, 'anonymous')).status).toBe(401);
    expect((await request(body, 'denied')).status).toBe(403);
    expect((await request(undefined, 'anonymous', 'GET', '/logs/states')).status).toBe(401);
    expect((await request(undefined, 'denied', 'GET', '/logs/states')).status).toBe(403);
    const result = await request({ ...body, tag: '主力' });
    expect(result.status).toBe(200);
    expect(result.cache).toBe('no-store');
    const catalog = await request(undefined, 'allowed', 'GET', '/logs/states');
    expect(catalog.cache).toBe('no-store');
    expect(JSON.stringify(catalog.body)).not.toMatch(/credentialHash|credentialCiphertext/);
    expect(JSON.stringify(catalog.body)).not.toContain(credential);
  });

  test('新增修改清空后独立读取，原名和版本保留', async () => {
    const original = await AosDevice.findByPk(device.id);
    const result = await request({ deviceId: device.id, tag: ' 美国主力 ', expectedVersion: 0 });
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      deviceId: device.id,
      localId: null,
      tag: '美国主力',
      tagVersion: 1,
    });
    expect(
      (await MonitorResourceTag.findOne({ where: { deviceId: device.id, localId: null } })).tag
    ).toBe('美国主力');
    const catalog = await service.states();
    expect(catalog.devices.find(row => row.id === device.id)).toMatchObject({
      name: 'US Server No.1',
      tag: '美国主力',
      tagVersion: 1,
    });
    expect(
      (await request({ deviceId: device.id, tag: '更新', expectedVersion: 1 })).body.data.tagVersion
    ).toBe(2);
    expect(
      (await request({ deviceId: device.id, tag: '', expectedVersion: 2 })).body.data
    ).toMatchObject({ tag: '', tagVersion: 3 });
    expect((await AosDevice.findByPk(device.id)).toJSON()).toEqual(original.toJSON());
  });

  test('实例以服务器与localId联合绑定，历史实例及停用服务器可配置', async () => {
    expect(
      (await request({ deviceId: device.id, localId, tag: '北京', expectedVersion: 0 })).status
    ).toBe(200);
    expect(
      (await request({ deviceId: secondDevice.id, localId, tag: '上海', expectedVersion: 0 }))
        .status
    ).toBe(200);
    expect(
      (
        await request({
          deviceId: device.id,
          localId: historicalId,
          tag: '历史',
          expectedVersion: 0,
        })
      ).status
    ).toBe(200);
    const catalog = await service.states();
    expect(
      catalog.instances.find(row => row.deviceId === device.id && row.localId === localId)
    ).toMatchObject({ tag: '北京', active: false, label: '心蓝01' });
    expect(
      catalog.instances.find(row => row.deviceId === secondDevice.id && row.localId === localId)
    ).toMatchObject({ tag: '上海' });
    expect(catalog.instances.find(row => row.localId === historicalId)).toMatchObject({
      tag: '历史',
    });
  });

  test('输入边界非法类型未知字段拒绝，100字纯文本与Unicode可保存', async () => {
    const valid = { deviceId: device.id, tag: '标签', expectedVersion: 0 };
    for (const changes of [
      { tag: '长'.repeat(101) },
      { tag: null },
      { tag: 12 },
      { tag: ['标签'] },
      { tag: '多\n行' },
      { tag: '多\t行' },
      { tag: '\u0000' },
      { tag: '\u2028' },
      { expectedVersion: -1 },
      { expectedVersion: '0' },
      { expectedVersion: 0.5 },
      { deviceId: 'not-uuid' },
      { localId: '' },
      { enabled: false },
    ])
      expect((await request({ ...valid, ...changes })).status).toBe(400);
    expect(await MonitorResourceTag.count()).toBe(0);
    expect((await request({ ...valid, tag: '长'.repeat(100) })).status).toBe(200);
    const unicode = '<script>window.injected=true</script> 北京😀';
    expect((await request({ ...valid, tag: unicode, expectedVersion: 1 })).body.data.tag).toBe(
      unicode
    );
  });

  test('未知服务器和跨服务器实例返回404，不创建孤立标签', async () => {
    expect(
      (await request({ deviceId: randomUUID(), tag: '不存在', expectedVersion: 0 })).status
    ).toBe(404);
    expect(
      (
        await request({
          deviceId: secondDevice.id,
          localId: historicalId,
          tag: '不匹配',
          expectedVersion: 0,
        })
      ).status
    ).toBe(404);
    expect(await MonitorResourceTag.count()).toBe(0);
  });

  test('并发首次创建和更新只接受一次，旧版本409且不覆盖', async () => {
    const body = { deviceId: device.id, tag: '并发一', expectedVersion: 0 };
    const responses = await Promise.all([request(body), request({ ...body, tag: '并发二' })]);
    expect(responses.map(row => row.status).sort()).toEqual([200, 409]);
    expect(await MonitorResourceTag.count()).toBe(1);
    const winner = responses.find(row => row.status === 200).body.data;
    expect((await request({ ...body, tag: '过期覆盖' })).status).toBe(409);
    expect((await service.states()).devices.find(row => row.id === device.id)).toMatchObject({
      tag: winner.tag,
      tagVersion: 1,
    });
    const updates = await Promise.all([
      request({ ...body, tag: '更新一', expectedVersion: 1 }),
      request({ ...body, tag: '更新二', expectedVersion: 1 }),
    ]);
    expect(updates.map(row => row.status).sort()).toEqual([200, 409]);
  });

  test('采集器新状态上报更新实例原名但不覆盖人工标签，也无法注入人工标签', async () => {
    await request({ deviceId: device.id, localId, tag: '人工保护', expectedVersion: 0 });
    const report = {
      observedAt: new Date().toISOString(),
      instances: [
        {
          localId,
          label: '采集器新名称',
          state: 'ready',
          dates: [],
          fileCount: 0,
          totalBytes: 0,
          scannedBytes: 0,
          pending: 0,
          issues: 0,
          expired: 0,
        },
      ],
    };
    const response = await fetch(`${base}/api/aos-collector/v1/logs/states`, {
      method: 'POST',
      headers: collectorHeaders,
      body: JSON.stringify(report),
    });
    expect(response.status).toBe(200);
    const catalog = await service.states();
    expect(
      catalog.instances.find(row => row.deviceId === device.id && row.localId === localId)
    ).toMatchObject({ label: '采集器新名称', tag: '人工保护', tagVersion: 1 });
    const invalid = await fetch(`${base}/api/aos-collector/v1/logs/states`, {
      method: 'POST',
      headers: collectorHeaders,
      body: JSON.stringify({ ...report, instances: [{ ...report.instances[0], tag: '恶意覆盖' }] }),
    });
    expect(invalid.status).toBe(400);
    expect(
      (await MonitorResourceTag.findOne({ where: { deviceId: device.id, localId } })).tag
    ).toBe('人工保护');
  });

  (process.env.MONITOR_TAG_PRODUCTION_COMPOSITION === 'true' ? test : test.skip)(
    '生产组合只读日志用户能读取标签，但PUT403且无数据库变更',
    async () => {
      await request({ deviceId: device.id, tag: '只读可见', expectedVersion: 0 });
      const before = await MonitorResourceTag.findAll({ raw: true });
      const catalog = await request(undefined, 'read-only', 'GET', '/logs/states');
      expect(catalog.status).toBe(200);
      expect(catalog.body.data.devices.find(row => row.id === device.id)).toMatchObject({
        tag: '只读可见',
        tagVersion: 1,
      });
      expect(
        (await request({ deviceId: device.id, tag: '拒绝覆盖', expectedVersion: 1 }, 'read-only'))
          .status
      ).toBe(403);
      expect(await MonitorResourceTag.findAll({ raw: true })).toEqual(before);
    }
  );

  (process.env.MONITOR_TAG_PRODUCTION_COMPOSITION === 'true' ? test : test.skip)(
    '生产组合保留跨日筛选、元信息及全范围原文导出和短期票据',
    async () => {
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
      const fileId = randomUUID();
      const scope = {
        deviceId: device.id,
        localId,
        startAt: `${yesterday}T23:59:58`,
        endAt: `${today}T00:00:02`,
      };
      await sequelize.query(
        "INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:deviceId,:localId,'rows') ON CONFLICT(device_id,local_id) DO UPDATE SET mode='rows'",
        { replacements: scope }
      );
      await MonitorLogEntry.bulkCreate([
        {
          id: randomUUID(),
          deviceId: device.id,
          localId,
          fileId,
          fileName: 'LogYesterday_123.txt',
          businessDate: yesterday,
          loggedAt: new Date(`${yesterday}T23:59:59+08:00`),
          sortAt: new Date(`${yesterday}T23:59:59+08:00`),
          accountNumber: '001',
          lineNumber: '123',
          partIndex: 0,
          byteOffset: 0,
          message: '保留一\n',
          parseState: 'parsed',
          payloadHash: '1'.repeat(64),
        },
        {
          id: randomUUID(),
          deviceId: device.id,
          localId,
          fileId,
          fileName: 'LogToday_123.txt',
          businessDate: today,
          loggedAt: new Date(`${today}T00:00:01+08:00`),
          sortAt: new Date(`${today}T00:00:01+08:00`),
          accountNumber: '002',
          lineNumber: '124',
          partIndex: 0,
          byteOffset: 100,
          message: '另一账号二\n',
          parseState: 'parsed',
          payloadHash: '2'.repeat(64),
        },
      ]);
      const query = new URLSearchParams({ ...scope, account: '001', keyword: '保留' });
      const list = await request(undefined, 'read-only', 'GET', `/logs?${query}`);
      expect(list.status).toBe(200);
      expect(list.body.data.items).toHaveLength(1);
      expect(list.body.data.items[0]).toMatchObject({
        fileId,
        fileName: 'LogYesterday_123.txt',
        lineNumber: '123',
        accountNumber: '001',
        message: '保留一\n',
      });
      const ticket = await fetch(`${base}/api/server-monitor/logs/export-ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Test-Access': 'read-only' },
        body: JSON.stringify(scope),
      });
      expect(ticket.status).toBe(200);
      expect(ticket.headers.get('set-cookie')).toMatch(/aos_monitor_log_export=.*HttpOnly/);
      const response = await fetch(
        `${base}/api/server-monitor/logs/export?${new URLSearchParams(scope)}`,
        { headers: { 'X-Test-Access': 'read-only' } }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(response.headers.get('content-disposition')).toContain('attachment');
      expect(await response.text()).toBe('保留一\n另一账号二\n');
    }
  );
});
