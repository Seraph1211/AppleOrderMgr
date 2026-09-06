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

  jest.doMock('../src/utils/proxyManager', () => ({
    getNextProxy: jest.fn(() => overrides.proxy || null),
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
    ).toBe('paid_not_picked_up');
  });

  test('filters abnormal orders out of automatic refresh candidates', () => {
    const crawlerService = loadCrawlerService();

    expect(
      crawlerService.isOrderEligibleForAutoRefresh({
        orderNumber: 'W1234567890',
        autoRefreshEnabled: true,
        status: 'processing',
        validationStatus: 'valid',
      })
    ).toBe(true);
    expect(
      crawlerService.isOrderEligibleForAutoRefresh({
        orderNumber: 'W1234567890',
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
      expect.objectContaining({ reason: '连续触发 Apple 风控' })
    );
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
