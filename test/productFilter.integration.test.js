/* eslint-disable camelcase */
const enabled = process.env.RUN_PRODUCT_FILTER_DB === 'true';
const { buildProductFilterItems } = require('../src/utils/productFilter');
const source = { name: 'iPhone 18 Pro Max 勃艮第酒红色 512G', model: 'MJYD4CH/A', quantity: 1 };
const official = { ...source, name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色' };
const otherProduct = { name: 'iPhone 18 Pro Max 黑色 256G', model: 'MJY64CH/A', quantity: 1 };

(enabled ? describe : describe.skip)('商品筛选隔离 PostgreSQL 与 HTTP 验收', () => {
  let models;
  let server;
  let url;
  let owner;
  let outsider;
  let sequence = 7000000000;
  const keys = JSON.stringify(['sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478']);

  async function create(products, options = {}) {
    try {
      return await models.Order.create({
        orderNumber: `W${++sequence}`,
        products,
        appleId: 'synthetic@example.test',
        tag: 'A',
        status: 'pending',
        orderDate: new Date('2026-09-19T01:00:00Z'),
        ...options,
      });
    } catch (error) {
      throw new Error('商品筛选处理失败', { cause: error });
    }
  }
  async function get(path, query = {}, as = 'admin') {
    try {
      const response = await fetch(`${url}/${path}?${new URLSearchParams(query)}`, {
        headers: { 'x-synthetic-role': as },
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      throw new Error('商品筛选处理失败', { cause: error });
    }
  }
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_product_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许独立商品筛选测试库');
    models = require('../src/models');
    await models.sequelize.query('TRUNCATE orders, users RESTART IDENTITY CASCADE');
    owner = await models.User.create({
      username: 'product_owner',
      password: 'Synthetic-password-1!',
      role: 'operator',
    });
    outsider = await models.User.create({
      username: 'product_other',
      password: 'Synthetic-password-1!',
      role: 'operator',
    });
    const express = require('express');
    const app = express();
    app.use((req, _res, next) => {
      const role = req.headers['x-synthetic-role'];
      req.user = {
        id: owner.id,
        role: role === 'admin' ? 'admin' : 'operator',
        orderAccess: { mode: 'tags', tags: ['A'] },
        permissions:
          role === 'denied'
            ? []
            : ['orders.read', 'orders.export', 'payment_tasks.read_own', 'payment_dispatch.read'],
      };
      next();
    });
    for (const [path, file] of [
      ['orders', 'orders'],
      ['payment-tasks', 'paymentTasks'],
      ['payment-dispatch', 'paymentDispatch'],
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

  test('官网从未成功也能跨来源归组，三页在分页前精确筛选', async () => {
    const a = await create([source, source]);
    const b = await create([official], { validationStatus: 'unavailable' });
    const c = await create([otherProduct]);
    await models.PaymentTask.bulkCreate(
      [a, b, c].map(order => ({ orderId: order.id, assigneeUserId: owner.id }))
    );
    for (const path of ['orders', 'payment-tasks', 'payment-dispatch/tasks']) {
      const response = await get(path, { productKeys: keys, limit: 1 });
      expect(response.status).toBe(200);
      const data = response.body.data;
      expect(path === 'orders' ? data.total : data.pagination.total).toBe(2);
      expect((data.orders || data.items)[0].products[0].filterKeys).toContain('sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478');
    }
    const options = await get('orders/filter-options', { productKeys: keys });
    expect(options.body.data.productOptions).toHaveLength(2);
    expect(
      options.body.data.productOptions.find(option => option.value === 'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478').count
    ).toBe(2);
  });

  test('候选、别名与计数遵守订单 TAG 和本人任务范围；其他条件 AND', async () => {
    const a = await create([source]);
    const b = await create([{ ...otherProduct, name: '范围外私有名称' }], { tag: 'B' });
    await models.PaymentTask.bulkCreate([
      { orderId: a.id, assigneeUserId: owner.id },
      { orderId: b.id, assigneeUserId: outsider.id },
    ]);
    const scoped = await get('orders/filter-options', {}, 'staff');
    expect(scoped.body.data.productOptions).toHaveLength(1);
    expect(JSON.stringify(scoped.body)).not.toContain('范围外私有名称');
    const own = await get('payment-tasks', {}, 'staff');
    expect(own.body.data.productOptions).toHaveLength(1);
    expect(JSON.stringify(own.body)).not.toContain('范围外私有名称');
    for (const path of ['orders', 'payment-tasks', 'payment-dispatch/tasks']) {
      const response = await get(path, { productKeys: keys, dateFrom: '2026-09-20' });
      expect(response.status).toBe(200);
      expect(response.body.data.orders || response.body.data.items).toHaveLength(0);
    }
    expect((await get('orders', {}, 'denied')).status).toBe(403);
    expect((await get('orders', { productKeys: '["invalid"]' })).status).toBe(400);
  });

  test('官网补充 SKU 保留旧键、属性冲突不继续命中旧 SKU，批量更新也同步索引', async () => {
    const order = await create([{ ...source, model: null }]);
    const oldKey = order.productFilterItems[0].key;
    await order.update({ products: [official] });
    await order.reload();
    expect(order.productFilterItems[0].keys).toContain(oldKey);
    expect((await get('orders', { productKeys: JSON.stringify([oldKey]) })).body.data.total).toBe(
      1
    );
    await models.Order.update({ products: [otherProduct] }, { where: { id: order.id } });
    await order.reload();
    expect(order.productFilterItems[0].key).toBe('sku:MJY64CH/A:4a8edec7d075531604683476fdda6c8896245f9d0eb84bdc970ce67b36080312');
    expect((await get('orders', { productKeys: keys })).body.data.total).toBe(0);
  });

  test('旧商品参数与新键必须命中同一项，多商品订单仅返回一次', async () => {
    const order = await create([source, otherProduct]);
    await models.PaymentTask.create({ orderId: order.id, assigneeUserId: owner.id });
    for (const path of ['orders', 'payment-tasks', 'payment-dispatch/tasks']) {
      const response = await get(path, {
        productKeys: keys,
        productNames: JSON.stringify([otherProduct.name]),
      });
      expect(response.status).toBe(200);
      expect(response.body.data.orders || response.body.data.items).toHaveLength(0);
      const legacy = await get(path, { productNames: JSON.stringify([source.name]) });
      expect(legacy.body.data.orders || legacy.body.data.items).toHaveLength(1);
    }
  });

  test('迁移 down/up 对存量回填且不改变业务数据和更新时间；超过 5000 单不截断候选', async () => {
    const order = await create([{ ...official, model: null }], {
      sourceSnapshot: { products: [source] },
    });
    const before = order.toJSON();
    const migration = require('../migrations/20260920000001-add-product-filter-items');
    const qi = models.sequelize.getQueryInterface();
    await migration.down(qi);
    const { previewProductFilters } = require('../scripts/previewProductFilters');
    expect((await previewProductFilters(models.sequelize)).options[0].value).toBe('sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478');
    await migration.up(qi, models.Sequelize);
    await order.reload();
    expect(order.products).toEqual(before.products);
    expect(order.updatedAt).toEqual(before.updatedAt);
    expect(order.productFilterItems[0].model).toBe('MJYD4CH/A');
    await models.sequelize.query(
      `INSERT INTO orders (order_number, apple_id, products, product_filter_items, status, created_at, updated_at)
      SELECT 'W' || (9000000000 + n)::text, 'bulk@example.test', CAST(:products AS jsonb), CAST(:items AS jsonb), 'pending', NOW(), NOW() FROM generate_series(1,5001) n`,
      {
        replacements: {
          products: JSON.stringify([otherProduct]),
          items: JSON.stringify(buildProductFilterItems([otherProduct])),
        },
      }
    );
    const options = (await get('orders/filter-options')).body.data.productOptions;
    expect(options.find(option => option.value === 'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478').count).toBe(1);
    expect(options.find(option => option.value === 'sku:MJY64CH/A:4a8edec7d075531604683476fdda6c8896245f9d0eb84bdc970ce67b36080312').count).toBe(5001);
  }, 30000);
});
