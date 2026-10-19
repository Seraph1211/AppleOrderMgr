const { randomUUID, createHash } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const runFile = promisify(execFile);

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/services/wecomTransport', () => ({
  ...jest.requireActual('../src/services/wecomTransport'),
  sendText: jest.fn(() => {
    throw new Error('独立验收禁止真实企微出站');
  }),
}));
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => {
    throw new Error('独立验收必须注入合成 SMTP');
  }),
}));

const suite = process.env.MONITOR_NOTIFICATIONS_INDEPENDENT === '1' ? describe : describe.skip;
const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=independent-synthetic-key';
const MINUTE_MS = 60000;

suite('独立验收：服务器监控双通道事务与出站（真实 PostgreSQL）', () => {
  let models;
  let service;
  let sender;
  let scheduler;
  let actor;
  let device;
  let instance;
  let now;
  let server;
  let baseUrl;

  /** 本地真实 HTTP；仅身份由测试注入，权限中间件、服务、审计及数据库均真实执行。 */
  async function request(method, path, permissions = [], body) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-independent-permissions': permissions.join(','),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    } catch (error) {
      throw new Error(`独立 HTTP ${method} ${path} 失败：${error.message}`, { cause: error });
    }
  }

  /** 通过正式设置服务配置单通道。 */
  async function configure(channel, patch = {}) {
    try {
      const row = await models.MonitorNotificationChannel.findByPk(channel);
      return await service.saveChannel(actor.id, channel, {
        expectedVersion: row.version,
        enabled: row.enabled,
        sendRecovery: row.sendRecovery,
        ...patch,
      });
    } catch (error) {
      throw new Error(`独立配置 ${channel} 失败：${error.message}`, { cause: error });
    }
  }

  /** 创建真实规则、实例关联与合成告警事实；不调用被测入队函数。 */
  async function alert(severity = 'critical', at = now) {
    try {
      const rule = await models.MonitorRule.create({
        id: randomUUID(),
        version: 1,
        config: {
          name: '合成规则',
          enabled: true,
          severity,
          threshold: 1,
          windowMinutes: 5,
          deviceIds: [],
          directoryIds: [],
          keywords: ['合成异常'],
          excludes: [],
          mode: 'any',
        },
      });
      const row = await models.MonitorAlert.create({
        id: randomUUID(),
        instanceId: instance.id,
        ruleId: rule.id,
        ruleVersion: rule.version,
        ruleName: rule.config.name,
        severity,
        status: 'active',
        firstSeenAt: at,
        lastSeenAt: at,
        hitCount: 2,
      });
      return {
        alertId: row.id,
        instanceId: instance.id,
        deviceId: device.id,
        deviceName: device.name,
        instanceLabel: instance.label,
        ruleId: rule.id,
        ruleVersion: rule.version,
        ruleName: rule.config.name,
        severity,
        hitCount: 2,
        at: at.toISOString(),
      };
    } catch (error) {
      throw new Error(`独立告警准备失败：${error.message}`, { cause: error });
    }
  }

  /** 只通过正式双通道事务入口登记。 */
  async function enroll(payload) {
    try {
      await models.sequelize.transaction(transaction => service.enqueueAlert(payload, transaction));
      return await models.MonitorNotificationDelivery.findAll({ order: [['channel', 'ASC']] });
    } catch (error) {
      throw new Error(`独立入队失败：${error.message}`, { cause: error });
    }
  }

  /** 模拟新鲜有效观测推进，避免用旧告警冒充当前有效状态。 */
  async function observe(at = now) {
    try {
      await instance.update({ observedAt: at });
      await device.update({ heartbeatAt: at });
      await models.MonitorAlert.update({ lastSeenAt: at }, { where: { status: 'active' } });
    } catch (error) {
      throw new Error(`独立观测推进失败：${error.message}`, { cause: error });
    }
  }

  /** 通过正式采集报告入口生成服务端 clearSince，不直接伪造恢复观察字段。 */
  async function receiveReport(payload, count, state = 'ready') {
    try {
      const monitor = require('../src/services/monitorService');
      const context = await monitor.context(device.id);
      await device.update({ heartbeatAt: now });
      return await monitor.receive(
        device.id,
        {
          reports: [
            {
              id: randomUUID(),
              revision: context.revision,
              startedAt: new Date(+now - 1000).toISOString(),
              endedAt: now.toISOString(),
              traffic: {
                receivedBytes: 0,
                sentBytes: 0,
                collectorReceivedBytes: 0,
                collectorSentBytes: 0,
                quality: 'complete',
              },
              instances: [
                {
                  localId: instance.localId,
                  label: instance.label,
                  state,
                  files: ['Log20261019_001.txt'],
                  results: [{ ruleId: payload.ruleId, count, samples: [] }],
                },
              ],
            },
          ],
        },
        now
      );
    } catch (error) {
      throw new Error(`独立真实监控报告失败：${error.message}`, { cause: error });
    }
  }

  beforeAll(async () => {
    try {
      if (
        process.env.DB_HOST !== '127.0.0.1' ||
        process.env.DB_NAME !== 'monitor_notify_independent' ||
        process.env.DATABASE_URL
      )
        throw new Error('仅允许本轮隔离 PostgreSQL Compose');
      models = require('../src/models');
      service = require('../src/services/monitorNotificationService');
      sender = require('../src/services/monitorNotificationSender');
      scheduler = require('../src/services/monitorNotificationScheduler');
      await models.sequelize.authenticate();
      const express = require('express');
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.requestId = randomUUID();
        req.user = {
          id: actor?.id,
          username: 'independent_monitor',
          role: 'operator',
          permissions: String(req.headers['x-independent-permissions'] || '').split(','),
        };
        next();
      });
      app.use(require('../src/middleware/operationAudit').operationAudit);
      app.use('/api/server-monitor', require('../src/routes/serverMonitor'));
      app.use((error, _req, res, _next) => {
        res.status(error.statusCode || 500).json({
          success: false,
          error: { code: error.code, message: error.message },
        });
      });
      await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', resolve);
      });
      baseUrl = `http://127.0.0.1:${server.address().port}/api/server-monitor`;
    } catch (error) {
      throw new Error(`独立通知环境初始化失败：${error.message}`, { cause: error });
    }
  });

  beforeEach(async () => {
    try {
      await models.sequelize.query(`TRUNCATE monitor_notification_events,
        monitor_notification_links,monitor_notification_deliveries,notification_worker_states,
        wecom_robot_budgets,monitor_alerts,monitor_instances,monitor_rules,aos_devices,users,
        operation_logs CASCADE`);
      await models.sequelize.query(`UPDATE monitor_notification_channels SET enabled=false,
        recipients='[]',webhook_cipher=NULL,target_version=1,policy_version=1,policy='{}',
        version=1,enabled_at=NULL,paused_reason=NULL,last_test=NULL,last_accepted_at=NULL`);
      await models.MonitorNotificationSetting.upsert({
        id: 1,
        enabled: false,
        recipients: [],
        sendRecovery: true,
        version: 1,
      });
      actor = await models.User.create({
        username: 'independent_monitor',
        password: 'synthetic-independent-only',
        role: 'admin',
      });
      device = await models.AosDevice.create({
        id: randomUUID(),
        name: '独立合成服务器',
        enabled: true,
        credentialHash: createHash('sha256').update(randomUUID()).digest('hex'),
      });
      await configure('email', { enabled: true, recipients: ['one@example.test'] });
      await configure('wecom', { enabled: false, webhook: WEBHOOK, targetName: '独立合成群' });
      await configure('wecom', { enabled: true });
      now = new Date(Date.now() + 100);
      await device.update({ heartbeatAt: now });
      instance = await models.MonitorInstance.create({
        id: randomUUID(),
        deviceId: device.id,
        localId: randomUUID(),
        label: '独立合成实例',
        active: true,
        observedAt: now,
        snapshot: { state: 'ready' },
      });
    } catch (error) {
      throw new Error(`独立合成数据重置失败：${error.message}`, { cause: error });
    }
  });

  afterAll(async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      await models?.sequelize.close();
    } catch (error) {
      throw new Error('独立通知连接关闭失败', { cause: error });
    }
  });

  test('EVT-01：八个并发事务同事件仅 email/wecom 各一次，事务回滚不残留', async () => {
    try {
      const payload = await alert();
      await Promise.all(Array.from({ length: 8 }, () => enroll(payload)));
      const deliveries = await models.MonitorNotificationDelivery.findAll();
      expect(deliveries.map(row => row.channel).sort()).toEqual(['email', 'wecom']);
      expect(await models.MonitorNotificationEvent.count()).toBe(2);
      const rollbackPayload = await alert();
      await expect(
        models.sequelize.transaction(async transaction => {
          await service.enqueueAlert(rollbackPayload, transaction);
          throw new Error('独立合成事务回滚');
        })
      ).rejects.toThrow('独立合成事务回滚');
      expect(await models.MonitorNotificationDelivery.count()).toBe(2);
      expect(await models.MonitorNotificationEvent.count()).toBe(2);
    } catch (error) {
      throw new Error(`EVT-01 失败：${error.message}`, { cause: error });
    }
  });

  test('CFG-01：旧邮件接口保存不改企微，关闭再启用不复活旧任务', async () => {
    try {
      const rows = await enroll(await alert());
      const wecomBefore = (await models.MonitorNotificationChannel.findByPk('wecom')).toJSON();
      const settings = await service.settings();
      await service.saveSettings(actor.id, {
        expectedVersion: settings.version,
        enabled: false,
        sendRecovery: true,
        recipients: settings.recipients,
      });
      expect((await models.MonitorNotificationChannel.findByPk('wecom')).toJSON()).toEqual(
        wecomBefore
      );
      await configure('email', { enabled: true });
      expect((await models.MonitorNotificationDelivery.findByPk(rows[0].id)).status).toBe(
        'skipped'
      );
      expect((await models.MonitorNotificationDelivery.findByPk(rows[1].id)).status).toBe(
        'pending'
      );
    } catch (error) {
      throw new Error(`CFG-01 失败：${error.message}`, { cause: error });
    }
  });

  test('TIME-01：警告固定三分钟合并，2分59秒新事件不延后，邮件仍十分钟', async () => {
    try {
      const firstAt = new Date(now);
      await enroll(await alert('warning'));
      now = new Date(+now + 179000);
      await enroll(await alert('warning'));
      const rows = await models.MonitorNotificationDelivery.findAll();
      expect(rows).toHaveLength(2);
      expect(+rows.find(row => row.channel === 'wecom').notBefore).toBe(+firstAt + 180000);
      expect(+rows.find(row => row.channel === 'email').notBefore).toBe(+firstAt + 600000);
      expect(await models.MonitorNotificationEvent.count()).toBe(4);
    } catch (error) {
      throw new Error(`TIME-01 失败：${error.message}`, { cause: error });
    }
  });

  test('TIME-02：真实报告异常打断恢复观察，重新连续两分钟才出站恢复', async () => {
    try {
      const payload = await alert();
      await enroll(payload);
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      await sender.processOne(now, { channel: 'wecom', send });
      const start = +now;
      now = new Date(start + MINUTE_MS);
      await receiveReport(payload, 0);
      now = new Date(start + 90000);
      await receiveReport(payload, 0);
      expect((await models.MonitorAlert.findByPk(payload.alertId)).status).toBe('recovered');
      now = new Date(start + 120000);
      await receiveReport(payload, 0, 'unreadable');
      now = new Date(start + 150000);
      await receiveReport(payload, 0);
      now = new Date(start + 210000);
      await receiveReport(payload, 0);
      await sender.processOne(now, { channel: 'wecom', send });
      expect(send).toHaveBeenCalledTimes(1);
      const recovery = await models.MonitorNotificationDelivery.findOne({
        where: { channel: 'wecom', category: 'recovery' },
      });
      expect(recovery.status).toBe('pending');
      expect(recovery.waitReason).toBe('RECOVERY_OBSERVING');
      now = new Date(start + 270000);
      await receiveReport(payload, 0);
      await sender.processOne(now, { channel: 'wecom', send });
      expect(send).toHaveBeenCalledTimes(2);
      expect((await recovery.reload()).status).toBe('accepted');
    } catch (error) {
      throw new Error(`TIME-02 失败：${error.message}`, { cause: error });
    }
  });

  test('REC-02：真实报告快速复发后，旧周期恢复不能出站', async () => {
    try {
      const payload = await alert();
      await enroll(payload);
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      await sender.processOne(now, { channel: 'wecom', send });
      const start = +now;
      for (const at of [60000, 90000]) {
        now = new Date(start + at);
        await receiveReport(payload, 0);
      }
      now = new Date(start + 120000);
      await receiveReport(payload, 2);
      now = new Date(start + 210000);
      await receiveReport(payload, 2);
      for (let index = 0; index < 2; index++)
        await sender.processOne(now, { channel: 'wecom', send });
      const recovery = await models.MonitorNotificationDelivery.findOne({
        where: { channel: 'wecom', category: 'recovery' },
      });
      expect(recovery.status).toBe('skipped');
      expect(send.mock.calls.every(([, message]) => !message.includes('规则条件已解除'))).toBe(
        true
      );
    } catch (error) {
      throw new Error(`REC-02 失败：${error.message}`, { cause: error });
    }
  });

  test('EVT-03：新通道不订阅启用前的迟到报告，显式摘要另行操作', async () => {
    try {
      const enabled = await models.MonitorNotificationChannel.findByPk('wecom');
      await enroll(await alert('critical', new Date(+enabled.enabledAt - 1000)));
      expect(await models.MonitorNotificationDelivery.count({ where: { channel: 'wecom' } })).toBe(
        0
      );
    } catch (error) {
      throw new Error(`EVT-03 失败：${error.message}`, { cause: error });
    }
  });

  test('REL-01：双执行器并发只领取一次，旧租约完成不能覆盖新领取', async () => {
    try {
      await enroll(await alert());
      const claims = await Promise.all([sender.claim('wecom', now), sender.claim('wecom', now)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const stale = claims.find(Boolean);
      now = new Date(+stale.leaseUntil + 1);
      await sender.reap('wecom', now);
      const current = await sender.claim('wecom', now);
      expect(current.id).toBe(stale.id);
      expect(current.leaseToken).not.toBe(stale.leaseToken);
      await sender.finish(stale, { status: 'accepted' }, now);
      expect((await models.MonitorNotificationDelivery.findByPk(current.id)).leaseToken).toBe(
        current.leaseToken
      );
      expect((await models.MonitorNotificationDelivery.findByPk(current.id)).status).toBe(
        'sending'
      );
    } catch (error) {
      throw new Error(`REL-01 失败：${error.message}`, { cause: error });
    }
  });

  test('REL-02：出站后租约过期转 unknown 且不自动重发', async () => {
    try {
      await enroll(await alert());
      const claimed = await sender.claim('wecom', now);
      expect(await sender.authorize(claimed, now)).toBeTruthy();
      const dispatched = await models.MonitorNotificationDelivery.findByPk(claimed.id);
      expect(dispatched.dispatchStartedAt).not.toBeNull();
      now = new Date(+dispatched.leaseUntil + 1);
      await sender.reap('wecom', now);
      expect((await models.MonitorNotificationDelivery.findByPk(claimed.id)).status).toBe(
        'unknown'
      );
      expect(await sender.claim('wecom', now)).toBeNull();
    } catch (error) {
      throw new Error(`REL-02 失败：${error.message}`, { cause: error });
    }
  });

  test('CFG-02：领取后换收件人，旧目标出站授权被拒绝', async () => {
    try {
      await enroll(await alert());
      const claimed = await sender.claim('email', now);
      await configure('email', { recipients: ['two@example.test'] });
      expect(await sender.authorize(claimed, now)).toBeNull();
      expect((await models.MonitorNotificationDelivery.findByPk(claimed.id)).status).toBe(
        'skipped'
      );
    } catch (error) {
      throw new Error(`CFG-02 失败：${error.message}`, { cause: error });
    }
  });

  test('CFG-03：已出站后换目标，接受结果仍记录于原任务', async () => {
    try {
      await enroll(await alert());
      const claimed = await sender.claim('email', now);
      expect(await sender.authorize(claimed, now)).toBeTruthy();
      await configure('email', { recipients: ['two@example.test'] });
      await sender.finish(claimed, { status: 'accepted' }, now);
      const saved = await models.MonitorNotificationDelivery.findByPk(claimed.id);
      expect(saved.status).toBe('accepted');
      expect(saved.recipientSnapshot).toEqual(['one@example.test']);
    } catch (error) {
      throw new Error(`CFG-03 失败：${error.message}`, { cause: error });
    }
  });

  test('CFG-05：混合旧API只改legacy收件人时，新sender拒绝旧快照出站', async () => {
    try {
      await enroll(await alert());
      await models.MonitorNotificationSetting.update(
        {
          recipients: ['legacy-change@example.test'],
          version: models.sequelize.literal('version + 1'),
        },
        { where: { id: 1 } }
      );
      const sendMail = jest.fn().mockResolvedValue({ accepted: ['one@example.test'] });
      await sender.processOne(now, { channel: 'email', mailClient: { sendMail } });
      expect(sendMail).not.toHaveBeenCalled();
      const row = await models.MonitorNotificationDelivery.findOne({ where: { channel: 'email' } });
      expect(row.status).toBe('skipped');
      expect(row.errorCode).toBe('LEGACY_SETTINGS_CHANGED');
    } catch (error) {
      throw new Error(`CFG-05 失败：${error.message}`, { cause: error });
    }
  });

  test('REL-04：企微超时未知不会重试，明确未连接才安全退避', async () => {
    try {
      await enroll(await alert());
      const send = jest.fn().mockRejectedValue(new Error('synthetic timeout'));
      await sender.processOne(now, { channel: 'wecom', send });
      now = new Date(+now + MINUTE_MS);
      await sender.processOne(now, { channel: 'wecom', send });
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        (await models.MonitorNotificationDelivery.findOne({ where: { channel: 'wecom' } })).status
      ).toBe('unknown');
      await enroll(await alert());
      const unconnected = jest.fn().mockResolvedValue({
        status: 'pending',
        errorCode: 'CONNECT_FAILED',
        retryMs: 10000,
      });
      await sender.processOne(now, { channel: 'wecom', send: unconnected });
      const pending = await models.MonitorNotificationDelivery.findOne({
        where: { channel: 'wecom', status: 'pending' },
      });
      expect(+pending.notBefore).toBe(+now + 10000);
    } catch (error) {
      throw new Error(`REL-04 失败：${error.message}`, { cause: error });
    }
  });

  test('REC-01：只有同通道同目标 accepted/unknown 可建立恢复关联', async () => {
    try {
      const payload = await alert();
      await enroll(payload);
      const send = jest
        .fn()
        .mockResolvedValue({ status: 'unknown', errorCode: 'RESPONSE_UNKNOWN' });
      await sender.processOne(now, { channel: 'wecom', send });
      now = new Date(+now + MINUTE_MS);
      await models.MonitorAlert.update(
        { status: 'recovered', recoveredAt: now },
        { where: { id: payload.alertId } }
      );
      await models.sequelize.transaction(transaction =>
        service.enqueueRecovery({ ...payload, at: now.toISOString() }, transaction)
      );
      const recovery = await models.MonitorNotificationDelivery.findAll({
        where: { category: 'recovery' },
      });
      expect(recovery).toHaveLength(1);
      expect(recovery[0].channel).toBe('wecom');
      const event = await models.MonitorNotificationEvent.findOne({
        where: { deliveryId: recovery[0].id },
      });
      expect(event.payload.originalUnknown).toBe(true);
    } catch (error) {
      throw new Error(`REC-01 失败：${error.message}`, { cause: error });
    }
  });

  test('REC-03：旧目标接受／未知关联不使新机器人收到孤立恢复', async () => {
    try {
      const payload = await alert();
      await enroll(payload);
      await sender.processOne(now, {
        channel: 'wecom',
        send: jest.fn().mockResolvedValue({
          status: 'unknown',
          errorCode: 'RESPONSE_UNKNOWN',
        }),
      });
      await configure('wecom', { enabled: false });
      await configure('wecom', {
        enabled: false,
        webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=recovery-new-synthetic-key',
      });
      await configure('wecom', { enabled: true });
      await models.sequelize.transaction(transaction =>
        service.enqueueRecovery(payload, transaction)
      );
      expect(
        await models.MonitorNotificationDelivery.count({ where: { category: 'recovery' } })
      ).toBe(0);
    } catch (error) {
      throw new Error(`REC-03 失败：${error.message}`, { cause: error });
    }
  });

  test('REL-03：SMTP 部分接受只重试明确未接受的收件人', async () => {
    try {
      await configure('email', { recipients: ['one@example.test', 'two@example.test'] });
      await enroll(await alert());
      const sendMail = jest
        .fn()
        .mockResolvedValueOnce({
          accepted: ['one@example.test'],
          rejected: ['two@example.test'],
          rejectedErrors: [{ recipient: 'two@example.test', responseCode: 450 }],
        })
        .mockResolvedValueOnce({ accepted: ['two@example.test'], rejected: [] });
      await sender.processOne(now, { channel: 'email', mailClient: { sendMail } });
      now = new Date(+now + MINUTE_MS);
      await observe();
      await sender.processOne(now, { channel: 'email', mailClient: { sendMail } });
      expect(sendMail).toHaveBeenCalledTimes(2);
      expect(sendMail.mock.calls[0][0].to.sort()).toEqual(['one@example.test', 'two@example.test']);
      expect(sendMail.mock.calls[1][0].to).toEqual(['two@example.test']);
      expect(
        (await models.MonitorNotificationDelivery.findOne({ where: { channel: 'email' } })).status
      ).toBe('accepted');
    } catch (error) {
      throw new Error(`REL-03 失败：${error.message}`, { cause: error });
    }
  });

  test('TIME-03：严重提醒15/30/60分钟持久化，独立进程重启调度不重复', async () => {
    try {
      const payload = await alert();
      await enroll(payload);
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      await sender.processOne(now, { channel: 'wecom', send });
      const acceptedAt = new Date(now);
      now = new Date(+now + 15 * MINUTE_MS - 1);
      await observe();
      await scheduler.scheduleTick(now);
      expect(
        await models.MonitorNotificationDelivery.count({ where: { category: 'reminder' } })
      ).toBe(0);
      now = new Date(+now + 1);
      await observe();
      const program = `const s=require('./src/services/monitorNotificationScheduler');
        const db=require('./src/models').sequelize;
        s.scheduleTick(new Date(process.argv[1])).catch(()=>{process.exitCode=1;})
          .finally(()=>db.close());`;
      await runFile(process.execPath, ['-e', program, now.toISOString()], { cwd: '/app' });
      await scheduler.scheduleTick(now);
      expect(
        await models.MonitorNotificationDelivery.count({ where: { category: 'reminder' } })
      ).toBe(1);
      await sender.processOne(now, { channel: 'wecom', send });
      let link = await models.MonitorNotificationLink.findOne({
        where: { alertId: payload.alertId, channel: 'wecom' },
      });
      expect(+link.nextReminderAt).toBe(+acceptedAt + 45 * MINUTE_MS);
      now = new Date(+link.nextReminderAt);
      await observe();
      await scheduler.scheduleTick(now);
      await sender.processOne(now, { channel: 'wecom', send });
      link = await models.MonitorNotificationLink.findByPk(link.id);
      expect(+link.nextReminderAt).toBe(+acceptedAt + 105 * MINUTE_MS);
      expect(
        await models.MonitorNotificationDelivery.count({
          where: { category: 'reminder', channel: 'email' },
        })
      ).toBe(0);
    } catch (error) {
      throw new Error(`TIME-03 失败：${error.message}`, { cause: error });
    }
  });

  test('TIME-04：静默到期与周期提醒合并，只发当前仍异常一次', async () => {
    try {
      const payload = await alert();
      await enroll(payload);
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      await sender.processOne(now, { channel: 'wecom', send });
      const until = new Date(+now + 15 * MINUTE_MS);
      await instance.update({ handling: { until: until.toISOString() } });
      await models.sequelize.transaction(transaction =>
        service.enqueueReminder(
          {
            ...payload,
            until: until.toISOString(),
          },
          transaction
        )
      );
      now = new Date(+until - 1);
      await observe();
      await scheduler.scheduleTick(now);
      await sender.processOne(now, { channel: 'wecom', send });
      expect(send).toHaveBeenCalledTimes(1);
      now = new Date(+until);
      await observe();
      await scheduler.scheduleTick(now);
      await sender.processOne(now, { channel: 'wecom', send });
      now = new Date(+now + 5000);
      await sender.processOne(now, { channel: 'wecom', send });
      expect(send).toHaveBeenCalledTimes(2);
    } catch (error) {
      throw new Error(`TIME-04 失败：${error.message}`, { cause: error });
    }
  });

  test('EVT-02：通道自动关闭仍允许固定合成测试，requestKey 并发去重', async () => {
    try {
      await configure('wecom', { enabled: false });
      const requestKey = randomUUID();
      const queued = await Promise.all(
        Array.from({ length: 4 }, () => service.queueTest('wecom', { requestKey }))
      );
      expect(new Set(queued.map(row => row.deliveryId)).size).toBe(1);
      expect(await models.MonitorNotificationDelivery.count()).toBe(1);
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      await sender.processOne(now, { channel: 'wecom', send });
      expect(send).toHaveBeenCalledTimes(1);
    } catch (error) {
      throw new Error(`EVT-02 失败：${error.message}`, { cause: error });
    }
  });

  test('API-01：日志权限不能读写通知，新读取权限不能保存／测试／重试', async () => {
    try {
      for (const path of [
        '/notifications/channels',
        '/notifications/deliveries',
        '/notifications/health',
      ]) {
        expect((await request('GET', path, ['monitor.logs.read'])).status).toBe(403);
        const allowed = await request('GET', path, ['monitor.notifications.read']);
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get('cache-control')).toBe('no-store');
      }
      const email = await service.settings();
      const read = ['monitor.notifications.read'];
      expect(
        (
          await request('PUT', '/notifications/channels/email', read, {
            expectedVersion: email.version,
            enabled: false,
            sendRecovery: true,
          })
        ).status
      ).toBe(403);
      expect(
        (
          await request('POST', '/notifications/channels/wecom/test', read, {
            requestKey: randomUUID(),
          })
        ).status
      ).toBe(403);
      expect(
        (
          await request('POST', `/notifications/deliveries/${randomUUID()}/retry`, read, {
            expectedVersion: 1,
          })
        ).status
      ).toBe(403);
    } catch (error) {
      throw new Error(`API-01 失败：${error.message}`, { cause: error });
    }
  });

  test('API-02：配置／健康／投递 DTO 及审计不含机器人密钥、密文或SMTP密码', async () => {
    try {
      await enroll(await alert());
      const serialized = [];
      for (const path of [
        '/notifications/channels',
        '/notifications/deliveries',
        '/notifications/health',
      ]) {
        const result = await request('GET', path, ['monitor.notifications.read']);
        expect(result.status).toBe(200);
        serialized.push(JSON.stringify(result.body));
      }
      serialized.push(
        JSON.stringify((await models.OperationLog.findAll()).map(row => row.toJSON()))
      );
      expect(serialized.join('\n')).not.toMatch(
        /independent-synthetic-key|webhookCipher|webhook_cipher|enc:v1:|synthetic-mail-only/
      );
    } catch (error) {
      throw new Error(`API-02 失败：${error.message}`, { cause: error });
    }
  });

  test('API-03：自动健康／投递轮询无审计，失败权限和敏感日志读取仍审计', async () => {
    try {
      const read = ['monitor.notifications.read'];
      expect((await request('GET', '/notifications/health', read)).status).toBe(200);
      expect((await request('GET', '/notifications/deliveries', read)).status).toBe(200);
      expect(await models.OperationLog.count()).toBe(0);
      expect((await request('GET', '/notifications/health', ['monitor.logs.read'])).status).toBe(
        403
      );
      let logs = await models.OperationLog.findAll();
      expect(logs).toHaveLength(1);
      expect(logs[0].result).toBe('failed');
      expect((await request('GET', '/logs/states', ['monitor.logs.read'])).status).toBe(200);
      logs = await models.OperationLog.findAll();
      expect(logs).toHaveLength(2);
      expect(logs.some(row => row.statusCode === 200)).toBe(true);
    } catch (error) {
      throw new Error(`API-03 失败：${error.message}`, { cause: error });
    }
  });

  test('API-04：旧 monitor.manage 授权派生三类通知权限并可访问新接口', async () => {
    try {
      const legacyUser = await models.User.create({
        username: 'legacy_monitor_operator',
        password: 'synthetic-only',
        role: 'operator',
      });
      await models.UserPermission.create({
        userId: legacyUser.id,
        permissionCode: 'monitor.manage',
      });
      const effective = await require('../src/services/permissionService').getEffectivePermissions(
        legacyUser
      );
      expect(effective).toEqual(
        expect.arrayContaining([
          'monitor.notifications.read',
          'monitor.notifications.configure',
          'monitor.notifications.retry',
        ])
      );
      expect((await request('GET', '/notifications/channels', effective)).status).toBe(200);
    } catch (error) {
      throw new Error(`API-04 失败：${error.message}`, { cause: error });
    }
  });

  test('API-05：unknown重试须确认可能重复，旧版本和已恢复事件拒绝', async () => {
    try {
      const payload = await alert();
      await enroll(payload);
      const send = jest
        .fn()
        .mockResolvedValue({ status: 'unknown', errorCode: 'RESPONSE_UNKNOWN' });
      await sender.processOne(now, { channel: 'wecom', send });
      let row = await models.MonitorNotificationDelivery.findOne({ where: { channel: 'wecom' } });
      const url = `/notifications/deliveries/${row.id}/retry`;
      const permissions = ['monitor.notifications.retry'];
      const unacknowledged = await request('POST', url, permissions, {
        expectedVersion: row.version,
      });
      expect(unacknowledged.status).toBe(400);
      expect(unacknowledged.body.error.code).toBe('UNKNOWN_ACK_REQUIRED');
      expect(
        (
          await request('POST', url, permissions, {
            expectedVersion: row.version - 1,
            acknowledgeUnknown: true,
          })
        ).status
      ).toBe(409);
      expect(
        (
          await request('POST', url, permissions, {
            expectedVersion: row.version,
            acknowledgeUnknown: true,
          })
        ).status
      ).toBe(200);
      now = new Date(+now + 5000);
      await sender.processOne(now, { channel: 'wecom', send });
      row = await models.MonitorNotificationDelivery.findByPk(row.id);
      expect(row.status).toBe('unknown');
      await models.MonitorAlert.update(
        { status: 'recovered', recoveredAt: now },
        {
          where: { id: payload.alertId },
        }
      );
      const recovered = await request('POST', url, permissions, {
        expectedVersion: row.version,
        acknowledgeUnknown: true,
      });
      expect(recovered.status).toBe(409);
      expect(recovered.body.error.code).toBe('NOTIFICATION_SCOPE_CHANGED');
    } catch (error) {
      throw new Error(`API-05 失败：${error.message}`, { cause: error });
    }
  });

  test('API-06：当前摘要预览不入队，发送requestKey去重，空摘要不发', async () => {
    try {
      const payload = await alert();
      await enroll(payload);
      const before = await models.MonitorNotificationDelivery.count();
      const url = '/notifications/channels/wecom/current-summary';
      const permissions = ['monitor.notifications.configure'];
      const preview = await request('POST', url, permissions, { preview: true });
      expect(preview.status).toBe(200);
      expect(preview.body.data.preview.eventCount).toBe(1);
      expect(await models.MonitorNotificationDelivery.count()).toBe(before);
      const row = await models.MonitorNotificationChannel.findByPk('wecom');
      const body = { preview: false, requestKey: randomUUID(), expectedVersion: row.version };
      const first = await request('POST', url, permissions, body);
      const second = await request('POST', url, permissions, body);
      expect(first.status).toBe(200);
      expect(second.body.data.deliveryId).toBe(first.body.data.deliveryId);
      expect(await models.MonitorNotificationDelivery.count()).toBe(before + 1);
      await models.MonitorAlert.update(
        { status: 'recovered', recoveredAt: now },
        {
          where: { id: payload.alertId },
        }
      );
      const empty = await request('POST', url, permissions, { ...body, requestKey: randomUUID() });
      expect(empty.body.data).toMatchObject({ deliveryId: null, status: 'skipped', eventCount: 0 });
    } catch (error) {
      throw new Error(`API-06 失败：${error.message}`, { cause: error });
    }
  });

  test.each([
    ['CONNECT_FAILED', [10000, 30000, 60000]],
    ['RATE_LIMITED', [60000, 60000, 60000]],
  ])('REL-07：企微%s最多三次安全重试且退避持久化', async (errorCode, delays) => {
    try {
      await enroll(await alert());
      const send = jest.fn().mockResolvedValue({ status: 'pending', errorCode });
      for (let index = 0; index < 4; index++) {
        await observe();
        const at = +now;
        await sender.processOne(now, { channel: 'wecom', send });
        const row = await models.MonitorNotificationDelivery.findOne({
          where: { channel: 'wecom' },
        });
        if (index < 3) {
          expect(row.status).toBe('pending');
          expect(+row.notBefore).toBe(at + delays[index]);
          now = new Date(+row.notBefore);
        } else expect(row.status).toBe('failed');
      }
      await sender.processOne(now, { channel: 'wecom', send });
      expect(send).toHaveBeenCalledTimes(4);
    } catch (error) {
      throw new Error(`REL-07 ${errorCode} 失败：${error.message}`, { cause: error });
    }
  });

  test('RATE-01：真实订单／库存／AOS／监控发送入口共用机器人，监控6条和滚动总量18条', async () => {
    try {
      const { encrypt } = require('../src/utils/fieldEncryption');
      const InventoryService = require('../src/services/inventoryService');
      const InventoryNotifier = require('../src/services/inventoryNotifier');
      const AosSignalService = require('../src/services/aosSignalService');
      const signalPolicy = require('../src/services/aosSignalPolicy');
      const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
      const orderService = require('../src/services/wecomNotificationService');
      const orderSender = require('../src/services/wecomNotificationSender');
      const inventory = new InventoryService(models);
      const locked = inventory.locked.bind(inventory);
      inventory.locked = callback => locked(context => callback({ ...context, now: +now }));
      await models.sequelize.query(`TRUNCATE inventory_deliveries,inventory_settings,
        inventory_runtime,aos_signal_inbox,aos_signal_contexts,wecom_notification_deliveries`);
      const destinationId = randomUUID();
      await models.InventoryRuntime.create({ id: 'main', body: { seeded: true } });
      await models.InventorySetting.create({
        id: 'main',
        body: {
          version: 1,
          config: {
            ...DEFAULT_CONFIG,
            enabled: false,
            notificationsEnabled: false,
            aosSignalsEnabled: true,
            silentStart: '',
            silentEnd: '',
          },
          webhookCipher: encrypt(WEBHOOK),
          destinationId,
          aosSignalsSince: +now - 1,
        },
      });
      await models.WecomNotificationSetting.update(
        {
          enabled: false,
          webhookCipher: encrypt(WEBHOOK),
          groupName: '独立订单合成群',
          destinationId: randomUUID(),
          pausedReason: null,
          nextSendAt: null,
        },
        { where: { id: 1 } }
      );
      const sends = [];
      const makeSend = lane =>
        jest.fn((_webhook, _text) => {
          sends.push({ at: +now, lane });
          return Promise.resolve({ status: 'accepted' });
        });
      const monitorSend = makeSend('monitor');
      const orderSend = makeSend('orders');
      let inventoryLane = 'inventory';
      const notifier = new InventoryNotifier(inventory, (_webhook, text) => {
        sends.push({ at: +now, lane: inventoryLane, content: text });
        return Promise.resolve({ status: 'accepted' });
      });
      const start = +now;
      for (let step = 0; step < 22; step++) {
        now = new Date(start + step * 3334);
        if (step < 7) {
          await service.queueTest('wecom', { requestKey: randomUUID() });
          await sender.processOne(now, { channel: 'wecom', send: monitorSend });
          if (step === 6) {
            expect(monitorSend).toHaveBeenCalledTimes(6);
            expect(
              await models.MonitorNotificationDelivery.count({
                where: { channel: 'wecom', status: 'pending' },
              })
            ).toBe(1);
          }
        } else if (step === 9) {
          inventoryLane = 'aos';
          const attempt = [
            '加入购物车成功',
            '尝试预约: Apple 王府井, 日期',
            '商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999',
            '取货信息: 取货日期待付款完成后确定',
          ];
          const parsed = attempt
            .map((text, index) =>
              signalPolicy.parseEntry(
                {
                  id: randomUUID(),
                  deviceId: device.id,
                  localId: instance.localId,
                  fileId: 'independent-file',
                  byteOffset: index + 1,
                  loggedAt: now.toISOString(),
                  parseState: 'parsed',
                  partIndex: 0,
                  message: `2026-10-19 08:00:00.000 [2][013]A77-${text}`,
                },
                +now
              )
            )
            .filter(Boolean);
          expect(parsed).toHaveLength(4);
          await models.AosSignalInbox.bulkCreate(parsed.map(({ id, ...body }) => ({ id, body })));
          await new AosSignalService(inventory).tick();
          await notifier.tick();
        } else if (step % 2) {
          const orderSetting = await orderService.settings();
          await orderService.queueTest(actor.id, {
            idempotencyKey: randomUUID(),
            expectedVersion: orderSetting.version,
          });
          await orderSender.sendNext({ clock: () => now, send: orderSend });
        } else {
          inventoryLane = 'inventory';
          await notifier.test(actor.id);
          await notifier.tick();
        }
      }
      expect(new Set(sends.map(row => row.lane))).toEqual(
        new Set(['monitor', 'orders', 'inventory', 'aos'])
      );
      expect(sends.find(row => row.lane === 'aos').content).toContain('AOS 放货信号');
      for (let index = 1; index < sends.length; index++)
        expect(sends[index].at - sends[index - 1].at).toBeGreaterThanOrEqual(3334);
      for (const item of sends) {
        const window = sends.filter(row => row.at > item.at - MINUTE_MS && row.at <= item.at);
        expect(window.length).toBeLessThanOrEqual(18);
        expect(window.filter(row => row.lane === 'monitor').length).toBeLessThanOrEqual(6);
      }
      expect(await models.WecomRobotBudget.count()).toBe(1);
    } catch (error) {
      throw new Error(`RATE-01 失败：${error.message}`, { cause: error });
    }
  });

  test('REL-05：旧发送者无法跨所有权领取，新默认email发送器不领取wecom', async () => {
    try {
      await configure('email', { enabled: false });
      await enroll(await alert());
      const row = await models.MonitorNotificationDelivery.findOne();
      expect(row.channel).toBe('wecom');
      await expect(
        models.sequelize.transaction(transaction =>
          models.MonitorNotificationDelivery.update(
            { status: 'sending' },
            {
              where: { id: row.id },
              transaction,
            }
          )
        )
      ).rejects.toThrow(/MONITOR_SENDER_GENERATION_REQUIRED/);
      const sendMail = jest.fn().mockResolvedValue({ accepted: ['one@example.test'] });
      expect(await sender.processOne(now, { mailClient: { sendMail } })).toBe(false);
      expect(sendMail).not.toHaveBeenCalled();
      expect((await models.MonitorNotificationDelivery.findByPk(row.id)).status).toBe('pending');
    } catch (error) {
      throw new Error(`REL-05 失败：${error.message}`, { cause: error });
    }
  });

  test('RATE-02：超过五个不同异常后合并每分钟一条，两个低阈值窗口后退出', async () => {
    try {
      now = new Date(Math.ceil(+now / MINUTE_MS) * MINUTE_MS + 1000);
      const start = +now;
      await observe();
      for (let index = 0; index < 7; index++) await enroll(await alert());
      const storm = await models.MonitorNotificationDelivery.findAll({
        where: { channel: 'wecom', category: 'storm' },
      });
      expect(storm).toHaveLength(1);
      expect(
        await models.MonitorNotificationEvent.count({ where: { deliveryId: storm[0].id } })
      ).toBe(2);
      expect(await models.MonitorNotificationEvent.count({ where: { channel: 'wecom' } })).toBe(7);
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      for (let index = 0; index < 5; index++) {
        now = new Date(start + index * 3334);
        await sender.processOne(now, { channel: 'wecom', send });
      }
      expect(send).toHaveBeenCalledTimes(5);
      now = new Date(+storm[0].notBefore);
      await observe();
      await sender.processOne(now, { channel: 'wecom', send });
      expect(send).toHaveBeenCalledTimes(6);
      expect((await storm[0].reload()).status).toBe('accepted');
      now = new Date(start + 119999);
      await enroll(await alert());
      expect((await models.NotificationWorkerState.findByPk('storm-wecom')).details.active).toBe(
        true
      );
      now = new Date(start + 120001);
      await enroll(await alert());
      expect((await models.NotificationWorkerState.findByPk('storm-wecom')).details.active).toBe(
        false
      );
    } catch (error) {
      throw new Error(`RATE-02 失败：${error.message}`, { cause: error });
    }
  });

  test('CFG-04：替换机器人后新目标不继承旧目标风暴窗口', async () => {
    try {
      for (let index = 0; index < 7; index++) await enroll(await alert());
      await configure('wecom', { enabled: false });
      await configure('wecom', {
        enabled: false,
        webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=independent-new-target-key',
      });
      await configure('wecom', { enabled: true });
      const channel = await models.MonitorNotificationChannel.findByPk('wecom');
      now = new Date(Math.max(+now, +channel.enabledAt + 1));
      await enroll(await alert());
      const rows = await models.MonitorNotificationDelivery.findAll({
        where: { channel: 'wecom', targetVersion: channel.targetVersion },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe('alert');
      expect(+rows[0].notBefore).toBe(+now);
    } catch (error) {
      throw new Error(`CFG-04 失败：${error.message}`, { cause: error });
    }
  });

  test('REL-06：SMTP DATA阶段通用 ECONNECTION 不能断定未接受，只记unknown', async () => {
    try {
      await enroll(await alert());
      const sendMail = jest.fn().mockRejectedValue(
        Object.assign(new Error('synthetic DATA connection lost'), {
          code: 'ECONNECTION',
          command: 'DATA',
        })
      );
      await sender.processOne(now, { channel: 'email', mailClient: { sendMail } });
      const row = await models.MonitorNotificationDelivery.findOne({ where: { channel: 'email' } });
      expect(row.status).toBe('unknown');
      now = new Date(+now + MINUTE_MS);
      await sender.processOne(now, { channel: 'email', mailClient: { sendMail } });
      expect(sendMail).toHaveBeenCalledTimes(1);
    } catch (error) {
      throw new Error(`REL-06 失败：${error.message}`, { cause: error });
    }
  });

  test('REL-08：SMTP永久鉴权失败暂停邮件并仅向健康企微登记一次备用通知', async () => {
    try {
      await enroll(await alert());
      const sendMail = jest.fn().mockRejectedValue(
        Object.assign(new Error('synthetic auth rejected'), {
          code: 'EAUTH',
          responseCode: 535,
          command: 'AUTH',
        })
      );
      await sender.processOne(now, { channel: 'email', mailClient: { sendMail } });
      const setting = await models.MonitorNotificationChannel.findByPk('email');
      expect(setting.pausedReason).toBe('SMTP_REJECTED');
      expect(
        (await models.MonitorNotificationDelivery.findOne({ where: { channel: 'email' } })).status
      ).toBe('failed');
      await sender.processOne(now, { channel: 'email', mailClient: { sendMail } });
      expect(sendMail).toHaveBeenCalledTimes(1);
      const notices = await models.MonitorNotificationEvent.findAll({
        where: { channel: 'wecom', 'payload.systemNotice': true },
      });
      expect(notices).toHaveLength(1);
      expect(notices[0].payload.title).toContain('邮件监控通道');
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      await sender.processOne(now, { channel: 'wecom', send });
      now = new Date(+now + 5000);
      await sender.processOne(now, { channel: 'wecom', send });
      expect(
        send.mock.calls.filter(([, message]) => message.includes('邮件监控通道'))
      ).toHaveLength(1);
      await configure('email', { enabled: false });
      await configure('email', { enabled: true });
      expect((await models.MonitorNotificationChannel.findByPk('email')).pausedReason).toBeNull();
    } catch (error) {
      throw new Error(`REL-08 失败：${error.message}`, { cause: error });
    }
  });

  test('TIME-05：多个过期不同告警恢复仅重建同通道目标一份当前摘要', async () => {
    try {
      for (let index = 0; index < 3; index++) await enroll(await alert());
      now = new Date(+now + 11 * MINUTE_MS);
      await observe();
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      for (let index = 0; index < 3; index++)
        await sender.processOne(now, { channel: 'wecom', send });
      const summaries = await models.MonitorNotificationDelivery.findAll({
        where: { channel: 'wecom', category: 'summary', status: 'pending' },
      });
      expect(send).not.toHaveBeenCalled();
      expect(summaries).toHaveLength(1);
      expect(
        await models.MonitorNotificationEvent.count({
          where: { deliveryId: summaries[0].id },
        })
      ).toBe(3);
    } catch (error) {
      throw new Error(`TIME-05 失败：${error.message}`, { cause: error });
    }
  });

  test('TIME-06：前100个邮件活动关联不会饿死第101个已恢复关联', async () => {
    try {
      const channel = await models.MonitorNotificationChannel.findByPk('email');
      const fixtures = Array.from({ length: 101 }, (_, index) => ({
        ruleId: randomUUID(),
        alertId: randomUUID(),
        index,
      }));
      await models.MonitorRule.bulkCreate(
        fixtures.map(item => ({
          id: item.ruleId,
          version: 1,
          config: { enabled: true, severity: 'warning' },
        }))
      );
      await models.MonitorAlert.bulkCreate(
        fixtures.map(item => ({
          id: item.alertId,
          instanceId: instance.id,
          ruleId: item.ruleId,
          ruleVersion: 1,
          ruleName: '合成恢复调度规则',
          severity: 'warning',
          status: item.index === 100 ? 'recovered' : 'active',
          firstSeenAt: now,
          lastSeenAt: now,
          recoveredAt: item.index === 100 ? now : null,
        }))
      );
      await models.MonitorNotificationLink.bulkCreate(
        fixtures.map(item => ({
          id: randomUUID(),
          alertId: item.alertId,
          channel: 'email',
          targetVersion: channel.targetVersion,
          initialStatus: 'accepted',
          reminderSequence: 0,
          nextReminderAt: null,
          recoveryQueuedAt: null,
          createdAt: new Date(+now - 1000 + item.index),
          updatedAt: new Date(+now - 1000 + item.index),
        }))
      );
      await scheduler.scheduleTick(now);
      await scheduler.scheduleTick(new Date(+now + MINUTE_MS));
      expect(
        await models.MonitorNotificationDelivery.count({
          where: { channel: 'email', category: 'recovery' },
        })
      ).toBe(1);
    } catch (error) {
      throw new Error(`TIME-06 失败：${error.message}`, { cause: error });
    }
  });

  test('RET-01：清理不删除活动告警／待发／未知及同事件原接受关联', async () => {
    try {
      const retention = require('../src/services/monitorNotificationRetention');
      const old = new Date(+now - 100 * 86400000);
      const recovered = await alert();
      await models.MonitorAlert.update(
        {
          status: 'recovered',
          recoveredAt: old,
          lastSeenAt: old,
        },
        { where: { id: recovered.alertId } }
      );
      const active = await alert();
      const target = await models.MonitorNotificationChannel.findByPk('wecom');
      const fixture = async (status, payload) => {
        try {
          const row = await models.MonitorNotificationDelivery.create({
            id: randomUUID(),
            channel: 'wecom',
            targetVersion: target.targetVersion,
            policyVersion: target.policyVersion,
            category: payload ? 'alert' : 'test',
            severity: 'critical',
            status,
            notBefore: old,
            createdAt: old,
            updatedAt: old,
            completedAt: ['accepted', 'skipped', 'failed'].includes(status) ? old : null,
            recipientSnapshot: [],
            version: 1,
          });
          if (payload)
            await models.MonitorNotificationEvent.create({
              id: randomUUID(),
              deliveryId: row.id,
              sourceKey: `retention:${randomUUID()}`,
              eventKey: `retention:${randomUUID()}`,
              channel: 'wecom',
              targetVersion: target.targetVersion,
              payload,
              outcome: 'included',
            });
          return row;
        } catch (error) {
          throw new Error('独立保留期合成投递准备失败', { cause: error });
        }
      };
      const acceptedDependency = await fixture('accepted', recovered);
      const unknown = await fixture('unknown', recovered);
      const activeDependency = await fixture('accepted', active);
      const pending = await fixture('pending');
      const disposable = await fixture('accepted');
      await models.MonitorNotificationLink.create({
        id: randomUUID(),
        alertId: recovered.alertId,
        channel: 'wecom',
        targetVersion: target.targetVersion,
        initialStatus: 'accepted',
        reminderSequence: 0,
        createdAt: old,
        updatedAt: old,
      });
      const result = await retention.cleanup(now);
      expect(await models.MonitorNotificationDelivery.findByPk(disposable.id)).toBeNull();
      for (const row of [acceptedDependency, unknown, activeDependency, pending])
        expect(await models.MonitorNotificationDelivery.findByPk(row.id)).not.toBeNull();
      expect(
        await models.MonitorNotificationLink.count({ where: { alertId: recovered.alertId } })
      ).toBe(1);
      expect(Object.values(result).every(value => value <= 1000)).toBe(true);
    } catch (error) {
      throw new Error(`RET-01 失败：${error.message}`, { cause: error });
    }
  });

  test('RET-02：2050条终态每轮最多删除1000条，返回计数与提交结果一致', async () => {
    try {
      const retention = require('../src/services/monitorNotificationRetention');
      const old = new Date(+now - 100 * 86400000);
      await models.MonitorNotificationDelivery.bulkCreate(
        Array.from({ length: 2050 }, () => ({
          id: randomUUID(),
          channel: 'wecom',
          targetVersion: 1,
          policyVersion: 1,
          category: 'test',
          severity: 'info',
          status: 'accepted',
          notBefore: old,
          completedAt: old,
          createdAt: old,
          updatedAt: old,
        }))
      );
      const first = await retention.cleanup(now);
      expect(first.deliveries).toBe(1000);
      expect(await models.MonitorNotificationDelivery.count()).toBe(1050);
      const second = await retention.cleanup(now);
      expect(second.deliveries).toBe(1000);
      expect(await models.MonitorNotificationDelivery.count()).toBe(50);
      const metrics = await models.NotificationWorkerState.findByPk('cleanup');
      expect(metrics.details.counts.deliveries).toBe(1000);
      expect(metrics.details.oldestRemainingAt).toBeTruthy();
    } catch (error) {
      throw new Error(`RET-02 失败：${error.message}`, { cause: error });
    }
  });

  test('RET-03：真实SQL慢删除共享五秒总预算，超时全回滚不报告已删除', async () => {
    const db = models.sequelize;
    try {
      const retention = require('../src/services/monitorNotificationRetention');
      const old = new Date(+now - 200 * 86400000);
      const delivery = await models.MonitorNotificationDelivery.create({
        id: randomUUID(),
        channel: 'wecom',
        category: 'test',
        severity: 'info',
        status: 'accepted',
        notBefore: old,
        completedAt: old,
        createdAt: old,
        updatedAt: old,
      });
      const audit = await models.OperationLog.create({
        actorUserId: actor.id,
        action: '合成慢清理',
        target: '独立数据库',
        method: 'GET',
        statusCode: 200,
        result: 'success',
        requestId: randomUUID(),
        createdAt: old,
      });
      await db.query(`CREATE FUNCTION independent_cleanup_delay() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN OLD; END $$;
        CREATE TRIGGER independent_cleanup_delay BEFORE DELETE ON monitor_notification_deliveries
          FOR EACH ROW EXECUTE FUNCTION independent_cleanup_delay();
        CREATE TRIGGER independent_cleanup_delay BEFORE DELETE ON operation_logs
          FOR EACH ROW EXECUTE FUNCTION independent_cleanup_delay();`);
      const started = Date.now();
      await expect(retention.cleanup(now)).rejects.toThrow();
      const elapsedMs = Date.now() - started;
      expect(elapsedMs).toBeLessThan(5200);
      expect(await models.MonitorNotificationDelivery.findByPk(delivery.id)).not.toBeNull();
      expect(await models.OperationLog.findByPk(audit.id)).not.toBeNull();
      const metrics = await models.NotificationWorkerState.findByPk('cleanup');
      expect(metrics.errorCode).toBe('CLEANUP_BUDGET_EXHAUSTED');
      expect(metrics.details).toMatchObject({
        rolledBack: true,
        budgetExhausted: true,
        counts: {},
      });
    } catch (error) {
      throw new Error(`RET-03 失败：${error.message}`, { cause: error });
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS independent_cleanup_delay ON monitor_notification_deliveries;
        DROP TRIGGER IF EXISTS independent_cleanup_delay ON operation_logs;
        DROP FUNCTION IF EXISTS independent_cleanup_delay();`);
    }
  }, 10000);

  test('PERF-01：205条同毫秒记录游标无重漏，最大100条且查询次数固定不读日志正文', async () => {
    const db = models.sequelize;
    const priorLogging = db.options.logging;
    try {
      const queries = require('../src/services/monitorNotificationQueries');
      const ids = Array.from({ length: 205 }, () => randomUUID());
      await models.MonitorNotificationDelivery.bulkCreate(
        ids.map(id => ({
          id,
          channel: 'wecom',
          category: 'test',
          severity: 'info',
          status: 'pending',
          notBefore: now,
          createdAt: now,
          updatedAt: now,
        }))
      );
      const statements = [];
      db.options.logging = sql => statements.push(sql);
      const seen = [];
      let cursor;
      do {
        const page = await queries.deliveries({ limit: 100, ...(cursor ? { cursor } : {}) });
        expect(page.rows.length).toBeLessThanOrEqual(100);
        seen.push(...page.rows.map(row => row.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(ids.length);
      expect(seen.sort()).toEqual([...ids].sort());
      expect(statements.length).toBeLessThanOrEqual(6);
      expect(statements.join('\n')).not.toMatch(/monitor_log_entries|monitor_log_blocks/);
      await expect(queries.deliveries({ limit: 101 })).rejects.toThrow();
    } catch (error) {
      throw new Error(`PERF-01 失败：${error.message}`, { cause: error });
    } finally {
      db.options.logging = priorLogging;
    }
  });

  test('SEC-01：超长多字节纯文本摘要不超过2048字节，名称不能注入外链或提及', () => {
    const content = require('../src/services/monitorNotificationContent');
    const message = content.build(
      { category: 'alert' },
      Array.from({ length: 100 }, () => ({
        alertId: randomUUID(),
        deviceName: '服务器'.repeat(50),
        instanceLabel: '<@all> [点击](https://evil.example.test) password=synthetic-secret',
        ruleName: '合成规则'.repeat(25),
        hitCount: 2,
        at: now,
      }))
    );
    expect(Buffer.byteLength(message.text, 'utf8')).toBeLessThanOrEqual(content.MAX_BYTES);
    expect(message.text).not.toMatch(/evil\.example|<@|synthetic-secret/);
    expect(message.text).toContain('https://monitor.example.test/server-monitor');
    expect(message.text).not.toMatch(/^\s*###/m);
    expect(message.text).not.toMatch(/\[[^\]]+\]\(https:\/\//);
    expect(message.text).toContain('服务器：');
    expect(message.text).toContain('事件：');
    expect(message.text).toContain('其余');
  });
});
