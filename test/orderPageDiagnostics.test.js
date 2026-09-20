const { describeOrderPage } = require('../src/services/crawler/orderPageDiagnostics');

test('诊断白名单不保留标题正文、邮箱、完整跳转、查询、凭据或其他订单号', () => {
  const html =
    '<title>访客订单 secret@example.com secret-title</title><script id="init_data">{}</script>';
  const result = describeOrderPage(
    html,
    {
      orderDetail: { orderHeader: { d: { orderNumber: 'W9999999999', secret: 'secret-value' } } },
      secretKey: 'secret-value',
    },
    {
      httpStatus: 200,
      finalUrl:
        'https://secure7.www.apple.com.cn/shop/order/guest/W9999999999/secret-token?e=secret-email',
    }
  );
  expect(result).toMatchObject({
    finalHost: 'secure7.www.apple.com.cn',
    routeKind: 'guest_order',
    titleKind: 'guest_order',
    hasValidOrderNumber: true,
    httpStatus: 200,
    hasInitData: true,
  });
  expect(JSON.stringify(result)).not.toMatch(/secret|W9999999999|\?/);
});

test.each([
  'https://evil.example/secret',
  'https://www.apple.com.cn.evil.example/secret',
  undefined,
])('非 Apple 或缺失最终地址不输出主机：%s', finalUrl => {
  expect(describeOrderPage('', null, { finalUrl })).toMatchObject({
    finalHost: null,
    routeKind: 'unknown',
  });
});

test('识别加载页，无需存储原始响应', () => {
  expect(
    describeOrderPage('<script id="init_data">{}</script>', { guestOrderSpinner: { d: {} } })
  ).toMatchObject({
    hasGuestOrderSpinner: true,
    hasOrderDetail: false,
    hasValidOrderNumber: false,
  });
});

test('识别浏览器校验脚本，仍只保留布尔值', () => {
  expect(
    describeOrderPage('<script src="/shop/shld/v2_1/verify.js?token=secret"></script>', null)
  ).toMatchObject({ hasBrowserVerification: true, hasOrderDetail: false });
});
