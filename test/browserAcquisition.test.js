const {
  acquireBrowserOrderData,
  validateBrowserPageUrl,
} = require('../src/services/crawler/browserAcquisition');

const ORDER_NUMBER = 'W1234567890';
const PAGE_URL = `https://secure8.www.apple.com.cn/shop/order/guest/${ORDER_NUMBER}/test-token?e=true`;

function makeOptions(overrides = {}) {
  return {
    acquireOrderPage: jest.fn().mockResolvedValue({
      pageUrl: PAGE_URL,
      orderJson: { orderDetail: { orderHeader: {}, orderItems: {} } },
    }),
    orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/${ORDER_NUMBER}/test%40example.com`,
    orderNumber: ORDER_NUMBER,
    timeoutMs: 120000,
    parseOrderData: jest
      .fn()
      .mockReturnValue({ orderNumber: ORDER_NUMBER, products: [{ name: '测试商品' }] }),
    validateIdentity: jest.fn(),
    ...overrides,
  };
}

describe('浏览器采集边界', () => {
  afterEach(() => jest.useRealTimers());

  test.each([
    'https://example.com/shop/order/guest/W1234567890/token',
    PAGE_URL.replace('https:', 'http:'),
    PAGE_URL.replace('secure8.', 'secure8.evil.'),
    PAGE_URL.replace('secure8.', 'user:secret@secure8.'),
    PAGE_URL.replace('.cn/', '.cn:444/'),
    PAGE_URL.replace(ORDER_NUMBER, 'W9999999999'),
    PAGE_URL.replace('/test-token', ''),
    PAGE_URL.replace('/guest/', '/guest/../'),
    'not a url',
    null,
  ])('拒绝错误来源且错误中不回显 URL：%s', pageUrl => {
    expect(() => validateBrowserPageUrl(pageUrl, ORDER_NUMBER)).toThrow(
      '浏览器返回的页面来源或订单路径无效'
    );
  });

  test('正常结果仍调用解析器与身份校验，不透传业务更新对象', async () => {
    const options = makeOptions();
    const result = await acquireBrowserOrderData(options);
    expect(options.parseOrderData).toHaveBeenCalledWith(
      expect.objectContaining({ orderDetail: expect.any(Object) }),
      ''
    );
    expect(options.validateIdentity).toHaveBeenCalledWith(result.data, ORDER_NUMBER);
    expect(options.acquireOrderPage).toHaveBeenCalledWith(
      expect.objectContaining({
        orderUrl: options.orderUrl,
        orderNumber: ORDER_NUMBER,
        signal: expect.any(AbortSignal),
      })
    );
    expect(result).toMatchObject({ success: true, acquisitionMethod: 'browser', proxy: null });
    expect(result).not.toHaveProperty('orderJson');
    expect(result).not.toHaveProperty('pageUrl');
  });

  test('加载页不进入解析或身份异常处理', async () => {
    const options = makeOptions({
      acquireOrderPage: () =>
        Promise.resolve({ pageUrl: PAGE_URL, orderJson: { guestOrderSpinner: {} } }),
    });
    await expect(acquireBrowserOrderData(options)).rejects.toMatchObject({
      refreshErrorCode: 'PAGE_LOADING',
    });
    expect(options.parseOrderData).not.toHaveBeenCalled();
    expect(options.validateIdentity).not.toHaveBeenCalled();
  });

  test('空商品结果不能变成成功', async () => {
    const options = makeOptions({
      parseOrderData: jest.fn().mockReturnValue({ orderNumber: ORDER_NUMBER, products: [] }),
    });
    await expect(acquireBrowserOrderData(options)).rejects.toMatchObject({
      refreshErrorCode: 'PARSE',
    });
  });

  test('响应身份冲突保留既有错误类型', async () => {
    const error = Object.assign(new Error('订单身份不一致'), { eventType: 'order_identity' });
    const options = makeOptions({
      validateIdentity: () => {
        throw error;
      },
    });
    await expect(acquireBrowserOrderData(options)).rejects.toBe(error);
  });

  test('超时会取消采集，迟到的结果不会进入解析', async () => {
    jest.useFakeTimers();
    let complete;
    let browserSignal;
    const options = makeOptions({
      timeoutMs: 100,
      acquireOrderPage: ({ signal }) => {
        browserSignal = signal;
        return new Promise(resolve => {
          complete = resolve;
        });
      },
    });
    const result = acquireBrowserOrderData(options);
    const rejection = expect(result).rejects.toMatchObject({ refreshErrorCode: 'TASK_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(101);
    await rejection;
    expect(browserSignal.aborted).toBe(true);
    complete({
      pageUrl: PAGE_URL,
      orderJson: { orderDetail: { orderHeader: {}, orderItems: {} } },
    });
    await Promise.resolve();
    expect(options.parseOrderData).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('调用前取消时不启动采集', async () => {
    const controller = new AbortController();
    controller.abort();
    const options = makeOptions({ signal: controller.signal });
    await expect(acquireBrowserOrderData(options)).rejects.toMatchObject({
      refreshErrorCode: 'REQUEST_CANCELLED',
    });
    expect(options.acquireOrderPage).not.toHaveBeenCalled();
  });

  test('调用期间取消时清理预算与监听器', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const options = makeOptions({
      signal: controller.signal,
      acquireOrderPage: () => new Promise(() => {}),
    });
    const result = acquireBrowserOrderData(options);
    const rejection = expect(result).rejects.toMatchObject({
      refreshErrorCode: 'REQUEST_CANCELLED',
    });
    await Promise.resolve();
    controller.abort();
    await rejection;
    expect(jest.getTimerCount()).toBe(0);
  });
});
