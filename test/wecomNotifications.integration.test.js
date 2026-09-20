const { randomUUID } = require('crypto');
const enabled = process.env.RUN_WECOM_INTEGRATION === 'true';
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/services/wecomTransport', () => ({
  ...jest.requireActual('../src/services/wecomTransport'),
  sendText: jest.fn(() => {
    throw new Error('真实发送禁止');
  }),
}));
(enabled ? describe : describe.skip)('企微通知隔离数据库和 HTTP 契约', () => {
  let models, service, sender, codes, clock, now, send, server, baseUrl;
  let sequence = 8000000000;
  const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-key-1234';
  const fixture = require('../frontend/test/fixtures/paymentQr.json');
  async function configure(body = {}) {
    try {
      const settings = await service.settings();
      return await service.saveSettings(1, {
        enabled: true,
        groupName: '测试内部群',
        webhook,
        expectedVersion: settings.version,
        ...body,
      });
    } catch (error) {
      error.testContext = 'wecom';
      throw error;
    }
  }
  async function addOrder(extra = {}) {
    try {
      sequence += 1;
      const result = await models.sequelize.transaction(async transaction => {
        const order = await models.Order.create(
          {
            orderNumber: `W${sequence}`,
            appleId: 'synthetic@example.test',
            orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/W${sequence}/synthetic@example.test`,
            products: [{ name: '测试商品', quantity: 1 }],
            tag: '测试TAG',
            paymentMethod: 'alipay',
            orderDate: now,
            status: 'pending',
            ...extra,
          },
          { transaction }
        );
        await service.enrollOrder(order, transaction);
        return order;
      });
      now = new Date(Math.max(+now, Date.now()));
      return result;
    } catch (error) {
      error.testContext = 'wecom';
      throw error;
    }
  }
  const tick = () => sender.sendNext({ clock, send });
  const delivery = order =>
    models.WecomNotificationDelivery.findOne({ where: { orderId: order.id } });
  beforeAll(async () => {
    if (process.env.DB_NAME !== 'apple_order_mgr_wecom_test_20260920' || process.env.DATABASE_URL)
      throw new Error('仅允许本轮隔离库');
    models = require('../src/models');
    await models.sequelize.query('TRUNCATE orders RESTART IDENTITY CASCADE');
    service = require('../src/services/wecomNotificationService');
    sender = require('../src/services/wecomNotificationSender');
    codes = require('../src/services/paymentCodeService');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.headers['x-test-role'])
        req.user = {
          id: 1,
          role: req.headers['x-test-role'],
          permissions: (req.headers['x-test-permissions'] || '').split(','),
        };
      next();
    });
    app.use('/api/wecom-notifications', require('../src/routes/wecomNotifications'));
    app.use((err, _req, res, _next) =>
      res
        .status(err.statusCode || 500)
        .json({ success: false, error: { code: err.code, message: err.message } })
    );
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/wecom-notifications`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    now = new Date();
    clock = () => new Date(now);
    send = jest.fn().mockResolvedValue({ status: 'accepted' });
    await models.WecomNotificationDelivery.destroy({ where: {} });
    await models.WecomNotificationSetting.update(
      {
        enabled: false,
        webhookCipher: null,
        destinationId: randomUUID(),
        version: 1,
        enabledAt: null,
        nextSendAt: null,
        pausedReason: null,
      },
      { where: { id: 1 } }
    );
    await configure();
  });
  test('迁移 up/down 可逆且默认关闭', async () => {
    const migration = require('../migrations/20260920000004-add-wecom-notifications');
    const qi = models.sequelize.getQueryInterface();
    await migration.down(qi);
    await migration.up(qi, models.Sequelize);
    expect((await service.settings()).enabled).toBe(false);
  });
  test('默认关闭不登记，已有订单启用后不补发', async () => {
    await configure({ enabled: false });
    const order = await addOrder();
    expect(await delivery(order)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 5));
    await configure();
    await models.sequelize.transaction(tx => service.enrollOrder(order, tx));
    expect(await delivery(order)).toBeNull();
  });
  test('新单同事务登记去重，回滚不残留', async () => {
    const order = await addOrder();
    await models.sequelize.transaction(tx => service.enrollOrder(order, tx));
    expect(await models.WecomNotificationDelivery.count()).toBe(1);
    await expect(
      models.sequelize.transaction(async transaction => {
        const other = await models.Order.create(
          {
            orderNumber: `W${++sequence}`,
            orderDate: now,
            products: [{ name: 'test', quantity: 1 }],
          },
          { transaction }
        );
        await service.enrollOrder(other, transaction);
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    expect(await models.WecomNotificationDelivery.count()).toBe(1);
  });
  test.each(['email', 'aos'])('公共 %s 新订单入口登记通知', async source => {
    const core = require('../src/services/orderIngestionCore');
    const order = await models.sequelize.transaction(tx =>
      core.createOrderInTransaction(
        {
          orderNumber: `W${++sequence}`,
          appleId: 'synthetic@example.test',
          orderUrl: 'https://www.apple.com.cn/test',
          products: [{ name: 'test', quantity: 1 }],
          recipient: { name: '合成人员', tag: '测试TAG' },
          orderDate: now,
        },
        tx,
        { source }
      )
    );
    expect((await delivery(order)).kind).toBe('order');
  });
  test('支付宝立即发送，记录脱敏且全局限流跨调用生效', async () => {
    const first = await addOrder();
    await addOrder();
    await tick();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await delivery(first)).status).toBe('accepted');
    expect(send.mock.calls[0][1]).toContain(' || 测试TAG || 测试商品 x 1 || 支付宝 || ');
    const history = JSON.stringify(await service.history());
    expect(history).not.toContain('vieworder');
    expect(history).not.toContain('webhook');
    now = new Date(+now + 3334);
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
  });
  test('微信等待 60 秒，到期回退原链接', async () => {
    const order = await addOrder({ paymentMethod: '微信' });
    await tick();
    expect((await delivery(order)).status).toBe('waiting');
    expect(send).not.toHaveBeenCalled();
    now = new Date(+now + 59000);
    await tick();
    expect(send).not.toHaveBeenCalled();
    now = new Date(+new Date((await delivery(order)).waitUntil));
    await tick();
    expect(send.mock.calls[0][1]).toContain(order.orderUrl);
  });
  test('二维码晚到提前发送，队列顺序不越过等码队首', async () => {
    const order = await addOrder({ paymentMethod: '微信' });
    await addOrder();
    await tick();
    now = new Date(+now + 3001);
    jest
      .spyOn(codes, 'findOrderPaymentCode')
      .mockResolvedValue({ payload: { imageDataUrl: fixture.valid } });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain(fixture.payload);
    expect((await delivery(order)).status).toBe('accepted');
  });
  test.each([
    { paymentStatus: 'paid' },
    { paymentStatus: 'refunded' },
    { status: 'cancelled' },
    { orderDate: new Date(Date.now() - 31 * 60000) },
  ])('发送前跳过无效订单 %j', async extra => {
    const order = await addOrder(extra);
    await tick();
    expect((await delivery(order)).status).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });
  test('内容准备期间订单付款，临发复核阻止发送', async () => {
    const order = await addOrder({ paymentMethod: '微信' });
    jest.spyOn(codes, 'findOrderPaymentCode').mockImplementation(async () => {
      await order.update({ paymentStatus: 'paid' });
      return { payload: { imageDataUrl: fixture.valid } };
    });
    await tick();
    expect(send).not.toHaveBeenCalled();
    expect((await delivery(order)).status).toBe('skipped');
  });
  test('并发 Worker 只领取并发送一次', async () => {
    await addOrder();
    await Promise.all([tick(), tick(), tick()]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  test('内容准备期间停用，不再发送', async () => {
    const order = await addOrder({ paymentMethod: '微信' });
    jest.spyOn(codes, 'findOrderPaymentCode').mockImplementation(async () => {
      await configure({ enabled: false });
      return { payload: { imageDataUrl: fixture.valid } };
    });
    await tick();
    expect(send).not.toHaveBeenCalled();
    expect((await delivery(order)).status).toBe('skipped');
  });
  test('在途失败与停用并发，不复活队列', async () => {
    const order = await addOrder();
    send.mockImplementation(async () => {
      await configure({ enabled: false });
      return { status: 'pending', errorCode: 'CONNECT_FAILED', retryMs: 10000 };
    });
    await tick();
    expect((await delivery(order)).status).toBe('skipped');
  });
  test('明确连接失败最多自动尝试 3 次', async () => {
    const order = await addOrder();
    send.mockResolvedValue({ status: 'pending', errorCode: 'CONNECT_FAILED', retryMs: 10000 });
    for (let i = 0; i < 4; i++) {
      await tick();
      now = new Date(+now + 11000);
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect((await delivery(order)).status).toBe('failed');
  });
  test('未知结果不自动重发，人工确认与版本保护', async () => {
    const order = await addOrder();
    send.mockResolvedValue({ status: 'unknown', errorCode: 'TRANSPORT_UNKNOWN' });
    await tick();
    now = new Date(+now + 120000);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    const row = await delivery(order);
    await expect(service.retry(1, row.id, { expectedVersion: row.version })).rejects.toThrow(
      '核对'
    );
    await service.retry(1, row.id, { expectedVersion: row.version, acknowledgeUnknown: true });
    await expect(
      service.retry(1, row.id, { expectedVersion: row.version, acknowledgeUnknown: true })
    ).rejects.toThrow('已更新');
  });
  test('租约恢复区分未开始与已经开始发送', async () => {
    const order = await addOrder();
    const row = await delivery(order);
    await row.update({
      status: 'sending',
      leaseToken: randomUUID(),
      leaseUntil: new Date(+now - 1),
      dispatchStartedAt: new Date(+now - 1000),
    });
    await tick();
    expect((await delivery(order)).status).toBe('unknown');
    expect(send).not.toHaveBeenCalled();
    await row.reload();
    await row.update({
      status: 'sending',
      leaseToken: randomUUID(),
      leaseUntil: new Date(+now - 1),
      dispatchStartedAt: null,
    });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });
  test('配置加密、版本冲突、更换目标需停用且不迁移旧任务', async () => {
    const settings = await service.settings();
    const raw = await models.WecomNotificationSetting.findByPk(1);
    expect(raw.webhookCipher).toMatch(/^enc:/);
    expect(JSON.stringify(settings)).not.toContain('synthetic-key');
    await expect(configure({ expectedVersion: 1 })).rejects.toThrow('已更新');
    await expect(configure({ webhook: webhook.replace('1234', '9999') })).rejects.toThrow('先停用');
    const order = await addOrder();
    await configure({ enabled: false });
    const changed = await configure({ enabled: false, webhook: webhook.replace('1234', '9999') });
    expect(changed.destinationId).not.toBe(settings.destinationId);
    expect((await delivery(order)).status).toBe('skipped');
  });
  test('配置错误暂停发送，重新保存恢复', async () => {
    await addOrder();
    await addOrder();
    send.mockResolvedValue({ status: 'failed', errorCode: 'WEBHOOK_REJECTED', pause: true });
    await tick();
    now = new Date(+now + 10000);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await service.settings()).pausedReason).toBe('WEBHOOK_REJECTED');
    await configure();
    expect((await service.settings()).pausedReason).toBeNull();
  });
  test('关闭自动通知也可测试；测试幂等并共用配额', async () => {
    const settings = await configure({ enabled: false });
    const body = { expectedVersion: settings.version, idempotencyKey: randomUUID() };
    const a = await service.queueTest(1, body),
      b = await service.queueTest(1, body);
    expect(a.id).toBe(b.id);
    now = new Date();
    await tick();
    expect(send.mock.calls[0][1]).toBe(sender.TEST_MESSAGE);
  });
  test('配置和重试 HTTP 权限独立，不向普通用户开放', async () => {
    const request = (route, role, permissions, method = 'GET', body) =>
      fetch(baseUrl + route, {
        method,
        headers: {
          ...(role ? { 'x-test-role': role } : {}),
          'x-test-permissions': permissions,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect((await request('/settings', null, '')).status).toBe(401);
    expect(
      (await request('/settings', 'operator', 'wecom.read,wecom.configure,wecom.retry')).status
    ).toBe(403);
    expect((await request('/settings', 'admin', 'orders.read')).status).toBe(403);
    const read = await request('/settings', 'admin', 'wecom.read');
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await read.json())).not.toContain('synthetic-key');
    expect((await request('/settings', 'admin', 'wecom.read', 'PUT', {})).status).toBe(403);
    expect((await request('/test', 'admin', 'wecom.read', 'POST', {})).status).toBe(403);
    expect(
      (await request('/deliveries/' + randomUUID() + '/retry', 'admin', 'wecom.read', 'POST', {}))
        .status
    ).toBe(403);
  });
});
