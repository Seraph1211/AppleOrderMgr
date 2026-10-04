/* eslint-disable no-magic-numbers -- 明确身份、新鲜度及完整性边界。 */
const { validateOfficialStatusResult } = require('../src/services/officialOrderStatusSync');
const now = Date.now();
const job = { orderId: 10, orderNumber: 'W1234567890', startedAt: new Date(now - 10000) };
const valid = () => ({
  systemOrderId: 10,
  orderNumber: job.orderNumber,
  identityMatched: true,
  sourceModel: 'orderDetail',
  completeItemCount: 2,
  products: [
    { name: '设备', quantity: 1, rawStatus: 'PICKED_UP' },
    { name: '设备', quantity: 1, rawStatus: 'PICKED_UP' },
  ],
  source: {
    provider: 'Apple official website',
    status: 200,
    cached: false,
    host: 'secure6.www.apple.com.cn',
    sha256: 'a'.repeat(64),
    runId: 24,
    observedAt: new Date(now - 1000).toISOString(),
  },
});
test('仅输出状态及观测元数据，不产生商品、付款、取货写入', () => {
  const result = validateOfficialStatusResult(valid(), job, now);
  expect(Object.keys(result).sort()).toEqual(['observedAt', 'runId', 'sha256', 'status']);
  expect(result.status).toBe('PICKED_UP');
});
test('多件状态不一致原样保存，未知合法枚举不推断', () => {
  const data = valid();
  data.products[1].rawStatus = 'FUTURE_STATUS';
  data.products[1].quantity = 0;
  expect(validateOfficialStatusResult(data, job, now).status).toBe('FUTURE_STATUS | PICKED_UP');
});
test.each([
  data => {
    data.systemOrderId = 11;
  },
  data => {
    data.orderNumber = 'W1234567891';
  },
  data => {
    data.identityMatched = false;
  },
  data => {
    data.sourceModel = 'orderList';
  },
  data => {
    data.completeItemCount = 3;
  },
  data => {
    data.products = [];
  },
  data => {
    data.products[0].quantity = -1;
  },
  data => {
    data.products[0].rawStatus = '';
  },
  data => {
    data.products[0].rawStatus = '邮箱@example.test';
  },
  data => {
    data.source.status = 541;
  },
  data => {
    data.source.cached = true;
  },
  data => {
    data.source.host = 'apple.com.cn.example.test';
  },
  data => {
    data.source.sha256 = 'invalid';
  },
  data => {
    data.source.runId = -1;
  },
  data => {
    data.source.observedAt = new Date(now - 600000).toISOString();
  },
  data => {
    data.source.observedAt = new Date(now + 60000).toISOString();
  },
  data => {
    data.source.observedAt = 'invalid';
  },
  data => {
    data.source = null;
  },
])('身份、完整性、来源或时效不通过时拒绝结果 %#', change => {
  const data = valid();
  change(data);
  expect(() => validateOfficialStatusResult(data, job, now)).toThrow('官网结果不完整');
});
