jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

function loadCrawlerService(overrides = {}) {
  jest.resetModules();

  jest.doMock('../src/services/crawler/crawlerRateLimiter', () => ({
    acquire: jest.fn().mockResolvedValue(undefined),
  }));

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
      findOne: jest.fn().mockResolvedValue(null),
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
    acquireProxy: jest.fn(() => Promise.resolve(proxySequence?.shift() || overrides.proxy || null)),
    releaseProxy: jest.fn(),
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
        taskTimeoutMs: overrides.taskTimeoutMs || 120000,
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

describe('浏览器取数复用订单事务', () => {
  function prepare() {
    const crawler = loadCrawlerService();
    const models = require('../src/models');
    const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
    const transaction = { commit: jest.fn(), rollback: jest.fn(), LOCK: { UPDATE: true } };
    models.sequelize.transaction.mockResolvedValue(transaction);
    models.sequelize.query = jest.fn().mockResolvedValue([]);
    models.sequelize.literal = value => value;
    models.PaymentTask = { update: jest.fn() };
    const order = {
      id: 1,
      orderNumber: 'W1234567890',
      orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
      updatedAt: new Date('2026-09-20T00:00:00Z'),
      status: 'pending',
      paymentStatus: 'unknown',
      products: [{ name: '测试手机 256GB 蓝色', quantity: 1 }],
      validationIssues: [],
      officialOrderAmount: '8999.00',
      officialOrderAmountCurrency: 'CNY',
      toJSON() {
        return { ...this };
      },
      update: jest.fn().mockResolvedValue(undefined),
    };
    models.Order.findByPk.mockResolvedValue(order);
    const acquireOrderPage = jest.fn().mockResolvedValue({
      pageUrl: 'https://secure8.www.apple.com.cn/shop/order/guest/W1234567890/test-token',
      orderJson: buildLifecycleJson('PROCESSING'),
    });
    return { crawler, models, transaction, order, acquireOrderPage };
  }

  test('服务端解析浏览器详情后提交原订单事务、保留缺失金额并写来源审计', async () => {
    const { crawler, models, transaction, order, acquireOrderPage } = prepare();
    await expect(
      crawler.crawlAndUpdateOrder(1, { manual: true, acquireOrderPage })
    ).resolves.toMatchObject({ success: true, status: 'processing', paymentStatus: 'unknown' });
    const [updateData, updateOptions] = order.update.mock.calls[0];
    expect(updateData).toMatchObject({
      status: 'processing',
      lastCrawledAt: expect.any(Date),
      crawlFailCount: 0,
    });
    expect(updateData).not.toHaveProperty('officialOrderAmount');
    expect(updateData).not.toHaveProperty('paymentStatus');
    expect(models.PaymentTask.update).not.toHaveBeenCalled();
    expect(updateOptions.transaction).toBe(transaction);
    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(models.CrawlLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        context: expect.objectContaining({ acquisitionMethod: 'browser' }),
        crawledData: null,
      }),
      { transaction }
    );
    expect(require('../src/utils/proxyManager').acquireProxy).not.toHaveBeenCalled();
  });

  test('采集期间订单被更新时拒绝旧结果且不递增抓取失败数', async () => {
    const { crawler, models, transaction, order, acquireOrderPage } = prepare();
    models.Order.findByPk
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce({ ...order, updatedAt: new Date('2026-09-20T00:01:00Z') });
    await expect(
      crawler.crawlAndUpdateOrder(1, { manual: true, acquireOrderPage })
    ).rejects.toMatchObject({ eventType: 'concurrency' });
    expect(order.update).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(models.Order.increment).not.toHaveBeenCalled();
  });

  test('采集期间订单身份改变时不写新身份的订单', async () => {
    const { crawler, models, transaction, order, acquireOrderPage } = prepare();
    models.Order.findByPk
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce({ ...order, orderNumber: 'W9999999999' });
    await expect(
      crawler.crawlAndUpdateOrder(1, { manual: true, acquireOrderPage })
    ).rejects.toMatchObject({ eventType: 'concurrency' });
    expect(order.update).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
  });

  test('浏览器异常不会触发业务更新事务', async () => {
    const { crawler, models, order, acquireOrderPage } = prepare();
    acquireOrderPage.mockResolvedValue({ pageUrl: 'https://example.com/', orderJson: {} });
    await expect(
      crawler.crawlAndUpdateOrder(1, { manual: true, acquireOrderPage })
    ).rejects.toMatchObject({ refreshErrorCode: 'PARSE' });
    expect(order.update).not.toHaveBeenCalled();
    expect(models.sequelize.transaction).not.toHaveBeenCalled();
  });

  test('浏览器任务开始版本已经过期时，采集结果不会进入解析或写入', async () => {
    const { crawler, models, order, acquireOrderPage } = prepare();
    await expect(
      crawler.crawlAndUpdateOrder(1, {
        manual: true,
        acquireOrderPage,
        expectedUpdatedAt: '2026-09-19T00:00:00Z',
      })
    ).rejects.toMatchObject({ eventType: 'concurrency' });
    expect(acquireOrderPage).not.toHaveBeenCalled();
    expect(order.update).not.toHaveBeenCalled();
    expect(models.sequelize.transaction).not.toHaveBeenCalled();
  });

  test('同一毫秒版本下，已消费票据仍被事务内审计检查拒绝', async () => {
    const { crawler, models, transaction, order, acquireOrderPage } = prepare();
    models.CrawlLog.findOne.mockResolvedValue({ id: 1 });
    await expect(
      crawler.crawlAndUpdateOrder(1, {
        manual: true,
        acquireOrderPage,
        expectedUpdatedAt: order.updatedAt.toISOString(),
        browserTicketId: 'test-ticket-id',
      })
    ).rejects.toMatchObject({ eventType: 'concurrency' });
    expect(order.update).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalled();
    expect(models.Order.increment).not.toHaveBeenCalled();
  });
});

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
    expect(crawlerService.parseOfficialOrderCreatedAt('2026-09-08T14:05:30').toISOString()).toBe(
      '2026-09-08T06:05:30.000Z'
    );
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
  const orderUrl = 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/contact@example.com';
  test.each([
    ['ECONNABORTED', 'REQUEST_TIMEOUT'],
    ['ERR_BAD_RESPONSE', 'RESPONSE_STREAM'],
  ])('耗尽三次后保留 %s 分类、次数并释放租用', async (code, expected) => {
    const crawler = loadCrawlerService({
      proxyEnabled: true,
      proxy: { host: 'proxy.example', port: 80 },
    });
    const axios = require('axios');
    axios.get.mockReset().mockRejectedValue(Object.assign(new Error('transport failed'), { code }));
    await expect(crawler.fetchWithRetry(orderUrl)).rejects.toMatchObject({
      refreshErrorCode: expected,
      requestAttempts: 3,
    });
    expect(require('../src/utils/proxyManager').releaseProxy).toHaveBeenCalledTimes(3);
  });

  test('407 提前结束报告实际一次并释放槽位', async () => {
    const crawler = loadCrawlerService({
      proxyEnabled: true,
      proxy: { host: 'proxy.example', port: 80 },
    });
    require('axios')
      .get.mockReset()
      .mockRejectedValue({ message: 'auth failed', response: { status: 407 } });
    await expect(crawler.fetchWithRetry(orderUrl)).rejects.toMatchObject({
      refreshErrorCode: 'PROXY_407',
      requestAttempts: 1,
      message: expect.stringContaining('已尝试 1 次'),
    });
    expect(require('../src/utils/proxyManager').releaseProxy).toHaveBeenCalledTimes(1);
  });

  test('总时限中止在途请求，不再重试，释放槽位且不把取消当线路故障', async () => {
    const crawler = loadCrawlerService({
      proxyEnabled: true,
      taskTimeoutMs: 20,
      proxy: { host: 'proxy.example', port: 80 },
    });
    const axios = require('axios');
    axios.get.mockReset().mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })),
            { once: true }
          );
        })
    );
    await expect(crawler.fetchWithRetry(orderUrl)).rejects.toMatchObject({
      refreshErrorCode: 'TASK_TIMEOUT',
      requestAttempts: 1,
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
    const proxy = require('../src/utils/proxyManager');
    expect(proxy.releaseProxy).toHaveBeenCalledTimes(1);
    expect(proxy.recordProxyFailure).not.toHaveBeenCalled();
  });

  test('代理等待耗尽预算时报告零次，不触发全局暂停', async () => {
    const crawler = loadCrawlerService({ proxyEnabled: true, taskTimeoutMs: 20 });
    const proxy = require('../src/utils/proxyManager');
    proxy.acquireProxy.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    const axios = require('axios');
    axios.get.mockReset();
    await expect(crawler.fetchWithRetry(orderUrl)).rejects.toMatchObject({
      refreshErrorCode: 'TASK_TIMEOUT',
      requestAttempts: 0,
    });
    expect(axios.get).not.toHaveBeenCalled();
    expect(crawler.getAutoRefreshStatus().isPaused).toBe(false);
  });
  const loadingHtml =
    '<title>访客订单 - Apple (中国大陆)</title><script id="init_data">{"meta":{},"guestOrderSpinner":{"d":{}}}</script>';
  const orderHtml = orderNumber =>
    `<script id="init_data">${JSON.stringify({
      orderDetail: {
        orderHeader: { d: { orderNumber } },
        orderItems: {
          'orderItem-1': {
            orderItemDetails: { d: { productName: '合成商品', quantity: 1 } },
            orderItemStatusTracker: { d: { currentStatus: 'PICKED_UP' } },
          },
        },
      },
    })}</script>`;

  test('真实加载页结构先失败换会话重试，详情到达后才记录成功', async () => {
    const crawler = loadCrawlerService({
      proxyEnabled: true,
      proxies: [
        { host: 'proxy-one.example', port: 8080 },
        { host: 'proxy-two.example', port: 8080 },
      ],
    });
    const axios = require('axios');
    axios.get.mockReset();
    axios.get
      .mockResolvedValueOnce({ data: loadingHtml, status: 200 })
      .mockResolvedValueOnce({ data: orderHtml('W1234567890'), status: 200 });
    await expect(crawler.fetchWithRetry(orderUrl)).resolves.toMatchObject({
      success: true,
      data: { orderNumber: 'W1234567890', orderStatus: 'picked_up' },
    });
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(axios.get.mock.calls.map(call => call[1].proxy.host)).toEqual([
      'proxy-one.example',
      'proxy-two.example',
    ]);
    const logger = require('../src/utils/logger');
    expect(logger.warn).toHaveBeenCalledWith(
      '订单爬取失败',
      expect.objectContaining({
        attempt: 1,
        parseReason: 'guest_order_loading',
        pageDiagnostics: expect.objectContaining({
          hasGuestOrderSpinner: true,
          hasOrderDetail: false,
        }),
      })
    );
    expect(logger.info.mock.calls.filter(call => call[0] === '订单爬取成功')).toHaveLength(1);
    expect(require('../src/utils/proxyManager').recordProxySuccess).toHaveBeenCalledTimes(1);
  });

  test.each([null, '', ' ', 'invalid', 123, {}, ['W1234567890']])(
    '缺失或非法身份 %j 属于解析失败，不伪造身份冲突',
    orderNumber => {
      const crawler = loadCrawlerService();
      let caught;
      try {
        crawler.validateCrawledOrderIdentity({ orderNumber }, 'W1234567890');
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ eventType: 'parse', parseReason: 'missing_order_identity' });
    }
  );

  test('连续加载页最多三次后保留旧状态与校验，不写身份暂停', async () => {
    const crawler = loadCrawlerService({
      proxyEnabled: true,
      proxy: { host: 'proxy.example', port: 8080 },
    });
    const axios = require('axios');
    axios.get.mockReset();
    axios.get.mockResolvedValue({ data: loadingHtml, status: 200 });
    const { Order, CrawlLog, sequelize } = require('../src/models');
    Order.update = jest.fn();
    const order = {
      id: 1,
      orderNumber: 'W1234567890',
      orderUrl,
      status: 'ready_for_pickup',
      paymentStatus: 'paid',
      validationStatus: 'valid',
      validationIssues: [],
      autoRefreshEnabled: false,
      autoRefreshStopReason: 'payment_status:paid',
    };
    Order.findByPk.mockResolvedValue(order);
    await expect(crawler.crawlAndUpdateOrder(1, { manual: true })).rejects.toMatchObject({
      eventType: 'parse',
      refreshErrorCode: 'PAGE_LOADING',
      parseReason: 'guest_order_loading',
    });
    expect(axios.get).toHaveBeenCalledTimes(3);
    expect(Order.update).not.toHaveBeenCalled();
    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(order).toMatchObject({
      status: 'ready_for_pickup',
      validationStatus: 'valid',
      validationIssues: [],
    });
    expect(CrawlLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'parse',
        httpStatus: 200,
        context: expect.objectContaining({
          parseReason: 'guest_order_loading',
          pageDiagnostics: expect.objectContaining({ hasGuestOrderSpinner: true }),
        }),
      })
    );
  });

  test('有效但不同的订单号立即拒绝，不重试且不记录成功', async () => {
    const crawler = loadCrawlerService({
      proxyEnabled: true,
      proxy: { host: 'proxy.example', port: 8080 },
    });
    const axios = require('axios');
    axios.get.mockReset();
    axios.get.mockResolvedValue({ data: orderHtml('W9999999999'), status: 200 });
    await expect(crawler.fetchWithRetry(orderUrl)).rejects.toMatchObject({
      eventType: 'order_identity',
      skipFailureIncrement: true,
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(require('../src/utils/proxyManager').recordProxySuccess).not.toHaveBeenCalled();
    expect(JSON.stringify(require('../src/utils/logger').warn.mock.calls)).not.toContain(
      'W9999999999'
    );
  });

  test('损坏 init_data 不回退到其他脚本，三次仍按解析失败结束', async () => {
    const crawler = loadCrawlerService({
      proxyEnabled: true,
      proxy: { host: 'proxy.example', port: 8080 },
    });
    const axios = require('axios');
    axios.get.mockReset();
    axios.get.mockResolvedValue({
      data: '<script id="init_data">{broken</script>' + orderHtml('W1234567890'),
      status: 200,
    });
    await expect(crawler.fetchWithRetry(orderUrl)).rejects.toMatchObject({ eventType: 'parse' });
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  test('非加载页的空身份同样在重试内处理', async () => {
    const crawler = loadCrawlerService({
      proxyEnabled: true,
      proxy: { host: 'proxy.example', port: 8080 },
    });
    const axios = require('axios');
    axios.get.mockReset();
    axios.get
      .mockResolvedValueOnce({ data: orderHtml(null), status: 200 })
      .mockResolvedValueOnce({ data: orderHtml('W1234567890'), status: 200 });
    await expect(crawler.fetchWithRetry(orderUrl)).resolves.toMatchObject({ success: true });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

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
    ).rejects.toThrow('已尝试 3 次');
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
  test('HTTP 541 失败页记录安全诊断，不记录动态跳转或正文', async () => {
    const crawler = loadCrawlerService({
      proxyEnabled: true,
      proxy: { host: 'proxy.example', port: 8080 },
    });
    const axios = require('axios');
    axios.get.mockReset();
    axios.get.mockRejectedValue({
      message: 'HTTP 541',
      response: {
        status: 541,
        data: '<title>Page Not Found - Apple</title><body>secret@example.com</body>',
        request: {
          res: {
            responseUrl:
              'https://secure7.www.apple.com.cn/shop/order/guest/W1234567890/secret-token?e=secret',
          },
        },
      },
    });
    await expect(crawler.fetchWithRetry('https://www.apple.com.cn/order', 1)).rejects.toMatchObject(
      { httpStatus: 541, pageDiagnostics: { titleKind: 'not_found', routeKind: 'guest_order' } }
    );
    expect(JSON.stringify(require('../src/utils/logger').warn.mock.calls)).not.toMatch(/secret/);
  });

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

describe('官网逐台展示副本回归', () => {
  function fixture(mode) {
    const items = {};
    for (let index = 1; index <= 2; index += 1) {
      const suffix = mode === 'different-lines' ? index : 11;
      items[`orderItem-${index}of2-${suffix}`] = {
        orderItemDetails: {
          d: { productName: '测试手机', quantity: 2, eyeBrowNumber: index, eyeBrowQuantity: 2 },
        },
        orderItemStatusTracker: {
          d: {
            currentStatus:
              mode === 'mixed-status' && index === 2
                ? 'PROCESSING'
                : 'PAYMENT_EXPIRED_STORED_ORDER',
          },
        },
      };
    }
    if (mode === 'missing-node') delete items['orderItem-2of2-11'];
    if (mode === 'missing-evidence')
      delete items['orderItem-2of2-11'].orderItemDetails.d.eyeBrowNumber;
    return { orderDetail: { orderItems: items } };
  }
  test('完整同一行两个副本仅保留一行，总数量仍为 2', () => {
    const parsed = loadCrawlerService().parseOrderData(fixture(), '<html></html>');
    expect(parsed.products).toHaveLength(1);
    expect(parsed.products[0].quantity).toBe(2);
    expect(parsed.productsComplete).toBe(true);
    expect(parsed.orderStatus).toBe('payment_expired');
  });
  test.each(['different-lines', 'mixed-status', 'missing-evidence'])(
    '%s 不按名称误合并或丢弃状态',
    mode => {
      const parsed = loadCrawlerService().parseOrderData(fixture(mode), '<html></html>');
      expect(parsed.products).toHaveLength(2);
    }
  );
  test('只有一个节点时不猜测补齐或更改数量', () => {
    const parsed = loadCrawlerService().parseOrderData(fixture('missing-node'), '<html></html>');
    expect(parsed.products).toHaveLength(1);
    expect(parsed.products[0].quantity).toBe(2);
  });
});
