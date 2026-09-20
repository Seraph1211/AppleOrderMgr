/* eslint-disable camelcase -- 隔离 PostgreSQL 原生字段核验 */
const enabled = process.env.RUN_BROWSER_DB_INTEGRATION === 'true';
jest.mock('../src/utils/telegramNotifier', () => ({ sendTelegramAlert: jest.fn() }));
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');

(enabled ? describe : describe.skip)('浏览器回传隔离数据库事务验收（不访问官网）', () => {
  let models;
  let crawler;
  let order;
  const ticketId = '7b7073d3-f152-4d77-9365-5b862bd16a77';
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_browser_test_20260920_a6f2' ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许指定隔离测试库');
    models = require('../src/models');
    crawler = require('../src/services/crawlerService');
    await models.sequelize.authenticate();
  });
  beforeEach(async () => {
    await models.sequelize.query('TRUNCATE TABLE orders RESTART IDENTITY CASCADE');
    order = await models.Order.create({
      orderNumber: 'W1234567890',
      appleId: 'synthetic@example.com',
      orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/synthetic%40example.com',
      status: 'pending',
      paymentStatus: 'unknown',
      products: [{ name: '测试手机 256GB 蓝色', quantity: 1 }],
      officialOrderAmount: '8999.00',
      officialOrderAmountCurrency: 'CNY',
    });
  });
  afterAll(async () => {
    if (models) await models.sequelize.close();
  });
  function options() {
    return {
      manual: true,
      browserTicketId: ticketId,
      expectedUpdatedAt: order.updatedAt.toISOString(),
      acquireOrderPage: () =>
        Promise.resolve({
          pageUrl: 'https://secure8.www.apple.com.cn/shop/order/guest/W1234567890/redacted',
          orderJson: buildLifecycleJson('PROCESSING'),
        }),
    };
  }

  test('实际写入状态和观测时间，保留缺失金额，并在同版本下拒绝重复票据', async () => {
    const initialVersion = order.updatedAt;
    await crawler.crawlAndUpdateOrder(order.id, options());
    const updated = await models.Order.findByPk(order.id);
    expect(updated.status).toBe('processing');
    expect(updated.paymentStatus).toBe('unknown');
    expect(updated.lastCrawledAt).toBeInstanceOf(Date);
    expect(Number(updated.officialOrderAmount)).toBe(8999);
    // 显式构造相同时间版本碰撞，验证防重放依赖审计消费而非时间精度。
    await models.sequelize.query('UPDATE orders SET updated_at = :version WHERE id = :id', {
      replacements: { version: initialVersion, id: order.id },
    });
    await expect(crawler.crawlAndUpdateOrder(order.id, options())).rejects.toMatchObject({
      eventType: 'concurrency',
    });
    expect(await models.CrawlLog.count({ where: { orderId: order.id, success: true } })).toBe(1);
    expect((await models.Order.findByPk(order.id)).crawlFailCount).toBe(0);
  });

  test('多余官网字段不改写金额门店付款与任务；最小结果仍可更新状态商品', async () => {
    await order.update({
      orderDate: new Date('2026-09-20T01:00:00Z'),
      pickupStore: '原门店', paymentMethod: '原支付方式', pickupStatus: 'unknown',
      officialOrderAmountParseError: '旧诊断',
      validationIssues: [{ type: 'source_conflict', field: 'pickupStore', message: '保留旧门店差异' }],
    });
    const task = await models.PaymentTask.create({
      orderId: order.id, deadlineAt: new Date('2026-09-20T02:00:00Z'), deadlineSource: 'manual_verified',
      processingStatus: 'completed', version: 3,
    });
    const before = task.toJSON();
    const json = buildLifecycleJson('PROCESSING');
    json.orderDetail.orderHeader.payNow = { d: { totalAmount: 'RMB 1.00' } };
    json.orderDetail.orderItems['orderItem-0000101'].orderItemDetails.d.quantity = 2;
    const result = await crawler.crawlAndUpdateOrder(order.id, {
      ...options(), acquireOrderPage: () => Promise.resolve({
        pageUrl: 'https://secure8.www.apple.com.cn/shop/order/guest/W1234567890/redacted', orderJson: json,
      }),
    });
    const updated = await order.reload();
    expect(updated.status).toBe('processing');
    expect(updated.products[0].quantity).toBe(2);
    expect(updated.paymentStatus).toBe('unknown');
    expect(updated.pickupStatus).toBe('unknown');
    expect(updated.pickupStore).toBe('原门店');
    expect(updated.paymentMethod).toBe('原支付方式');
    expect(Number(updated.officialOrderAmount)).toBe(8999);
    expect(updated.officialOrderAmountParseError).toBe('旧诊断');
    expect(updated.validationIssues).toContainEqual(expect.objectContaining({ field: 'pickupStore' }));
    expect((await task.reload()).toJSON()).toEqual(before);
    expect(result).toMatchObject({ paymentStatus: 'unknown', pickupStore: '原门店' });
    const logs = await models.CrawlLog.findAll({ where: { orderId: order.id, success: true } });
    expect(logs).toHaveLength(1);
    expect(logs[0].context.refreshScope).toBe('status_products');
  });

  test('成功审计失败时整个业务更新回滚', async () => {
    const create = jest
      .spyOn(models.CrawlLog, 'create')
      .mockRejectedValueOnce(new Error('模拟成功审计失败'));
    try {
      await expect(crawler.crawlAndUpdateOrder(order.id, options())).rejects.toThrow(
        '模拟成功审计失败'
      );
      const unchanged = await models.Order.findByPk(order.id);
      expect(unchanged.status).toBe('pending');
      expect(unchanged.lastCrawledAt).toBeNull();
      expect(await models.CrawlLog.count({ where: { orderId: order.id, success: true } })).toBe(0);
    } finally {
      create.mockRestore();
    }
  });

  test('两个并发结果只允许一次业务写入与成功审计', async () => {
    let arrivals = 0;
    let release;
    const barrier = new Promise(resolve => {
      release = resolve;
    });
    const base = options();
    const acquireOrderPage = async () => {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
      return base.acquireOrderPage();
    };
    const results = await Promise.allSettled([
      crawler.crawlAndUpdateOrder(order.id, { ...base, acquireOrderPage }),
      crawler.crawlAndUpdateOrder(order.id, { ...base, acquireOrderPage }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason.eventType).toBe(
      'concurrency'
    );
    expect(await models.CrawlLog.count({ where: { orderId: order.id, success: true } })).toBe(1);
  });

  test('十个不同订单并发回传分别落库并保留金额，每笔只有一条成功审计', async () => {
    const batch = await models.Order.bulkCreate(
      Array.from({ length: 10 }, (_, index) => ({
        orderNumber: `W${String(index + 1).padStart(10, '0')}`,
        appleId: 'synthetic@example.com',
        orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/W${String(index + 1).padStart(10, '0')}/synthetic%40example.com`,
        status: 'pending',
        paymentStatus: 'unknown',
        products: [{ name: '测试手机 256GB 蓝色', quantity: 1 }],
        officialOrderAmount: '8999.00',
        officialOrderAmountCurrency: 'CNY',
      }))
    );
    let arrivals = 0;
    let release;
    const barrier = new Promise(resolve => {
      release = resolve;
    });
    const results = await Promise.all(
      batch.map(row =>
        crawler.crawlAndUpdateOrder(row.id, {
          manual: true,
          expectedUpdatedAt: row.updatedAt.toISOString(),
          browserTicketId: require('crypto').randomUUID(),
          acquireOrderPage: async () => {
            try {
              arrivals += 1;
              if (arrivals === 10) release();
              await barrier;
              const json = buildLifecycleJson('PROCESSING');
              json.orderDetail.orderHeader.d.orderNumber = row.orderNumber;
              return {
                pageUrl: `https://secure8.www.apple.com.cn/shop/order/guest/${row.orderNumber}/redacted`,
                orderJson: json,
              };
            } catch (_error) {
              throw new Error('合成并发采集失败');
            }
          },
        })
      )
    );
    expect(results.every(result => result.success)).toBe(true);
    const updated = await models.Order.findAll({ where: { id: batch.map(row => row.id) } });
    for (const row of updated) {
      expect(row.status).toBe('processing');
      expect(row.paymentStatus).toBe('unknown');
      expect(row.lastCrawledAt).toBeInstanceOf(Date);
      expect(Number(row.officialOrderAmount)).toBe(8999);
      expect(await models.CrawlLog.count({ where: { orderId: row.id, success: true } })).toBe(1);
    }
    expect((await models.Order.findByPk(order.id)).status).toBe('pending');
  });
});
