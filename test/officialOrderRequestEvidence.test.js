/* eslint-disable no-magic-numbers -- 合成请求边界和固定体积。 */
const { buildGuestRequestEvidence } = require('../src/services/officialOrderRequestEvidence');

const ORDER = 'W1234567890';
const URL = `https://secure11.www.apple.com.cn/shop/orderx/guestx/${ORDER}/private-token?e=secret&_a=fetchOrder&_m=guestOrderSpinner`;
const request = overrides => ({
  url: URL,
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-aos-stk': 'secret-header' },
  hasPostData: true,
  postData: 'request=private-body',
  ...overrides,
});

test('保留原方法、头和正文用于加密，摘要不含令牌、头值或正文', () => {
  const original = request();
  const result = buildGuestRequestEvidence(original, ORDER);
  expect(result.evidence).toMatchObject(original);
  expect(result.summary).toMatchObject({
    method: 'POST',
    bodyComplete: true,
    headersComplete: true,
    postDataBytes: 20,
  });
  const logged = JSON.stringify(result.summary);
  for (const secret of [ORDER, 'private-token', 'secret-header', 'private-body', 'e=secret'])
    expect(logged).not.toContain(secret);
  expect(original).toEqual(request());
});

test.each([
  ['GET', undefined, undefined, true],
  ['GET', true, undefined, false],
  ['POST', undefined, undefined, false],
  ['POST', true, undefined, false],
  ['POST', false, undefined, true],
  ['POST', true, '', true],
])('缺失正文不猜测为可重放空串：%s/%s', (method, hasPostData, postData, complete) => {
  const result = buildGuestRequestEvidence(request({ method, hasPostData, postData }), ORDER);
  expect(result.evidence.bodyComplete).toBe(complete);
  expect(result.evidence.postData).toBe(postData ?? null);
});

test('分段正文可能遗漏文件，不宣称完整；缺失头也不补成已确认的空头', () => {
  const result = buildGuestRequestEvidence(
    request({ postDataEntries: [{ bytes: 'c2VjcmV0' }], headers: undefined }),
    ORDER
  );
  expect(result.evidence).toMatchObject({
    postDataEntriesPresent: true,
    bodyComplete: false,
    headersComplete: false,
    headers: null,
  });
});

test('按 CDP 分段字节完整保留二进制，旧字符串缺失时不丢失正文', () => {
  const bytes = Buffer.from([0, 255, 128, 65]);
  const result = buildGuestRequestEvidence(
    request({
      postData: undefined,
      postDataEntries: [
        { bytes: bytes.subarray(0, 2).toString('base64') },
        { bytes: bytes.subarray(2).toString('base64') },
      ],
    }),
    ORDER
  );
  expect(result.evidence.bodyComplete).toBe(true);
  expect(Buffer.from(result.evidence.bodyBase64, 'base64')).toEqual(bytes);
  expect(result.evidence.postData).toBeNull();
  expect(result.summary.bodyBytes).toBe(4);
});

test.each([
  { postDataEntries: [{ bytes: '%%%' }] },
  { postDataEntries: [{}] },
  { postDataEntries: [] },
  { postDataEntries: null },
  { postDataEntries: {} },
])('缺失或无效字节分段不能冒充完整请求：%j', ({ postDataEntries }) => {
  expect(buildGuestRequestEvidence(request({ postDataEntries }), ORDER).evidence.bodyComplete).toBe(
    false
  );
});

test('同时提供新旧正文时必须一致，超过上限的分段也拒绝', () => {
  const postData = 'model=合成';
  const postDataEntries = [{ bytes: Buffer.from(postData).toString('base64') }];
  expect(
    buildGuestRequestEvidence(request({ postData, postDataEntries }), ORDER).evidence.bodyComplete
  ).toBe(true);
  expect(
    buildGuestRequestEvidence(request({ postData: 'different', postDataEntries }), ORDER).evidence
      .bodyComplete
  ).toBe(false);
  expect(() =>
    buildGuestRequestEvidence(request({ postDataEntries: [{ bytes: 'A'.repeat(262148) }] }), ORDER)
  ).toThrow('REQUEST_EVIDENCE_TOO_LARGE');
});

test.each([
  URL.replace('https:', 'http:'),
  URL.replace('secure11.www.apple.com.cn', 'attacker.example.test'),
  URL.replace('secure11.www.apple.com.cn', 'idmsa.apple.com.cn'),
  URL.replace(ORDER, 'W0000000001'),
  URL.replace('/orderx/guestx/', '/orderx/detail/'),
  URL.replace('_a=fetchOrder', '_a=cancelOrder'),
  URL.replace('_m=guestOrderSpinner', '_m=other'),
  URL + '&_a=cancelOrder',
  URL + '&_m=other',
  URL + '#fragment',
  URL.replace('https://', 'https://user:secret@'),
  URL.replace('/private-token?', '//?'),
  'not-a-url',
])('不采集其他账号、订单、动作或不完整目标：%s', url => {
  expect(buildGuestRequestEvidence(request({ url }), ORDER)).toBeNull();
});

test.each(['DELETE', 'PATCH', undefined])('不采集非已知只读协议方法：%s', method => {
  expect(buildGuestRequestEvidence(request({ method }), ORDER)).toBeNull();
});

test('输入无效或证据过大时拒绝构造，不能留下部分正文冒充完整', () => {
  expect(buildGuestRequestEvidence(null, ORDER)).toBeNull();
  expect(buildGuestRequestEvidence(request(), 'wrong')).toBeNull();
  expect(() => buildGuestRequestEvidence(request({ postData: 'a'.repeat(262144) }), ORDER)).toThrow(
    'REQUEST_EVIDENCE_TOO_LARGE'
  );
});
