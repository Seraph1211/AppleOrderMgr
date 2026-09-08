jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

function loadCrawlerService(overrides = {}) {
  jest.resetModules();

  jest.doMock('../src/utils/logger', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }));

  jest.doMock('../src/models', () => ({
    Order: {
      findAll: jest.fn(),
      findByPk: jest.fn(),
      increment: jest.fn(),
    },
    CrawlLog: {
      create: jest.fn().mockResolvedValue({ id: 1 }),
    },
    sequelize: {
      transaction: jest.fn().mockResolvedValue({
        commit: jest.fn(),
        rollback: jest.fn(),
      }),
    },
  }));

  const proxySequence = overrides.proxies ? [...overrides.proxies] : null;
  jest.doMock('../src/utils/proxyManager', () => ({
    getNextProxy: jest.fn(() => proxySequence?.shift() || overrides.proxy || null),
    refresh: overrides.refreshReject
      ? jest.fn().mockRejectedValue(new Error(overrides.refreshReject))
      : jest.fn(),
    recordProxySuccess: jest.fn(),
    recordProxyFailure: jest.fn(),
    markProxyAsBad: jest.fn(),
    getStatus: jest.fn(() => ({ isInitialized: true })),
    initialize: jest.fn(),
  }));

  jest.doMock('../src/utils/config', () => ({
    config: {
      app: { env: 'test' },
      proxy: { enabled: overrides.proxyEnabled === true },
      crawler: {
        timeout: 1000,
        userAgent: 'jest',
        maxRetry: 3,
        requestDelay: { min: 5000, max: 10000 },
        autoRefreshEnabled: false,
        autoRefreshIntervalMs: 10000,
        windControlPauseThreshold: overrides.windControlPauseThreshold || 2,
        retryDelayMinMs: 1,
        retryDelayMaxMs: 1,
      },
      telegram: {
        enabled: true,
        botToken: 'test-token',
        chatId: 'test-chat',
        timeout: 1000,
      },
    },
  }));

  jest.doMock('../src/utils/telegramNotifier', () => ({
    sendTelegramAlert: jest.fn().mockResolvedValue(true),
  }));

  return require('../src/services/crawlerService');
}

describe('crawlerService product validation and scheduler rules', () => {
  test('marks quantity mismatch as abnormal', () => {
    const crawlerService = loadCrawlerService();
    const result = crawlerService.validateProducts(
      [{ model: 'MG714CH/A', name: 'iPhone 17 256G', quantity: 2 }],
      [{ model: 'MG714CH/A', name: 'iPhone 17 256G', quantity: 1 }]
    );

    expect(result.status).toBe('abnormal');
    expect(result.issues[0].type).toBe('quantity_mismatch');
  });

  test('marks matching products as valid', () => {
    const crawlerService = loadCrawlerService();
    const result = crawlerService.validateProducts(
      [{ model: 'MG714CH/A', name: 'iPhone 17 256G', quantity: 2 }],
      [{ model: 'MG714CH/A', name: 'iPhone 17 256G', quantity: 2 }]
    );

    expect(result.status).toBe('valid');
    expect(result.issues).toHaveLength(0);
  });

  test('已取消订单的官网数量 0 不应覆盖或否定邮件权威数量', () => {
    const crawlerService = loadCrawlerService();
    const result = crawlerService.validateProducts(
      [{ model: 'MG714CH/A', name: 'iPhone 17 256G', quantity: 2 }],
      [{ model: 'MG714CH/A', name: 'iPhone 17 256G', quantity: 0 }],
      { orderStatus: 'cancelled' }
    );

    expect(result.status).toBe('valid');
    expect(result.comparisons[0].emailQuantity).toBe(2);
    expect(result.comparisons[0].quantityCheckSkipped).toBe('official_cancelled_order');
  });

  test('stops automatic refresh for terminal and abnormal orders', () => {
    const crawlerService = loadCrawlerService();

    expect(crawlerService.getAutoRefreshStopReason({ status: 'delivered' })).toBe(
      'status:delivered'
    );
    expect(
      crawlerService.getAutoRefreshStopReason({
        status: 'processing',
        validationStatus: 'abnormal',
      })
    ).toBe('validation_abnormal');
    expect(
      crawlerService.getAutoRefreshStopReason({
        status: 'processing',
        paymentStatus: 'paid',
        pickupStatus: 'not_picked_up',
      })
    ).toBe('payment_status:paid');
  });

  test('filters abnormal orders out of automatic refresh candidates', () => {
    const crawlerService = loadCrawlerService();

    expect(
      crawlerService.isOrderEligibleForAutoRefresh({
        orderNumber: 'W1234567890',
        orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
        autoRefreshEnabled: true,
        status: 'processing',
        validationStatus: 'valid',
      })
    ).toBe(true);
    expect(
      crawlerService.isOrderEligibleForAutoRefresh({
        orderNumber: 'W1234567890',
        orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
        autoRefreshEnabled: true,
        status: 'processing',
        validationStatus: 'abnormal',
      })
    ).toBe(false);
  });

  test('infers paid and not picked up from ready for pickup official status', () => {
    const crawlerService = loadCrawlerService();
    const result = crawlerService.parseOrderData(
      {
        orderDetail: {
          orderHeader: {
            d: {
              orderNumber: 'W1234567890',
              orderPlacedDate: '2026年7月21日',
            },
          },
          orderItems: {
            c: [],
          },
        },
      },
      '<html><body>准备就绪</body></html>'
    );

    expect(result.orderStatus).toBe('ready_for_pickup');
    expect(result.paymentStatus).toBe('paid');
    expect(result.pickupStatus).toBe('not_picked_up');
    expect(result.officialOrderCreatedAt).toBeNull();
  });

  test('只在官网下单时间包含时分时提取精确创建时间', () => {
    const crawlerService = loadCrawlerService();

    expect(crawlerService.parseOfficialOrderCreatedAt('2026年9月8日')).toBeNull();
    expect(crawlerService.parseOfficialOrderCreatedAt('2026年9月8日 下午2:05').toISOString()).toBe(
      '2026-09-08T06:05:00.000Z'
    );
    expect(
      crawlerService.parseOfficialOrderCreatedAt('2026-09-08T14:05:30+08:00').toISOString()
    ).toBe('2026-09-08T06:05:30.000Z');
  });

  test('以 currentStatus 为订单状态权威且忽略隐藏退款文案', () => {
    const crawlerService = loadCrawlerService();
    const result = crawlerService.parseOrderData(
      {
        orderDetail: {
          orderHeader: {
            d: {
              orderNumber: 'W1234567890',
              orderPlacedDate: '2026年9月7日',
            },
          },
          orderItems: {
            c: ['orderItem-1'],
            'orderItem-1': {
              orderItemStatusTracker: { d: { currentStatus: 'PICKED_UP' } },
              orderItemDetails: {
                d: { productName: '测试商品', partNumber: 'TEST-1', quantity: 1 },
              },
            },
          },
        },
      },
      '<html><body><main>已收到付款 已发货 已取货</main><div hidden>退款说明</div><script>{"help":"退款"}</script></body></html>'
    );

    expect(result.orderStatus).toBe('completed');
    expect(result.paymentStatus).toBe('paid');
    expect(result.pickupStatus).toBe('picked_up');
    expect(result.products[0].status).toBe('PICKED_UP');
    expect(result.officialOrderAmount).toBeNull();
    expect(result.officialOrderAmountParseError).toBeNull();
  });

  test('兼容 Apple 带序号和数字后缀的订单项键', () => {
    const crawlerService = loadCrawlerService();
    const result = crawlerService.parseOrderData(
      {
        orderDetail: {
          orderHeader: { d: { orderNumber: 'W1234567890' } },
          orderItems: {
            c: ['orderItem-1of2-123456'],
            'orderItem-1of2-123456': {
              orderItemStatusTracker: { d: { currentStatus: 'PICKED_UP' } },
              orderItemDetails: { d: { productName: '测试商品', quantity: 1 } },
            },
          },
        },
      },
      '<html><body></body></html>'
    );

    expect(result.orderStatus).toBe('completed');
    expect(result.products).toHaveLength(1);
    expect(result.products[0].status).toBe('PICKED_UP');
  });

  test('未知 currentStatus 回退到清理后的可见订单文本', () => {
    const crawlerService = loadCrawlerService();
    const result = crawlerService.parseOrderData(
      {
        orderDetail: {
          orderHeader: { d: { orderNumber: 'W1234567890' } },
          orderItems: {
            'orderItem-1': {
              orderItemStatusTracker: { d: { currentStatus: 'NEW_APPLE_STATUS' } },
              orderItemDetails: { d: { productName: '测试商品', quantity: 1 } },
            },
          },
        },
      },
      '<html><body><main>处理中</main><script>已取货 退款</script></body></html>'
    );

    expect(result.orderStatus).toBe('processing');
    expect(result.paymentStatus).toBeNull();
    expect(result.pickupStatus).toBeNull();
  });

  test.each([
    ['PROCESSING', 'processing'],
    ['SHIPPED', 'shipped'],
    ['READY_FOR_PICKUP', 'ready_for_pickup'],
    ['DELIVERED', 'delivered'],
    ['CANCELLED', 'cancelled'],
    ['PICKUP_CANCELLED', 'pickup_cancelled'],
  ])('映射 Apple currentStatus %s 为 %s', (currentStatus, expectedStatus) => {
    const crawlerService = loadCrawlerService();
    const result = crawlerService.parseOrderData(
      {
        orderDetail: {
          orderHeader: { d: { orderNumber: 'W1234567890' } },
          orderItems: {
            c: ['orderItem-1'],
            'orderItem-1': {
              orderItemStatusTracker: { d: { currentStatus } },
              orderItemDetails: { d: { productName: '测试商品', quantity: 1 } },
            },
          },
        },
      },
      '<html><body><main>与状态无关的文本</main></body></html>'
    );

    expect(result.orderStatus).toBe(expectedStatus);
  });

  test('将付款过期的 Apple 存储订单映射为未付款取消状态', () => {
    const crawlerService = loadCrawlerService();
    const result = crawlerService.parseOrderData(
      {
        orderDetail: {
          orderHeader: { d: { orderNumber: 'W1234567890' } },
          orderItems: {
            c: ['orderItem-10'],
            'orderItem-10': {
              orderItemStatusTracker: {
                d: { currentStatus: 'PAYMENT_EXPIRED_STORED_ORDER' },
              },
              orderItemDetails: { d: { productName: '测试商品', quantity: 1 } },
            },
          },
        },
      },
      '<html><body></body></html>'
    );

    expect(result.orderStatus).toBe('cancelled');
    expect(result.paymentStatus).toBe('unpaid');
    expect(result.pickupStatus).toBeNull();
    expect(result.products[0].status).toBe('PAYMENT_EXPIRED_STORED_ORDER');
  });

  test('总计标签存在但金额无法识别时保留解析错误', () => {
    const crawlerService = loadCrawlerService();

    expect(crawlerService.extractOfficialAmount('订单总计：请联系支持')).toEqual({
      amount: null,
      currency: null,
      parseError: '页面包含订单总计，但金额格式无法识别',
    });
  });
});

describe('crawlerService order identity validation', () => {
  test('只接受与订单号和 Apple ID 完全匹配的 Apple 官网 URL', () => {
    const crawlerService = loadCrawlerService();

    expect(() =>
      crawlerService.validateOrderUrl(
        'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
        'W1234567890',
        'test@example.com'
      )
    ).not.toThrow();
    expect(() =>
      crawlerService.validateOrderUrl(
        'https://evil.example/xc/cn/vieworder/W1234567890/test%40example.com',
        'W1234567890',
        'test@example.com'
      )
    ).toThrow('订单 URL 来源或身份');
  });

  test('官网返回订单号缺失或不匹配时拒绝更新', () => {
    const crawlerService = loadCrawlerService();

    expect(() =>
      crawlerService.validateCrawledOrderIdentity({ orderNumber: 'W0000000000' }, 'W1234567890')
    ).toThrow('官网返回的订单身份');
  });
});

describe('crawlerService proxy and wind control', () => {
  test('隧道代理关闭连接复用且不注入会破坏 CONNECT 的自定义 Agent', async () => {
    const crawlerService = loadCrawlerService({ proxyEnabled: true });
    const mockedAxios = require('axios');
    mockedAxios.get.mockResolvedValueOnce({ data: '<html>ok</html>' });

    await expect(
      crawlerService.fetchOrderPage('https://www.apple.com.cn/', {
        host: 'tunnel.example',
        port: 15818,
        auth: { username: 'test-user', password: 'test-password' },
        disableKeepAlive: true,
      })
    ).resolves.toBe('<html>ok</html>');

    const requestConfig = mockedAxios.get.mock.calls[0][1];
    expect(requestConfig.headers.Connection).toBe('close');
    expect(requestConfig.headers['Accept-Encoding']).toBe('gzip');
    expect(requestConfig).not.toHaveProperty('httpAgent');
    expect(requestConfig).not.toHaveProperty('httpsAgent');
  });

  test('blocks fetch when proxy is disabled', async () => {
    const crawlerService = loadCrawlerService({ proxyEnabled: false });

    await expect(
      crawlerService.fetchWithRetry('https://www.apple.com.cn/order', 1)
    ).rejects.toThrow('爬虫服务必须启用代理池');
  });

  test('pauses automatic refresh and sends telegram alert on wind control threshold', async () => {
    const proxy = { host: '127.0.0.1', port: 8080 };
    const crawlerService = loadCrawlerService({
      proxyEnabled: true,
      proxy,
      windControlPauseThreshold: 1,
    });
    const mockedAxios = require('axios');
    mockedAxios.get.mockRejectedValueOnce({
      message: 'HTTP 541',
      response: { status: 541 },
    });

    await expect(
      crawlerService.fetchWithRetry('https://www.apple.com.cn/order', 1)
    ).rejects.toThrow('爬取订单失败');

    expect(crawlerService.getAutoRefreshStatus().isPaused).toBe(true);
    const { sendTelegramAlert } = require('../src/utils/telegramNotifier');
    expect(sendTelegramAlert).toHaveBeenCalledWith(
      '自动刷新已暂停',
      expect.objectContaining({ reason: '连续订单耗尽重试并触发 Apple 风控' })
    );
  });

  test('单个订单重试后成功不会触发全局风控暂停', async () => {
    const proxy = { host: '127.0.0.1', port: 8080 };
    const crawlerService = loadCrawlerService({
      proxyEnabled: true,
      proxy,
      windControlPauseThreshold: 1,
    });
    const mockedAxios = require('axios');
    mockedAxios.get
      .mockRejectedValueOnce({ message: 'HTTP 541', response: { status: 541 } })
      .mockResolvedValueOnce({
        data: '<html><body><script>{"orderDetail":{"orderHeader":{"d":{"orderNumber":"W1234567890"}},"orderItems":{"c":[],"orderItem-1":{}}}}</script></body></html>',
      });

    await expect(
      crawlerService.fetchWithRetry(
        'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test@example.com',
        2
      )
    ).resolves.toMatchObject({ success: true });
    expect(crawlerService.getAutoRefreshStatus().isPaused).toBe(false);
  });

  test('响应流中断时丢弃不完整内容并换代理完整重抓', async () => {
    const firstProxy = { host: '127.0.0.1', port: 8080, provider: 'yiyou_http' };
    const secondProxy = { host: '127.0.0.2', port: 8081, provider: 'yiyou_http' };
    const crawlerService = loadCrawlerService({
      proxyEnabled: true,
      proxies: [firstProxy, secondProxy],
    });
    const mockedAxios = require('axios');
    const interrupted = new Error('stream interrupted');
    interrupted.code = 'ERR_BAD_RESPONSE';
    mockedAxios.get.mockRejectedValueOnce(interrupted).mockResolvedValueOnce({
      data: '<html><body><script>{"orderDetail":{"orderHeader":{"d":{"orderNumber":"W1234567890"}},"orderItems":{"c":[],"orderItem-1":{}}}}</script></body></html>',
    });

    await expect(
      crawlerService.fetchWithRetry(
        'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test@example.com',
        2
      )
    ).resolves.toMatchObject({ success: true, proxy: '127.0.0.2:8081' });

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(mockedAxios.get.mock.calls[0][1].proxy.host).toBe('127.0.0.1');
    expect(mockedAxios.get.mock.calls[1][1].proxy.host).toBe('127.0.0.2');
  });

  test('无论调用方配置如何都将单订单尝试次数限制为最多三次', async () => {
    const crawlerService = loadCrawlerService({
      proxyEnabled: true,
      proxy: { host: '127.0.0.1', port: 8080 },
    });
    const mockedAxios = require('axios');
    mockedAxios.get.mockRejectedValue({ message: '代理传输失败', code: 'ECONNRESET' });

    await expect(
      crawlerService.fetchWithRetry('https://www.apple.com.cn/order', 99)
    ).rejects.toThrow('已重试 3 次');
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });

  test('pauses automatic refresh and sends telegram alert when proxy refresh fails', async () => {
    const crawlerService = loadCrawlerService({
      proxyEnabled: true,
      refreshReject: 'proxy api failed',
    });

    await expect(
      crawlerService.fetchWithRetry(
        'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test@example.com',
        1
      )
    ).rejects.toThrow('无可用代理且刷新失败');

    expect(crawlerService.getAutoRefreshStatus().isPaused).toBe(true);
    const { sendTelegramAlert } = require('../src/utils/telegramNotifier');
    expect(sendTelegramAlert).toHaveBeenCalledWith(
      '自动刷新已暂停',
      expect.objectContaining({
        reason: '代理池耗尽或代理 API 失败',
        urlSummary: expect.objectContaining({
          orderNumber: 'W1234567890',
        }),
      })
    );
  });
});
