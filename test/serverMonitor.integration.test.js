const enabled = process.env.RUN_MONITOR_DB === 'true';
const crypto = require('crypto');
(enabled ? describe : describe.skip)('服务器监控独立数据库与HTTP协议', () => {
  const {
    sequelize,
    User,
    AosDevice,
    MonitorRule,
    MonitorInstance,
    MonitorTraffic,
    MonitorAlert,
    MonitorAction,
    MonitorNotificationSetting,
    MonitorNotificationDelivery,
    MonitorNotificationEvent,
  } = require('../src/models');
  const service = require('../src/services/monitorService');
  const notifications = require('../src/services/monitorNotificationService');
  let actor;
  let device;
  let rule;
  let instance;
  let revision;
  let server;
  let base;
  const localId = crypto.randomUUID();
  const token = 'aos_' + 'm'.repeat(43);
  let clock = new Date(Date.now() - 20 * 60000);
  const config = {
    name: '代理不可用',
    enabled: true,
    mode: 'any',
    keywords: ['没有可用的代理'],
    excludes: ['购买异常'],
    windowMinutes: 10,
    threshold: 5,
    severity: 'warning',
    deviceIds: [],
    directoryIds: [],
  };
  function report(count, state = 'ready', overrides = {}) {
    const start = clock;
    clock = new Date(+clock + 60000);
    return {
      id: crypto.randomUUID(),
      revision,
      startedAt: start.toISOString(),
      endedAt: clock.toISOString(),
      traffic: {
        receivedBytes: 1000,
        sentBytes: 500,
        collectorReceivedBytes: 10,
        collectorSentBytes: 5,
        quality: 'complete',
      },
      instances: [
        {
          localId,
          label: '实例一',
          state,
          files: ['Log20260915_1234.txt'],
          results: [
            {
              ruleId: rule.id,
              count,
              samples: count
                ? [
                    {
                      at: clock.toISOString(),
                      file: 'Log20260915_1234.txt',
                      keywords: ['没有可用的代理'],
                      lineNumber: 42,
                      message: '2026-09-15 00:00:00.000 没有可用的代理 user:secret@example.com',
                      truncated: false,
                    },
                  ]
                : [],
            },
          ],
        },
      ],
      ...overrides,
    };
  }
  beforeAll(async () => {
    if (!/^aos_monitor_test_/.test(sequelize.config.database))
      throw new Error('仅可使用监控独立测试数据库');
    await sequelize.query(
      'TRUNCATE monitor_notification_events, monitor_notification_deliveries, monitor_actions, monitor_alerts, monitor_traffic, monitor_instances, monitor_rules, aos_devices, users CASCADE'
    );
    await MonitorNotificationSetting.update(
      { enabled: false, recipients: [], sendRecovery: true, version: 1, updatedBy: null },
      { where: { id: 1 } }
    );
    actor = await User.create({
      username: 'monitor_test',
      password: 'synthetic-password',
      role: 'admin',
    });
    device = await AosDevice.create({
      id: crypto.randomUUID(),
      name: '监控合成设备',
      credentialHash: crypto.createHash('sha256').update(token).digest('hex'),
    });
    rule = await service.saveRule(actor.id, null, { config });
    revision = (await service.context(device.id)).revision;
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/aos-collector/v1', require('../src/routes/aosCollector'));
    app.use((req, _res, next) => {
      req.user = {
        id: actor.id,
        role: 'operator',
        permissions: req.get('x-monitor-permission') === 'yes' ? ['monitor.manage'] : [],
      };
      next();
    });
    app.use('/api/server-monitor', require('../src/routes/serverMonitor'));
    app.use(require('../src/middleware/errorHandler'));
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  test('普通用户单独授权可访问，未授权拒绝，设备凭据不泄漏', async () => {
    const denied = await fetch(base + '/api/server-monitor/overview');
    expect(denied.status).toBe(403);
    const allowed = await fetch(base + '/api/server-monitor/overview', {
      headers: { 'x-monitor-permission': 'yes' },
    });
    expect(allowed.status).toBe(200);
    const body = await allowed.text();
    expect(body).not.toContain('credential');
    expect(body).not.toContain(token);
    expect((await fetch(base + '/api/aos-collector/v1/monitor/context')).status).toBe(401);
    expect(
      (
        await fetch(base + '/api/aos-collector/v1/monitor/context', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status
    ).toBe(200);
  });
  test('首次触发、重传幂等、同ID换载荷冲突、重叠区间拒绝', async () => {
    const r = report(5);
    await service.receive(device.id, { reports: [r] }, clock);
    instance = await MonitorInstance.findOne({ where: { deviceId: device.id, localId } });
    expect(await MonitorAlert.count()).toBe(1);
    expect((await MonitorAlert.findOne()).samples[0]).toMatchObject({
      lineNumber: 42,
      message: expect.stringContaining('user:secret@example.com'),
      truncated: false,
    });
    await service.receive(device.id, { reports: [r] }, clock);
    expect(await MonitorTraffic.count()).toBe(1);
    await expect(
      service.receive(
        device.id,
        { reports: [{ ...r, traffic: { ...r.traffic, receivedBytes: 99 } }] },
        clock
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      service.receive(device.id, { reports: [{ ...r, id: crypto.randomUUID() }] }, clock)
    ).rejects.toMatchObject({ code: 'MONITOR_INTERVAL_OVERLAP' });
  });
  test('警告按服务器合并十分钟，严重告警立即独立入队，设置不泄漏凭据', async () => {
    const smtp = require('../src/utils/config').config.smtp;
    Object.assign(smtp, {
      host: 'smtp.example.test',
      user: 'sender@example.test',
      password: 'synthetic-password',
      from: 'sender@example.test',
    });
    const saved = await notifications.saveSettings(actor.id, {
      enabled: true,
      recipients: ['ops@example.test'],
      sendRecovery: true,
      expectedVersion: 1,
    });
    expect(JSON.stringify(saved)).not.toContain('synthetic-password');
    const at = new Date();
    await sequelize.transaction(async transaction => {
      for (const alertId of [crypto.randomUUID(), crypto.randomUUID()])
        await notifications.enqueueAlert(
          {
            alertId,
            instanceId: instance.id,
            deviceId: device.id,
            instanceLabel: '实例一',
            ruleName: '合成警告',
            severity: 'warning',
            hitCount: 5,
            at: at.toISOString(),
          },
          transaction
        );
      await notifications.enqueueAlert(
        {
          alertId: crypto.randomUUID(),
          instanceId: instance.id,
          deviceId: device.id,
          instanceLabel: '实例一',
          ruleName: '合成严重告警',
          severity: 'critical',
          hitCount: 1,
          at: at.toISOString(),
        },
        transaction
      );
    });
    const deliveries = await MonitorNotificationDelivery.findAll({ order: [['notBefore', 'ASC']] });
    expect(deliveries).toHaveLength(2);
    expect(await MonitorNotificationEvent.count({ where: { deliveryId: deliveries[1].id } })).toBe(
      2
    );
    expect(+deliveries[1].notBefore - +at).toBe(10 * 60000);
    expect(+deliveries[0].notBefore).toBe(+at);
  });
  test('到期邮件由 Worker 异步发送且正文不复制原始日志', async () => {
    const sender = require('../src/services/monitorNotificationSender');
    await MonitorNotificationDelivery.destroy({ where: {} });
    const alert = await MonitorAlert.findOne({ where: { status: 'active' } });
    const at = new Date(Date.now() - 11 * 60000);
    await sequelize.transaction(async transaction => {
      await notifications.enqueueAlert(
        {
          alertId: alert.id,
          instanceId: instance.id,
          deviceId: device.id,
          instanceLabel: '实例一',
          ruleName: alert.ruleName,
          severity: 'warning',
          hitCount: alert.hitCount,
          at: at.toISOString(),
        },
        transaction
      );
    });
    let sent;
    sender._setTransporter({
      sendMail: async message => {
        sent = message;
      },
      close: () => {},
    });
    expect(await sender.processOne(new Date())).toBe(true);
    expect(sent.to).toEqual(['ops@example.test']);
    expect(sent.text).toContain('代理不可用');
    expect(sent.text).not.toContain('user:secret@example.com');
    expect((await MonitorNotificationDelivery.findOne()).status).toBe('sent');
    await sender.stop();
  });
  test('处理中整实例静默、并发冲突、延长、备注及人工完成独立于检测状态', async () => {
    let result = await service.act(
      actor.id,
      instance.id,
      { expectedVersion: 1, action: 'start', note: '检查代理' },
      clock
    );
    expect(+new Date(result.handling.until) - clock).toBe(30 * 60000);
    await expect(
      service.act(actor.id, instance.id, { expectedVersion: 1, action: 'ignore' }, clock)
    ).rejects.toMatchObject({ statusCode: 409 });
    result = await service.act(
      actor.id,
      instance.id,
      { expectedVersion: 2, action: 'extend', minutes: 15 },
      clock
    );
    expect(+new Date(result.handling.until) - clock).toBe(45 * 60000);
    await service.act(
      actor.id,
      instance.id,
      { expectedVersion: 3, action: 'note', note: '处理记录' },
      clock
    );
    await service.act(actor.id, instance.id, { expectedVersion: 4, action: 'complete' }, clock);
    expect((await MonitorAlert.findOne()).status).toBe('active');
    expect(await MonitorAction.count({ where: { instanceId: instance.id } })).toBe(4);
  });
  test('失效扫描及过期报告不能恢复，连续两次有效低于阈值才恢复', async () => {
    await service.receive(device.id, { reports: [report(0, 'invalid')] }, clock);
    expect((await MonitorAlert.findOne()).quietChecks).toBe(0);
    const stale = report(0);
    await service.receive(device.id, { reports: [stale] }, new Date(+clock + 121000));
    expect((await MonitorAlert.findOne()).status).toBe('active');
    await service.receive(device.id, { reports: [report(0)] }, clock);
    expect((await MonitorAlert.findOne()).quietChecks).toBe(1);
    await service.receive(device.id, { reports: [report(0)] }, clock);
    expect((await MonitorAlert.findOne()).status).toBe('recovered');
  });
  test('规则修改旧结果不能触发，版本冲突返回409', async () => {
    const updated = await service.saveRule(actor.id, rule.id, {
      expectedVersion: rule.version,
      config: { ...config, threshold: 8 },
    });
    await expect(
      service.saveRule(actor.id, rule.id, { expectedVersion: 1, config })
    ).rejects.toMatchObject({ statusCode: 409 });
    await service.receive(device.id, { reports: [report(99)] }, clock);
    expect(await MonitorAlert.count({ where: { status: 'active' } })).toBe(0);
    expect((await MonitorInstance.findByPk(instance.id)).snapshot.state).toBe('rules_pending');
    revision = (await service.context(device.id)).revision;
    rule = updated;
    await service.receive(device.id, { reports: [report(9)] }, clock);
    expect(await MonitorAlert.count({ where: { status: 'active' } })).toBe(1);
  });
  test('省略规则结果不能恢复；多实例独立；配置移除可见', async () => {
    const missing = report(0);
    missing.instances[0].results = [];
    await service.receive(device.id, { reports: [missing] }, clock);
    expect((await MonitorInstance.findByPk(instance.id)).snapshot.state).toBe('invalid');
    const multi = report(9);
    multi.instances.push({
      ...multi.instances[0],
      localId: crypto.randomUUID(),
      label: '实例二',
      results: [{ ruleId: rule.id, count: 0, samples: [] }],
    });
    await service.receive(device.id, { reports: [multi] }, clock);
    expect(await MonitorInstance.count()).toBe(2);
    expect(await MonitorAlert.count({ where: { status: 'active' } })).toBe(1);
    await service.receive(device.id, { reports: [report(9)] }, clock);
    expect(await MonitorInstance.count({ where: { active: false } })).toBe(1);
  });
  test('最新配置已移除的实例，不被迟到旧报告重新激活', async () => {
    const late = report(9);
    const newest = report(0);
    newest.instances = [];
    await service.receive(device.id, { reports: [newest] }, clock);
    await service.receive(device.id, { reports: [late] }, clock);
    expect((await MonitorInstance.findByPk(instance.id)).active).toBe(false);
    const current = report(9);
    await service.receive(device.id, { reports: [current] }, clock);
    expect((await MonitorInstance.findByPk(instance.id)).active).toBe(true);
  });
  test('接口约束及流量汇总不重复；历史可读取', async () => {
    const invalid = report(1);
    invalid.traffic.receivedBytes = -1;
    await expect(service.receive(device.id, { reports: [invalid] }, clock)).rejects.toMatchObject({
      statusCode: 400,
    });
    const day = new Date(+clock + 8 * 3600000).toISOString().slice(0, 10);
    const summary = await service.traffic({ from: day, to: day, deviceIds: device.id });
    expect(summary.rows.reduce((sum, r) => sum + r.receivedBytes, 0)).toBe(
      (await MonitorTraffic.count()) * 1000
    );
    expect((await service.history(instance.id)).actions.count).toBe(4);
    await expect(service.traffic({ from: day, to: day, deviceIds: 'bad' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(
      service.testRule({ rule: config, text: '没有可用的代理\n购买异常：没有可用的代理' })
    ).toEqual({ count: 1, lines: [1] });
  });
  test('北京时间跨午夜分钟样本按时间比例分摊到两天', async () => {
    const r = report(0, 'ready', {
      startedAt: '2026-09-14T15:59:30.000Z',
      endedAt: '2026-09-14T16:00:30.000Z',
    });
    await service.receive(device.id, { reports: [r] });
    const summary = await service.traffic({
      from: '2026-09-14',
      to: '2026-09-15',
      deviceIds: device.id,
    });
    const previous = summary.rows.find(row => row.day === '2026-09-14' && row.hour === '23:00');
    const next = summary.rows.find(row => row.day === '2026-09-15' && row.hour === '00:00');
    expect(previous.receivedBytes).toBe(500);
    expect(next.receivedBytes).toBe(500);
    expect(previous.coveredSeconds).toBe(30);
    expect(next.coveredSeconds).toBe(30);
  });
  test('设备停用不接受新报告；90天清理仅作用于监控历史', async () => {
    await device.update({ enabled: false });
    await expect(service.receive(device.id, { reports: [report(9)] }, clock)).rejects.toMatchObject(
      { statusCode: 403 }
    );
    await device.update({ enabled: true });
    const old = new Date(Date.now() - 91 * 86400000);
    await MonitorTraffic.update({ startedAt: new Date(+old - 60000), endedAt: old }, { where: {} });
    await MonitorAlert.update({ lastSeenAt: old }, { where: {} });
    await sequelize.query('UPDATE monitor_actions SET created_at=:old', {
      replacements: { old: old.toISOString() },
    });
    await service.cleanup();
    expect(await MonitorTraffic.count()).toBe(0);
    expect(await MonitorAlert.count()).toBe(0);
    expect(await MonitorAction.count()).toBe(0);
    expect(await AosDevice.count()).toBe(1);
    expect(await MonitorRule.count()).toBe(1);
  });
  test('迁移down/up可往返，不触及设备及账号', async () => {
    const monitorMigration = require('../migrations/20260915000001-add-server-monitoring');
    const notificationMigration = require('../migrations/20260915000002-add-monitor-notifications');
    await notificationMigration.down(sequelize.getQueryInterface());
    await monitorMigration.down(sequelize.getQueryInterface());
    await monitorMigration.up(sequelize.getQueryInterface(), require('sequelize'));
    await notificationMigration.up(sequelize.getQueryInterface(), require('sequelize'));
    expect(await MonitorInstance.count()).toBe(0);
    expect(await MonitorNotificationSetting.count()).toBe(1);
    expect(await AosDevice.count()).toBe(1);
    expect(await User.count()).toBe(1);
  });
});
