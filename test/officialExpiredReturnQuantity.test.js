/* eslint-disable no-magic-numbers -- 已观察模板及数量边界的合成回归。 */
const fixture = require('./fixtures/officialExpiredReturnQuantity.json');
const { parseOfficialOrderDetail } = require('../src/services/officialOrderParser');
const { validateOfficialStatusResult } = require('../src/services/officialOrderStatusSync');
const { deriveOfficialPickupDate } = require('../src/services/officialPickupDate');
const { RETURN_STATUS, returnDecision } = require('../src/services/stockLifecycleRules');
const ORDER = 'W1234567890';
const KEY = 'orderItem-0000101';
const fresh = () => JSON.parse(JSON.stringify(fixture));
const data = value => value.orderDetail.orderItems[KEY].orderItemDetails.d;
const tracker = value => value.orderDetail.orderItems[KEY].orderItemStatusTracker.d;
const parse = value => parseOfficialOrderDetail(JSON.stringify(value), ORDER);
const now = Date.parse('2026-10-10T12:00:00Z');
const job = { orderId: 1176, orderNumber: ORDER, startedAt: new Date(now - 1000) };
const result = () => ({
  ...parse(fresh()),
  systemOrderId: job.orderId,
  source: {
    provider: 'Apple official website',
    status: 200,
    cached: false,
    host: 'secure6.www.apple.com.cn',
    sha256: 'a'.repeat(64),
    runId: 42,
    observedAt: new Date(now).toISOString(),
  },
});

test('真实结构的过期退货无退货号及关闭说明仍可解析，逐项保留原状态', () => {
  const value = fresh();
  expect(data(value)).not.toHaveProperty('returnNumber');
  expect(data(value).isReturnInstructionEnabledForDetailView).toBe(false);
  const parsed = parse(value);
  expect(parsed.products[0]).toMatchObject({
    quantity: 1,
    rawQuantity: -1,
    quantityInterpretation: 'return_expired_negative_one',
    rawStatus: 'RETURN_EXPIRED',
    pickupDateText: null,
  });
  expect(parsed.products[1]).toMatchObject({ quantity: 1, rawStatus: 'PICKED_UP' });
  expect(parsed.products[1]).not.toHaveProperty('rawQuantity');
  expect(deriveOfficialPickupDate(parsed, new Date(now))).toEqual({
    date: null,
    reason: 'NOT_ALL_ITEMS_PICKED_UP',
  });
  expect(validateOfficialStatusResult(result(), job, now)).toMatchObject({
    status: 'PICKED_UP | RETURN_EXPIRED',
    actualPickupDate: null,
    items: [{ rawQuantity: -1, quantityInterpretation: 'return_expired_negative_one' }, {}],
  });
});

test.each([-2, -3, '-1', ' -1 ', '-1.0', -1.5, null, undefined, true, {}, [], Infinity])(
  '过期状态也不得扩展未观察数量 %j',
  quantity => {
    const value = fresh();
    data(value).quantity = quantity;
    expect(() => parse(value)).toThrow('INVALID_QUANTITY');
  }
);
test.each(['RETURN_EXPIRED_UNKNOWN', 'return_expired', 'RETURN_EXPIRED ', 'RETURNED', 'PICKED_UP'])(
  '未观察状态 %s 不允许负数',
  status => {
    const value = fresh();
    tracker(value).currentStatus = status;
    expect(() => parse(value)).toThrow('INVALID_QUANTITY');
  }
);
test.each([0, 1, 2, '1'])('正常数量 %j 不产生特殊解释', quantity => {
  const value = fresh();
  data(value).quantity = quantity;
  expect(parse(value).products[0]).toMatchObject({ quantity: Number(quantity) });
  expect(parse(value).products[0]).not.toHaveProperty('quantityInterpretation');
});
test('旧STARTED规则保留独立解释，STARTED和EXPIRED互换标记被拒绝', () => {
  const value = fresh();
  tracker(value).currentStatus = 'RETURN_STARTED';
  expect(parse(value).products[0].quantityInterpretation).toBe('return_started_negative_one');
  for (const [rawStatus, quantityInterpretation] of [
    ['RETURN_STARTED', 'return_expired_negative_one'],
    ['RETURN_EXPIRED', 'return_started_negative_one'],
  ]) {
    const value = result();
    Object.assign(value.products[0], { rawStatus, quantityInterpretation });
    expect(() => validateOfficialStatusResult(value, job, now)).toThrow('官网结果不完整');
  }
});
test.each([
  { rawQuantity: '-1' },
  { rawQuantity: -2 },
  { quantity: 2 },
  { quantityInterpretation: 'unknown' },
  { quantityInterpretation: undefined },
  { rawQuantity: undefined },
  { rawStatus: 'PICKED_UP' },
])('解释与状态/数量必须完整配对 %j', change => {
  const value = result();
  Object.assign(value.products[0], change);
  expect(() => validateOfficialStatusResult(value, job, now)).toThrow('官网结果不完整');
});
test('负数兼容即使附带SN，解析及校验均不把数量解释当成设备依据', () => {
  const value = fresh();
  data(value).serialNumbers = ['A123456789'];
  expect(parse(value).products[0]).not.toHaveProperty('serialNumbers');
  const output = result();
  output.products[0].serialNumbers = ['A123456789'];
  expect(validateOfficialStatusResult(output, job, now).items[0].serialNumbers).toEqual([]);
});
test('EXPIRED不是活动退货，不将库存退库或自动恢复已退设备', () => {
  const items = validateOfficialStatusResult(result(), job, now).items;
  const hasReturn = items.some(item => item.rawStatus === RETURN_STATUS);
  expect(hasReturn).toBe(false);
  for (const state of ['in_stock', 'sold', 'registered']) {
    expect(returnDecision({ state }, { hasReturn, matched: false, ambiguous: false })).toEqual({
      lifecycleIssue: null,
    });
  }
  expect(
    returnDecision({ state: 'returned' }, { hasReturn, matched: false, ambiguous: false })
  ).toEqual({ lifecycleIssue: 'return_withdrawn' });
});
