const { execFileSync } = require('child_process');
const path = require('path');
const content = require('../src/services/wecomNotificationContent');
const fixture = require('../frontend/test/fixtures/paymentQr.json');
const { validateWebhook, sendText } = require('../src/services/wecomTransport');
jest.mock('axios', () => ({ post: jest.fn() }));
const axios = require('axios');
const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-key-1234';
const order = {
  id: 335,
  tag: '广州 刘炎',
  products: [{ name: 'iPhone 17 黑色 256G', quantity: 1 }],
  paymentMethod: '微信',
  orderDate: '2026-09-19T19:51:00.000Z',
};
test('消息仅增加完整 TAG，截止时间与现有复制保持一致', () => {
  expect(content.buildNotificationText(order, fixture.payload)).toBe(
    `335 || 广州 刘炎 || iPhone 17 黑色 256G x 1 || 微信 || 26/09/20 04:21 || ${fixture.payload}`
  );
  const script = `import {buildPaymentCopyText} from ${JSON.stringify(path.resolve('frontend/src/utils/paymentCopy.js'))}; process.stdout.write(buildPaymentCopyText(${JSON.stringify({ ...order, orderId: 335 })}, ${JSON.stringify(fixture.payload)}));`;
  const original = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  expect(content.buildNotificationText(order, fixture.payload)).toBe(
    original.replace('335 || ', '335 || 广州 刘炎 || ')
  );
});
test('多商品、重复合并、AOS TAG 优先与空值', () => {
  const text = content.buildNotificationText(
    {
      ...order,
      tag: '旧TAG',
      ingestionSource: 'aos',
      sourceRecipientTag: '新TAG',
      paymentMethod: 'alipay',
      products: [{ name: 'A', quantity: 2 }, { name: 'A', quantity: 3 }, { model: 'B' }],
    },
    'https://example.test'
  );
  expect(text).toContain('335 || 新TAG || A x 5、B x 1 || 支付宝');
  expect(content.buildNotificationText({ id: 1 }, 'link')).toBe('1 || - || - || - || - || link');
});
test('服务器识读合成支付码、坏图与非支付码', () => {
  expect(content.decodePaymentQr(fixture.valid)).toBe(fixture.payload);
  expect(content.decodePaymentQr(fixture.nonPayment)).toBeNull();
  expect(content.decodePaymentQr('data:image/png;base64,bad')).toBeNull();
  expect(content.decodePaymentQr(null)).toBeNull();
});
test.each(['paid', 'refunded'])('付款状态 %s 跳过', paymentStatus => {
  expect(content.orderBlockReason({ ...order, paymentStatus }, new Date(order.orderDate))).toBe(
    'ORDER_TERMINAL'
  );
});
test.each(['cancelled', 'pickup_cancelled', 'payment_expired', 'payment_received'])(
  '订单状态 %s 跳过',
  status => {
    expect(content.orderBlockReason({ ...order, status }, new Date(order.orderDate))).toBe(
      'ORDER_TERMINAL'
    );
  }
);
test('截止时刻、缺失时间及无订单不推送', () => {
  expect(content.orderBlockReason(order, new Date('2026-09-19T20:21:00Z'))).toBe('ORDER_EXPIRED');
  expect(content.orderBlockReason({ orderDate: '2026-09-20' }, new Date())).toBe(
    'DEADLINE_MISSING'
  );
  expect(content.orderBlockReason(null, new Date())).toBe('ORDER_MISSING');
});
test.each([
  'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678',
  webhook + '&key=otherkey',
  webhook + '&x=1',
  webhook + '#abc',
  webhook.replace('qyapi.weixin.qq.com', 'evil.example'),
  webhook.replace('/send?', '/upload_media?'),
  'enc:v1:bogus',
])('拒绝无效 Webhook %s', value => expect(() => validateWebhook(value)).toThrow());
test('传输禁用重定向与环境代理，只发送 text 不 @', async () => {
  axios.post.mockResolvedValue({ status: 200, data: { errcode: 0 } });
  expect(await sendText(webhook, '合成消息')).toEqual({ status: 'accepted' });
  expect(axios.post).toHaveBeenLastCalledWith(
    webhook,
    { msgtype: 'text', text: { content: '合成消息' } },
    expect.objectContaining({ maxRedirects: 0, proxy: false })
  );
});
test.each([
  [200, { errcode: 45009 }, 'pending'],
  [429, {}, 'pending'],
  [200, { errcode: 93000 }, 'failed'],
  [200, { errcode: 12345 }, 'failed'],
  [200, {}, 'unknown'],
  [500, {}, 'unknown'],
  [302, {}, 'unknown'],
])('HTTP %s / %j 映射为 %s', async (status, data, expected) => {
  axios.post.mockResolvedValue({ status, data });
  expect((await sendText(webhook, 'test')).status).toBe(expected);
});
test.each([
  ['ETIMEDOUT', 'unknown'],
  ['ECONNRESET', 'unknown'],
  ['ECONNREFUSED', 'pending'],
  ['EAI_AGAIN', 'pending'],
])('网络 %s 映射为 %s 且不传播敏感错误', async (code, expected) => {
  axios.post.mockRejectedValue(Object.assign(new Error(webhook), { code }));
  const result = await sendText(webhook, 'test');
  expect(result.status).toBe(expected);
  expect(JSON.stringify(result)).not.toContain('synthetic-key');
});
test('按 UTF-8 字节限制文本，不截断付款链接', async () => {
  axios.post.mockClear();
  expect(await sendText(webhook, '中'.repeat(683))).toEqual({
    status: 'failed',
    errorCode: 'TEXT_TOO_LONG',
  });
  expect(axios.post).not.toHaveBeenCalled();
});
