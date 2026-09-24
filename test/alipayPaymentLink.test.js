jest.mock('../src/models', () => ({
  AosRecord: { findAll: jest.fn() },
  Order: { findByPk: jest.fn() },
  PaymentTask: { findByPk: jest.fn(), findOne: jest.fn() },
  PaymentTaskEvent: { create: jest.fn() },
  sequelize: { transaction: jest.fn() },
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const models = require('../src/models');
const { buildAosLine } = require('./fixtures/aosRecords');
const {
  validateAlipayPaymentLink,
  findOrderAlipayPaymentLink,
  getDispatchAlipayPaymentLink,
  getOwnAlipayPaymentLink,
} = require('../src/services/alipayPaymentLinkService');

const order = {
  id: 101,
  orderNumber: 'W9900000001',
  appleId: 'account@example.com',
  orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W9900000001/contact%40example.com',
  orderDate: new Date('2026-09-24T12:38:23.000Z'),
  paymentMethod: '支付宝',
  sourceSnapshot: { paymentMethod: '支付宝' },
};

function makeAlipayLink(overrides = {}) {
  const values = new Map([
    ['app_id', 'synthetic-app-id'],
    [
      'biz_content',
      JSON.stringify({
        ['out_trade_no']: order.orderNumber,
        ['product_code']: 'FAST_INSTANT_TRADE_PAY',
        subject: `${order.orderNumber}-synthetic`,
        ['timeout_express']: '30m',
        ['total_amount']: '1.00',
      }),
    ],
    ['charset', 'utf-8'],
    ['method', 'alipay.trade.page.pay'],
    ['notify_url', 'https://example.test/notify'],
    ['return_url', 'https://example.test/return'],
    ['sign', 'synthetic-signature'],
    ['sign_type', 'RSA2'],
    ['timestamp', '2026-09-24 20:38:10'],
    ['version', '1.0'],
  ]);
  for (const [key, value] of Object.entries(overrides)) values.set(key, value);
  const params = new URLSearchParams(values);
  return `https://openapi.alipay.com/gateway.do?${params}`;
}

function source(link = makeAlipayLink(), overrides = {}) {
  const rawLine = buildAosLine({
    0: order.orderNumber,
    2: order.appleId,
    11: '支付宝',
    13: order.orderUrl,
    14: '2026-09-24 20:38:23.000',
    16: link,
    ...overrides,
  });
  return {
    id: 'synthetic-record-id',
    payload: { rawLine },
    receivedAt: new Date('2026-09-24T12:38:30.000Z'),
    payloadHash: 'a'.repeat(64),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  models.sequelize.transaction.mockImplementation(work => work({ LOCK: { SHARE: 'SHARE' } }));
});

test('只接受身份匹配的支付宝网关签名链接', () => {
  const link = makeAlipayLink();
  expect(validateAlipayPaymentLink(link, order.orderNumber, order.orderDate)).toBe(link);
  expect(() =>
    validateAlipayPaymentLink(
      link.replace('openapi.alipay.com', 'example.com'),
      order.orderNumber,
      order.orderDate
    )
  ).toThrow('支付宝付款链接来源无效');
  expect(() =>
    validateAlipayPaymentLink(
      makeAlipayLink({
        ['biz_content']: JSON.stringify({ ['out_trade_no']: 'W9900000099' }),
      }),
      order.orderNumber,
      order.orderDate
    )
  ).toThrow('支付宝付款链接与订单身份不一致');
  expect(() =>
    validateAlipayPaymentLink(
      makeAlipayLink({ timestamp: '2026-09-24 21:38:10' }),
      order.orderNumber,
      order.orderDate
    )
  ).toThrow('支付宝付款链接与订单身份不一致');
});

test('从 succeeded 或 duplicate 关联原文第 17 列读取支付宝链接', async () => {
  const link = makeAlipayLink();
  models.AosRecord.findAll.mockResolvedValue([
    source('https://example.com/not-allowed'),
    source(link),
  ]);
  await expect(findOrderAlipayPaymentLink(order)).resolves.toBe(link);
  expect(models.AosRecord.findAll).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: ['succeeded', 'duplicate'],
      }),
    })
  );
});

test('非支付宝订单不读取 AOS 原文', async () => {
  await expect(
    findOrderAlipayPaymentLink({ ...order, paymentMethod: '微信', sourceSnapshot: null })
  ).resolves.toBeNull();
  expect(models.AosRecord.findAll).not.toHaveBeenCalled();
});

test('调度读取与访问审计同事务完成，审计不保存链接', async () => {
  const link = makeAlipayLink();
  const task = { id: 8, orderId: order.id, processingStatus: 'pending' };
  models.PaymentTask.findByPk.mockResolvedValue(task);
  models.Order.findByPk.mockResolvedValue(order);
  models.AosRecord.findAll.mockResolvedValue([source(link)]);
  models.PaymentTaskEvent.create.mockResolvedValue({});
  await expect(getDispatchAlipayPaymentLink(task.id, 3)).resolves.toMatchObject({
    paymentUrl: link,
  });
  const event = models.PaymentTaskEvent.create.mock.calls[0][0];
  expect(event).toMatchObject({
    paymentTaskId: task.id,
    actorUserId: 3,
    eventType: 'payment_link_accessed',
    details: { source: 'payment_dispatch', linkType: 'aos_alipay' },
  });
  expect(JSON.stringify(event)).not.toContain(link);
});

test('本人付款任务同时校验归属并区分访问来源', async () => {
  const link = makeAlipayLink();
  const task = { id: 8, orderId: order.id, assigneeUserId: 3, processingStatus: 'pending' };
  models.PaymentTask.findOne.mockResolvedValue(task);
  models.Order.findByPk.mockResolvedValue(order);
  models.AosRecord.findAll.mockResolvedValue([source(link)]);
  models.PaymentTaskEvent.create.mockResolvedValue({});
  await expect(getOwnAlipayPaymentLink(task.id, 3)).resolves.toMatchObject({
    paymentUrl: link,
  });
  expect(models.PaymentTask.findOne).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: task.id, assigneeUserId: 3 } })
  );
  const event = models.PaymentTaskEvent.create.mock.calls[0][0];
  expect(event).toMatchObject({
    paymentTaskId: task.id,
    actorUserId: 3,
    eventType: 'payment_link_accessed',
    details: { source: 'payment_tasks', linkType: 'aos_alipay' },
  });
  expect(JSON.stringify(event)).not.toContain(link);

  models.PaymentTask.findOne.mockResolvedValue(null);
  await expect(getOwnAlipayPaymentLink(task.id, 4)).rejects.toThrow('不存在或已转派');
});

test('调度端拒绝非支付宝任务及缺失链接', async () => {
  models.PaymentTask.findByPk.mockResolvedValue({
    id: 8,
    orderId: order.id,
    processingStatus: 'pending',
  });
  models.Order.findByPk.mockResolvedValue({
    ...order,
    paymentMethod: '微信',
    sourceSnapshot: null,
  });
  await expect(getDispatchAlipayPaymentLink(8, 3)).rejects.toMatchObject({
    code: 'ALIPAY_PAYMENT_METHOD_REQUIRED',
  });
  models.Order.findByPk.mockResolvedValue(order);
  models.AosRecord.findAll.mockResolvedValue([]);
  await expect(getDispatchAlipayPaymentLink(8, 3)).rejects.toMatchObject({
    code: 'ALIPAY_PAYMENT_LINK_MISSING',
  });
});
