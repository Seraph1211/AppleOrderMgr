/* eslint-disable camelcase -- 隔离数据库字段使用 SQL 命名 */
const suite = process.env.RUN_DASHBOARD_DB === 'true' ? describe : describe.skip;

suite('仪表板统计（正式迁移后的专用 PostgreSQL）', () => {
  let models;
  let service;
  let filters;
  let productKey;
  let recipientIds;
  let controller;
  const productA = { name: 'iPhone 18 Pro Max 勃艮第酒红色 256G', model: 'TEST1CH/A', quantity: 2 };
  const productB = { name: 'iPhone 18 Pro Max 冰川蓝色 512G', model: 'TEST2CH/A', quantity: 1 };

  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_dashboard_test_20260923' ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许仪表板专用隔离库');
    models = require('../src/models');
    service = require('../src/services/dashboardService');
    controller = require('../src/controllers/dashboardController');
    await models.sequelize.query('TRUNCATE orders, recipients RESTART IDENTITY CASCADE');
    const [recipients] = await models.sequelize
      .query(`INSERT INTO recipients (last_name, first_name, id_card_number, status, tag, city, created_at, updated_at) VALUES
      ('合成', '一', 'synthetic-only-1', '未使用', '档案A', '南京', NOW(), NOW()),
      ('合成', '二', 'synthetic-only-2', '使用中', '档案A', '南京', NOW(), NOW()),
      ('合成', '三', 'synthetic-only-3', '已下架', '档案A', '南京', NOW(), NOW()),
      ('合成', '四', 'synthetic-only-4', '未使用', '来源A', '南京', NOW(), NOW()) RETURNING id`);
    recipientIds = recipients.map(row => row.id);
    filters = {
      startDate: '2026-09-23',
      endDate: '2026-09-23',
      orderUser: { orderAccess: { mode: 'tags', tags: ['范围A'] } },
    };
    const stores = await models.PickupStore.findAll({ raw: true });
    const tianjin = stores.find(store => store.city === '天津');
    const overrides = [
      {
        products: [productA, { ...productA, quantity: 1 }],
        emailOrderStatus: 'processing',
        recipientRef: recipientIds[0],
        ingestionSource: 'aos',
        sourceRecipientTag: '来源A',
        emailPickupInfo: { storeName: 'Apple, 三里屯' },
        pickupStoreCode: tianjin.code,
      },
      {
        products: [productA, productB],
        emailOrderStatus: 'ready_for_pickup',
        recipientRef: recipientIds[0],
        emailPickupInfo: { storeName: 'Apple 王府井' },
      },
      { products: [productB], emailOrderStatus: 'confirmed', pickupStoreCode: tianjin.code },
      {
        products: [productA],
        orderDate: '2026-09-22T15:59:59.999Z',
        emailOrderStatus: 'processing',
      },
      {
        products: [{ name: '隐藏商品', quantity: 1 }],
        tag: '范围B',
        emailOrderStatus: 'processing',
      },
      { products: [productA], orderDate: '2026-09-23T16:00:00.000Z' },
      {
        products: [productB],
        emailOrderStatus: 'processing',
        emailPickupInfo: { storeName: '不认识的门店' },
        pickupStoreCode: tianjin.code,
      },
      {
        products: [productA],
        emailOrderStatus: 'processing',
        ingestionSource: 'aos',
        sourceRecipientTag: " O'Reilly,团队 ",
        pickupStore: 'Apple 南京东路',
      },
    ];
    for (const [index, override] of overrides.entries()) {
      const order = await models.Order.create({
        orderNumber: `W${String(9000000000 + index)}`,
        orderDate: '2026-09-22T16:00:00.000Z',
        tag: '范围A',
        ...override,
      });
      await models.Order.update(
        { orderAmount: index === 2 ? null : '100.50' },
        { where: { id: order.id }, hooks: false }
      );
      if (index === 0) productKey = order.productFilterItems[0].key;
    }
  });
  afterAll(async () => {
    if (models) await models.sequelize.close();
  });

  test('应计算订单总数、已付款交集、整单金额和缺失金额', async () => {
    const stats = await service.getStats(filters);
    expect(stats).toMatchObject({
      totalOrders: 5,
      paidOrders: 4,
      totalAmount: 402,
      missingAmountOrders: 1,
      availableRecipients: 3,
    });
    const confirmed = await service.getStats({ ...filters, emailOrderStatuses: ['confirmed'] });
    expect(confirmed).toMatchObject({ totalOrders: 1, paidOrders: 0 });
    const ready = await service.getStats({ ...filters, emailOrderStatuses: ['ready_for_pickup'] });
    expect(ready).toMatchObject({ totalOrders: 1, paidOrders: 1, pendingOrders: 0 });
  });
  test('应按所选档案 TAG 统计可用取机人，忽略日期商品状态', async () => {
    const stats = await service.getStats({
      ...filters,
      recipientTags: ['档案A'],
      startDate: '2030-01-01',
      endDate: '2030-01-01',
      productKeys: [productKey],
      emailOrderStatuses: ['unknown'],
    });
    expect(stats).toMatchObject({ totalOrders: 0, availableRecipients: 2 });
    expect(
      (await service.getStats({ ...filters, recipientTags: ['档案A', '来源A'] }))
        .availableRecipients
    ).toBe(3);
  });
  test('应统一趋势、商品和城市的复合筛选，并保留 AOS 来源 TAG 优先', async () => {
    const selection = {
      ...filters,
      recipientTags: ['来源A'],
      emailOrderStatuses: ['processing'],
      productKeys: [productKey],
    };
    expect((await service.getStats(selection)).totalOrders).toBe(1);
    expect(await service.getDailyTrend(selection)).toEqual([{ date: '2026-09-23', count: 1 }]);
    expect(await service.getProductDistribution(selection)).toEqual([
      { key: productKey, name: productA.name, value: 1 },
    ]);
    expect(await service.getCityDistribution(selection)).toEqual([{ name: '北京', value: 1 }]);
    expect((await service.getStats({ ...filters, recipientTags: ['档案A'] })).totalOrders).toBe(1);
  });
  test('商品应以订单去重，不将多件或重复明细算作多单', async () => {
    const rows = await service.getProductDistribution(filters);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.value)).toEqual([3, 3]);
  });
  test('城市应按门店字典归属，南京东路属于上海；未知邮件门店不回退猜测', async () => {
    const rows = await service.getCityDistribution(filters);
    expect(Object.fromEntries(rows.map(row => [row.name, row.value]))).toEqual({
      北京: 2,
      天津: 1,
      上海: 1,
      未知城市: 1,
    });
    expect(rows.reduce((sum, row) => sum + row.value, 0)).toBe(5);
  });
  test('候选应包含完整商品名称并受其他条件及访问范围限制', async () => {
    const options = await service.getFilterOptions({
      ...filters,
      recipientTags: ['来源A'],
      productKeys: [productKey],
    });
    expect(options.productOptions).toHaveLength(1);
    expect(options.productOptions[0].label).toContain(productA.name);
    expect(options.recipientTags).toContain(" O'Reilly,团队 ");
    expect(options.recipientTags).not.toContain('范围B');
  });
  test('无订单权限时所有订单聚合及候选都为空', async () => {
    const none = { ...filters, orderUser: { orderAccess: { mode: 'tags', tags: [] } } };
    expect((await service.getStats(none)).totalOrders).toBe(0);
    expect(await service.getProductDistribution(none)).toEqual([]);
    expect(await service.getCityDistribution(none)).toEqual([]);
    expect((await service.getFilterOptions(none)).productOptions).toEqual([]);
    expect((await service.getDailyTrend(none)).every(row => row.count === 0)).toBe(true);
  });
  test('特殊 TAG 原文应精确匹配且不能注入 SQL', async () => {
    expect(
      (await service.getStats({ ...filters, recipientTags: [" O'Reilly,团队 "] })).totalOrders
    ).toBe(1);
    expect(
      (await service.getStats({ ...filters, recipientTags: ["' OR 1=1 --"] })).totalOrders
    ).toBe(0);
  });
  test('控制器应拒绝非法参数并传递所有图表筛选', async () => {
    for (const method of [
      'getStats',
      'getDailyTrend',
      'getProductDistribution',
      'getCityDistribution',
      'getStoreDistribution',
      'getFilterOptions',
    ]) {
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await controller[method](
        { user: filters.orderUser, query: { startDate: '2026-02-30' } },
        res
      );
      expect(res.status).toHaveBeenCalledWith(400);
      res.json.mockClear();
      res.status.mockClear();
      await controller[method](
        {
          user: filters.orderUser,
          query: {
            startDate: filters.startDate,
            endDate: filters.endDate,
            productKeys: JSON.stringify([productKey]),
            recipientTags: JSON.stringify(['来源A']),
          },
        },
        res
      );
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].success).toBe(true);
    }
  });
});
