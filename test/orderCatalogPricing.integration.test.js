jest.mock('../src/utils/telegramNotifier', () => ({ sendTelegramAlert: jest.fn() }));
/* eslint-disable camelcase */
const enabled = process.env.RUN_ORDER_PRICING_DB === 'true';
const { PRICE_VERSION } = require('../src/utils/orderCatalogPricingV1');
const product = { name: 'iPhone 18 Pro Max 黑色 256G', model: 'MJY64CH/A', quantity: 2 };

(enabled ? describe : describe.skip)('订单金额隔离数据库与 HTTP 验收', () => {
  let models;
  let user;
  let server;
  let url;
  let sequence = 7800000000;
  async function create(products = [product], values = {}) {
    try {
      return await models.Order.create({
        orderNumber: `W${++sequence}`,
        appleId: 'pricing@example.test',
        products,
        tag: 'A',
        status: 'pending',
        paymentMethod: '微信',
        orderDate: new Date('2026-09-21T01:00:00Z'),
        ...values,
      });
    } catch (error) {
      throw new Error('合成订单创建失败', { cause: error });
    }
  }
  async function get(path) {
    try {
      const response = await fetch(`${url}/${path}`, {
        headers: { 'x-pricing-role': path.startsWith('payment-dispatch') ? 'admin' : 'operator' },
      });
      expect(response.status).toBe(200);
      return (await response.json()).data;
    } catch (error) {
      throw new Error('合成接口请求失败', { cause: error });
    }
  }
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_pricing_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许独立订单金额测试库');
    models = require('../src/models');
    await models.sequelize.query('TRUNCATE orders, users RESTART IDENTITY CASCADE');
    user = await models.User.create({
      username: 'pricing_owner',
      password: 'Synthetic-password-1!',
      role: 'operator',
    });
    const express = require('express');
    const app = express();
    app.use((req, _res, next) => {
      req.user = {
        id: user.id,
        role: req.headers['x-pricing-role'] === 'admin' ? 'admin' : 'operator',
        orderAccess: { mode: 'tags', tags: ['A'] },
        permissions: [
          'orders.read',
          'orders.export',
          'payment_tasks.read_own',
          'payment_tasks.link.read_own',
          'payment_dispatch.read',
          'channels.read',
          'dashboard.read',
        ],
      };
      next();
    });
    for (const [path, file] of [
      ['orders', 'orders'],
      ['payment-tasks', 'paymentTasks'],
      ['payment-dispatch', 'paymentDispatch'],
      ['channels', 'channels'],
    ])
      app.use(`/${path}`, require(`../src/routes/${file}`));
    app.use(require('../src/middleware/errorHandler'));
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    await models.sequelize.query('TRUNCATE orders CASCADE');
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
  });

  test('AOS 公共入库无需官网即计算，事务回滚不留金额或订单', async () => {
    const { createOrderInTransaction } = require('../src/services/orderIngestionCore');
    const data = {
      orderNumber: `W${++sequence}`,
      appleId: 'pricing@example.test',
      products: [product],
      orderDate: new Date(),
      recipient: { tag: 'A' },
    };
    const order = await models.sequelize.transaction(transaction =>
      createOrderInTransaction(data, transaction, { source: 'aos' })
    );
    expect(order.orderAmount).toBe('21998.00');
    expect(order.officialOrderAmount).toBeFalsy();
    expect(order.lastCrawledAt).toBeFalsy();
    expect(order.orderAmountPriceVersion).toBe(PRICE_VERSION);
    const rollbackNumber = `W${++sequence}`;
    await expect(
      models.sequelize.transaction(async transaction => {
        await createOrderInTransaction({ ...data, orderNumber: rollbackNumber }, transaction, {
          source: 'aos',
        });
        throw new Error('synthetic rollback');
      })
    ).rejects.toThrow('synthetic rollback');
    expect(await models.Order.count({ where: { orderNumber: rollbackNumber } })).toBe(0);
  });

  test('普通、限定字段、批量修改和 upsert 均重算；无关更新不破坏金额', async () => {
    const order = await create();
    await order.update({ products: [{ ...product, quantity: 1 }] }, { fields: ['products'] });
    expect((await order.reload()).orderAmount).toBe('10999.00');
    await models.Order.update(
      { products: [{ ...product, quantity: 0 }] },
      { where: { id: order.id } }
    );
    expect((await order.reload()).orderAmount).toBe('0.00');
    await models.Order.update(
      { products: [{ name: '未知', quantity: 1 }] },
      { where: { id: order.id } }
    );
    expect((await order.reload()).orderAmount).toBeNull();
    await models.Order.bulkCreate(
      [{ orderNumber: order.orderNumber, appleId: 'pricing@example.test', products: [product] }],
      { updateOnDuplicate: ['products'] }
    );
    expect((await order.reload()).orderAmount).toBe('21998.00');
    await order.update({ notes: 'synthetic', officialOrderAmount: '1.00' });
    expect((await order.reload()).orderAmount).toBe('21998.00');
  });

  test('官网金额变化不覆盖映射，官网有效数量变化重算', async () => {
    const order = await create();
    const { mergeOfficialOrder } = require('../src/services/crawler/officialOrderData');
    await order.update(
      mergeOfficialOrder(order, {
        orderStatus: 'processing',
        officialOrderAmount: 1,
        products: [{ ...product, name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 }],
      })
    );
    expect((await order.reload()).orderAmount).toBe('10999.00');
    expect(order.officialOrderAmount).toBe('1.00');
    expect(order.sourceSnapshot.products[0].quantity).toBe(2);
    await order.update(
      mergeOfficialOrder(order, {
        orderStatus: 'processing',
        products: [],
        officialFieldDiagnostics: { amount: 'missing' },
      })
    );
    expect((await order.reload()).orderAmount).toBe('10999.00');
    const { mergeBrowserOrder } = require('../src/services/crawler/browserOrderMerge');
    await order.update(
      mergeBrowserOrder(order, {
        orderStatus: 'processing',
        products: [product],
        officialOrderAmount: 999,
      })
    );
    expect((await order.reload()).orderAmount).toBe('21998.00');
    expect(order.officialOrderAmount).toBe('1.00');
  });

  test('订单、详情、付款两页、付款码、导出统一映射金额，未知保持未知', async () => {
    const known = await create();
    const unknown = await create([{ name: '未映射商品', quantity: 1 }], {
      officialOrderAmount: 888,
    });
    const zero = await create([{ ...product, quantity: 0 }]);
    await models.PaymentTask.bulkCreate(
      [known, unknown, zero].map(order => ({ orderId: order.id, assigneeUserId: user.id }))
    );
    const list = await get('orders');
    expect(list.orders.find(o => o.id === known.id).order_amount).toBe('21998.00');
    const detail = await get(`orders/${known.id}`);
    expect(detail.order_amount).toBe('21998.00');
    for (const path of ['payment-tasks', 'payment-dispatch/tasks']) {
      const tasks = (await get(path)).items;
      expect(tasks.find(t => t.orderId === known.id).orderAmount).toBe('21998.00');
      expect(tasks.find(t => t.orderId === unknown.id).orderAmount).toBeNull();
      expect(tasks.find(t => t.orderId === zero.id).orderAmount).toBe('0.00');
      const task = tasks.find(t => t.orderId === known.id);
      if (path === 'payment-tasks')
        expect((await get(`payment-tasks/${task.id}/payment-code`)).amount).toBe('21998.00');
    }
    const response = await fetch(`${url}/orders/export`);
    expect(response.status).toBe(200);
    const XLSX = require('xlsx');
    const book = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);
    expect(rows.map(r => r.订单金额).sort()).toEqual(['0.00', '21998.00', '待确认'].sort());
    expect(rows.every(r => r.金额来源 === '按官方售价计算')).toBe(true);
  });

  test('仪表板与渠道汇总映射且遵守 TAG 范围、缺失和付款分组', async () => {
    await create([product], { paymentStatus: 'paid', status: 'picked_up' });
    await create([{ name: '未知', quantity: 1 }], { officialOrderAmount: 888 });
    await create([product], { tag: 'B' });
    const stats = await require('../src/services/dashboardService').getStats({
      orderUser: { orderAccess: { mode: 'tags', tags: ['A'] } },
    });
    expect(stats.totalAmount).toBe(21998);
    expect(stats.missingAmountOrders).toBe(1);
    const channels = (await get('channels')).channels;
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      totalAmount: 21998,
      paidAmount: 21998,
      deliveredAmount: 21998,
      missingAmountOrders: 1,
      amountSource: 'catalog',
    });
  });

  test('迁移 down/up 分批回填旧订单，保留全部原字段和更新时间', async () => {
    const order = await create();
    const before = order.toJSON();
    const qi = models.sequelize.getQueryInterface();
    const migration = require('../migrations/20260921000001-add-order-catalog-amount');
    await migration.down(qi);
    await models.sequelize.query(
      `INSERT INTO orders (order_number, apple_id, products, status, created_at, updated_at)
      SELECT 'W' || (7900000000 + n)::text, 'pricing@example.test', CAST(:products AS jsonb), 'pending', NOW(), NOW() FROM generate_series(1,501) n`,
      { replacements: { products: JSON.stringify([product]) } }
    );
    await migration.up(qi, models.Sequelize);
    const after = (await order.reload()).toJSON();
    expect(after).toEqual(before);
    expect(
      await models.Order.count({
        where: { orderAmount: '21998.00', orderAmountPriceVersion: PRICE_VERSION },
      })
    ).toBe(502);
  }, 30000);
});
