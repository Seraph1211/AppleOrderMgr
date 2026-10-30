const crypto = require('crypto');
jest.mock('../src/models', () => ({
  OrderPaymentCode: { findOne: jest.fn() },
  AosRecord: { findAll: jest.fn() },
  Order: { findByPk: jest.fn() },
  PaymentTask: { findOne: jest.fn() },
  PaymentTaskEvent: { create: jest.fn() },
  sequelize: { transaction: jest.fn() },
}));
jest.mock('../src/utils/logger', () => ({ debug: jest.fn() }));
jest.mock('../src/services/orderAccessService', () => ({ assertCurrentOrderAccess: jest.fn() }));
const {
  OrderPaymentCode,
  AosRecord,
  Order,
  PaymentTask,
  PaymentTaskEvent,
  sequelize,
} = require('../src/models');
const { assertCurrentOrderAccess } = require('../src/services/orderAccessService');
const {
  findOrderPaymentCode,
  getPaymentCode,
  receivePaymentCodes,
} = require('../src/services/paymentCodeService');
const { makePng } = require('./fixtures/paymentCode');
const { buildAosLine } = require('./fixtures/aosRecords');
const { validatePaymentPng } = require('../src/services/paymentCodeValidation');
const order = {
  id: 189,
  orderNumber: 'W9900000001',
  appleId: 'account@example.com',
  orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W9900000001/contact%40example.com',
  orderDate: new Date('2026-09-10T02:00:00.123Z'),
  paymentMethod: 'WECHAT',
};
const transaction = {};
function source(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    payload: { rawLine: buildAosLine({ 16: makePng(), ...overrides }) },
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  OrderPaymentCode.findOne.mockResolvedValue(null);
  AosRecord.findAll.mockResolvedValue([source()]);
});
test.each(['招行12期', '微信分付12期', '微信分付24期', 'VISA'])(
  '来源 %s 即使遗留已关联微信码也不读取',
  async paymentMethod => {
    const result = await findOrderPaymentCode(
      { ...order, sourceSnapshot: { paymentMethod } },
      transaction
    );
    expect(result).toBeNull();
    expect(OrderPaymentCode.findOne).not.toHaveBeenCalled();
    expect(AosRecord.findAll).not.toHaveBeenCalled();
  }
);

test('招行24期从来源原文读取，绝不读取历史独立微信码', async () => {
  AosRecord.findAll.mockResolvedValue([source({ 11: '招行24期' })]);
  const result = await findOrderPaymentCode(
    { ...order, sourceSnapshot: { paymentMethod: '招行24期' } },
    transaction
  );
  expect(result.payload.paymentMethod).toBe('招行24期');
  expect(result.payload.imageDataUrl).toBe(makePng());
  expect(result.sourceTime).toBe('2026-09-10T02:00:00.123Z');
  expect(OrderPaymentCode.findOne).not.toHaveBeenCalled();
});

test.each([
  ['遗留微信原文', { 11: '微信' }],
  ['其他分期', { 11: '招行12期' }],
  ['其他银行', { 11: '工行24期' }],
  ['异账号', { 11: '招行24期', 2: 'other@example.com' }],
  [
    '异联系邮箱',
    {
      11: '招行24期',
      1: 'other@example.com',
      13: 'https://www.apple.com.cn/xc/cn/vieworder/W9900000001/other@example.com',
    },
  ],
  ['异日期', { 11: '招行24期', 14: '2026-09-11 10:00:00.123' }],
  [
    '异订单',
    {
      11: '招行24期',
      0: 'W9900000002',
      13: 'https://www.apple.com.cn/xc/cn/vieworder/W9900000002/contact@example.com',
    },
  ],
  ['缺码', { 11: '招行24期', 16: '' }],
  ['坏图', { 11: '招行24期', 16: 'data:image/png;base64,aGVsbG8=' }],
])('招行24期拒绝%s，不回退独立微信码', async (_label, fields) => {
  OrderPaymentCode.findOne.mockResolvedValue({ payload: { imageDataUrl: makePng() } });
  AosRecord.findAll.mockResolvedValue([source(fields)]);
  expect(
    await findOrderPaymentCode({ ...order, paymentMethod: '招行24期' }, transaction)
  ).toBeNull();
  expect(OrderPaymentCode.findOne).not.toHaveBeenCalled();
});

test('微信订单不能误挂招行24期原文码', async () => {
  AosRecord.findAll.mockResolvedValue([source({ 11: '招行24期' })]);
  expect(await findOrderPaymentCode(order, transaction)).toBeNull();
});

test.each([true, false])(
  '招行码按本人／调度范围读取，终态保留来源方式与图片（own=%s）',
  async own => {
    const tx = { LOCK: { SHARE: 'SHARE' } };
    sequelize.transaction.mockImplementation(callback => callback(tx));
    PaymentTask.findOne.mockResolvedValue({
      id: 91,
      orderId: order.id,
      processingStatus: 'completed',
    });
    Order.findByPk.mockResolvedValue({
      ...order,
      emailOrderStatus: 'cancelled',
      sourceSnapshot: { paymentMethod: '招行24期' },
    });
    AosRecord.findAll.mockResolvedValue([source({ 11: '招行24期' })]);
    const result = await getPaymentCode(91, 3, own);
    expect(PaymentTask.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 91, ...(own ? { assigneeUserId: 3 } : {}) } })
    );
    expect(assertCurrentOrderAccess).toHaveBeenCalledWith(3, [order.id], { transaction: tx });
    expect(result).toMatchObject({
      availability: 'available',
      paymentMethod: '招行24期',
      emailOrderStatus: 'cancelled',
      imageDataUrl: makePng(),
    });
    expect(PaymentTaskEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'payment_code_accessed', details: {} }),
      { transaction: tx }
    );
  }
);

test('招行任务转派或 TAG 撤权后不得返回图片', async () => {
  const tx = { LOCK: { SHARE: 'SHARE' } };
  sequelize.transaction.mockImplementation(callback => callback(tx));
  PaymentTask.findOne.mockResolvedValue(null);
  await expect(getPaymentCode(91, 3)).rejects.toMatchObject({ statusCode: 404 });
  expect(AosRecord.findAll).not.toHaveBeenCalled();
  PaymentTask.findOne.mockResolvedValue({ id: 91, orderId: order.id });
  assertCurrentOrderAccess.mockRejectedValueOnce(new Error('TAG access denied'));
  await expect(getPaymentCode(91, 3)).rejects.toThrow('TAG access denied');
  expect(AosRecord.findAll).not.toHaveBeenCalled();
});

test('独立设备上传仍不接收招行分期，来源只读扩展不改变采集协议', async () => {
  const result = await receivePaymentCodes('synthetic-device', {
    records: [
      { eventId: crypto.randomUUID(), orderNumber: order.orderNumber, paymentMethod: '招行24期' },
    ],
  });
  expect(result.results[0]).toMatchObject({ receiptStatus: 'rejected', retryable: false });
});
test('17 列订单直接返回有效图片，来源时间保留原文下单时间', async () => {
  const result = await findOrderPaymentCode(order, transaction);
  expect(result.payload.imageDataUrl).toBe(makePng());
  expect(result.sourceTime).toBe('2026-09-10T02:00:00.123Z');
  expect(AosRecord.findAll).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { orderId: 189, orderNumber: order.orderNumber, status: ['succeeded', 'duplicate'] },
      transaction,
    })
  );
});
test.each([
  ['旧 15 列', buildAosLine().split('\t').slice(0, 15).join('\t')],
  ['旧 16 列', buildAosLine()],
  ['空图', buildAosLine({ 16: '' })],
  ['链接', buildAosLine({ 16: 'https://example.com' })],
  ['坏图', buildAosLine({ 16: 'data:image/png;base64,aGVsbG8=' })],
  ['坏订单日期', buildAosLine({ 14: 'bad-date', 16: makePng() })],
  ['支付宝', buildAosLine({ 11: '支付宝', 16: makePng() })],
])('%s 不误取图片', async (_name, rawLine) => {
  AosRecord.findAll.mockResolvedValue([{ ...source(), payload: { rawLine } }]);
  expect(await findOrderPaymentCode(order, transaction)).toBeNull();
});
test.each([
  ['异账号', { 2: 'other@example.com' }],
  [
    '异联系邮箱',
    {
      1: 'other@example.com',
      13: 'https://www.apple.com.cn/xc/cn/vieworder/W9900000001/other@example.com',
    },
  ],
  ['异业务日期', { 14: '2026-09-11 10:00:00.123' }],
  [
    '异订单号',
    {
      0: 'W9900000002',
      13: 'https://www.apple.com.cn/xc/cn/vieworder/W9900000002/contact@example.com',
    },
  ],
])('%s 原文拒绝挂码', async (_name, fields) => {
  AosRecord.findAll.mockResolvedValue([source(fields)]);
  expect(await findOrderPaymentCode(order, transaction)).toBeNull();
});
test('原文晚到不覆盖独立来源的新码，坏图也不影响已有码', async () => {
  const latest = {
    sourceTime: '2026-09-10T02:01:00.123Z',
    imageHash: validatePaymentPng(makePng(1)),
    payload: { imageDataUrl: makePng(1) },
  };
  OrderPaymentCode.findOne.mockResolvedValue(latest);
  AosRecord.findAll.mockResolvedValue([source(), source({ 16: 'data:image/png;base64,AAAA' })]);
  expect(await findOrderPaymentCode(order, transaction)).toBe(latest);
});
test('同时间不同图片按摘要选择，重复及到达顺序不改变结果', async () => {
  const images = [makePng(), makePng(1)].sort((a, b) =>
    validatePaymentPng(a).localeCompare(validatePaymentPng(b))
  );
  const rows = images.map(imageDataUrl => source({ 16: imageDataUrl }));
  AosRecord.findAll.mockResolvedValue([...rows, rows[0]]);
  expect((await findOrderPaymentCode(order, transaction)).payload.imageDataUrl).toBe(images[1]);
  AosRecord.findAll.mockResolvedValue([...rows].reverse());
  expect((await findOrderPaymentCode(order, transaction)).payload.imageDataUrl).toBe(images[1]);
});
test('原文新码可替代独立来源旧码', async () => {
  OrderPaymentCode.findOne.mockResolvedValue({
    sourceTime: '2026-09-10T01:59:59Z',
    imageHash: validatePaymentPng(makePng(2)),
    payload: { imageDataUrl: makePng(2) },
  });
  expect((await findOrderPaymentCode(order, transaction)).payload.imageDataUrl).toBe(makePng());
});
test('数据库失败不伪装未采集', async () => {
  AosRecord.findAll.mockRejectedValue(new Error('database unavailable'));
  await expect(findOrderPaymentCode(order, transaction)).rejects.toThrow('database unavailable');
});
