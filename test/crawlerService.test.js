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

  test('已取消订单的官网零数量应产生来源差异', () => {
    const crawlerService = loadCrawlerService();
    const result = crawlerService.validateProducts(
      [{ model: 'MG714CH/A', name: 'iPhone 17 256G', quantity: 2 }],
      [{ model: 'MG714CH/A', name: 'iPhone 17 256G', quantity: 0 }],
      { orderStatus: 'cancelled' }
    );

    expect(result.status).toBe('abnormal');
    expect(result.comparisons[0].emailQuantity).toBe(2);
    expect(result.issues[0].type).toBe('quantity_mismatch');
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
        validationIssues: [{ type: 'order_identity' }],
      })
    ).toBe('order_identity');
    expect(
      crawlerService.getAutoRefreshStopReason({
        status: 'processing',
        paymentStatus: 'paid',
        pickupStatus: 'not_picked_up',
      })
    ).toBe('payment_status:paid');
  });

  test('filters historical post-payment and abnormal orders out of automatic refresh candidates', () => {
    const crawlerService = loadCrawlerService();

    expect(
      crawlerService.isOrderEligibleForAutoRefresh({
        orderNumber: 'W1234567890',
        orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
        autoRefreshEnabled: true,
        status: 'processing',
        validationStatus: 'valid',
      })
    ).toBe(false);
    expect(
      crawlerService.isOrderEligibleForAutoRefresh({
        orderNumber: 'W1234567890',
        orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
        autoRefreshEnabled: true,
        status: 'processing',
        validationStatus: 'abnormal',
        validationIssues: [{ type: 'order_identity' }],
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
    expect(result.pickupStatus).toBe('ready_for_pickup');
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

    expect(result.orderStatus).toBe('picked_up');
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

    expect(result.orderStatus).toBe('picked_up');
    expect(result.products).toHaveLength(1);
    expect(result.products[0].status).toBe('PICKED_UP');
  });

  test('未知 currentStatus 保持未知且保存原值', () => {
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

    expect(result.orderStatus).toBe('unknown');
    expect(result.officialRawStatus).toBe('NEW_APPLE_STATUS');
    expect(result.officialStatusNeedsReview).toBe(true);
    expect(result.paymentStatus).toBeNull();
    expect(result.pickupStatus).toBe('unknown');
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

  test('将付款过期的 Apple 存储订单映射为显式过期状态', () => {
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

    expect(result.orderStatus).toBe('payment_expired');
    expect(result.paymentStatus).toBe('unpaid');
    expect(result.pickupStatus).toBe('not_applicable');
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
  test('订单联系邮箱可以不同于下单账户，仍只接受同订单的 Apple 官网 URL', () => {
    const crawlerService = loadCrawlerService();

    expect(() =>
      crawlerService.validateOrderUrl(
        'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
        'W1234567890',
        'account@example.net'
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

  test.each([
    'http://www.apple.com.cn/xc/cn/vieworder/W1234567890/contact@example.com',
    'https://www.apple.com.cn:8443/xc/cn/vieworder/W1234567890/contact@example.com',
    'https://user:password@www.apple.com.cn/xc/cn/vieworder/W1234567890/contact@example.com',
    'https://www.apple.com.cn/xc/cn/vieworder/W0000000000/contact@example.com',
    'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/contact@example.com/extra',
    'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/contact%2Fother@example.com',
    'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/not-an-email',
  ])('保留来源、路径与订单号限制：%s', url => {
    expect(() => loadCrawlerService().validateOrderUrl(url, 'W1234567890')).toThrow();
  });

  test.each(['account@example.net', null])(
    '有合法订单链接时 Apple ID %s 不阻断官网请求',
    async appleId => {
      const crawlerService = loadCrawlerService({
        proxyEnabled: true,
        proxy: { host: 'proxy.example', port: 8080 },
      });
      const { Order } = require('../src/models');
      const axios = require('axios');
      axios.get.mockReset();
      axios.get.mockRejectedValue(
        Object.assign(new Error('upstream test failure'), { response: { status: 407 } })
      );
      const order = {
        id: 1,
        orderNumber: 'W1234567890',
        orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/contact@example.com',
        appleId,
        status: 'payment_due',
        paymentStatus: 'unpaid',
      };
      order.toJSON = () => ({ ...order });
      Order.findByPk.mockResolvedValue(order);
      await expect(crawlerService.crawlAndUpdateOrder(1, { manual: true })).rejects.toThrow();
      expect(axios.get).toHaveBeenCalledWith(order.orderUrl, expect.any(Object));
      expect(order.appleId).toBe(appleId);
    }
  );

  test.each(['processing', 'ready_for_pickup', 'shipped', 'pending'])(
    '历史 %s 自动任务在执行前跳过且不访问官网',
    async status => {
      const crawlerService = loadCrawlerService();
      const { Order } = require('../src/models');
      const axios = require('axios');
      axios.get.mockClear();
      const order = {
        id: 1,
        orderNumber: 'W1234567890',
        orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/contact@example.com',
        appleId: 'account@example.net',
        status,
        paymentStatus: null,
        orderDate: '2020-01-01T00:00:00Z',
      };
      order.toJSON = () => ({ ...order });
      Order.findByPk.mockResolvedValue(order);
      await expect(crawlerService.crawlAndUpdateOrder(1)).resolves.toMatchObject({
        success: true,
        skipped: true,
      });
      expect(axios.get).not.toHaveBeenCalled();
      expect(Order.increment).not.toHaveBeenCalled();
    }
  );

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

describe('非标准上游状态的日志保存', () => {
  test.each([
    [403, 403],
    [541, 541],
    [631, null],
  ])('%s 不导致日志模型校验失败', async (upstream, expected) => {
    const crawler = loadCrawlerService();
    const { CrawlLog } = require('../src/models');
    await crawler.createCrawlLog({
      source: 'manual',
      httpStatus: upstream,
      context: { manual: true },
    });
    const values = CrawlLog.create.mock.calls[0][0];
    expect(values.httpStatus).toBe(expected);
    expect(values.context).toEqual(
      upstream > 599 ? { manual: true, upstreamHttpStatus: upstream } : { manual: true }
    );
    const { Sequelize } = require('sequelize');
    const db = new Sequelize('postgres://fixture:fixture@127.0.0.1/fixture', { logging: false });
    try {
      const Model = require('../src/models/CrawlLog')(db);
      await expect(Model.build(values).validate()).resolves.toBeDefined();
    } finally {
      await db.close();
    }
  });
});
