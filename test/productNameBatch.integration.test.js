/* eslint-disable camelcase -- 边界测试刻意使用历史来源字段 */
/** 仅独立新建 PostgreSQL 数据库执行；不连接主开发库或生产。 */
const { Sequelize, QueryTypes } = require('sequelize');
const { randomUUID } = require('node:crypto');
const {
  runProductNameBatch,
  protectedSnapshot,
} = require('../src/services/productNameBatchService');
const { resolveProductName } = require('../src/utils/productNaming');
const migration = require('../migrations/20261015000002-product-name-standardization');
const catalog = require('../src/data/productNamingV20261015.json');
const enabled = process.env.RUN_PRODUCT_NAME_INTEGRATION === 'true';
if (
  enabled &&
  (!/^apple_product_naming_/.test(process.env.DB_NAME_TEST || '') || process.env.DATABASE_URL)
)
  throw new Error('商品名称集成测试只允许独立命名库');
(enabled ? describe : describe.skip)('商品名称真实 PostgreSQL 验证', () => {
  const db = new Sequelize(process.env.DB_NAME_TEST || 'unused', 'postgres', '', {
    host: process.env.DB_HOST,
    dialect: 'postgres',
    logging: false,
  });
  const query = (sql, replacements = {}, transaction) =>
    db.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
  const batchId = randomUUID();
  let historicalId;
  let original;
  afterAll(async () => {
    await db.close();
  });

  test('SQL 与共享规则全部目录/变体一致，冲突及非目标字段原样保留', async () => {
    for (const item of catalog)
      for (const capacity of item.capacityAliases)
        for (const color of item.colorAliases) {
          for (const name of [
            `${item.modelName} ${capacity} ${color}`,
            `${item.modelName} ${color} ${capacity}`,
          ]) {
            const product = { model: item.sku, name, quantity: 2 };
            const [row] = await query(
              'SELECT normalize_business_product_name(CAST(:product AS jsonb)) AS name',
              { product: JSON.stringify(product) }
            );
            expect(row.name).toBe(resolveProductName(product).name);
          }
        }
    for (const product of [
      { model: 'MJY64CH/A', product_sku: 'MJY74CH/A', name: 'iPhone 18 Pro Max 黑色 256GB' },
      { model: 'MJY64CH/A', sku: 'MJY74CH/A', name: 'iPhone 18 Pro Max 256GB 银色' },
      { model: 'MJY64CH/A', productModel: 'iPhone Duo', name: 'iPhone 18 Pro Max 256GB 黑色' },
      { model: 'MJY64CH/A', model_name: 'iPhone Duo', name: 'iPhone 18 Pro Max 黑色 256GB' },
      {
        model: 'MJY64CH/A',
        productName: 'iPhone 18 Pro Max 银色 256GB',
        name: 'iPhone 18 Pro Max 黑色 256GB',
      },
      { model: 'MJY64CH/A', name: 'iPhone 18 Pro Max 黑色 256GB 保护壳' },
      { name: 'iPhone Duo 酒红色 256GB' },
    ]) {
      const [row] = await query(
        'SELECT normalize_business_product_name(CAST(:product AS jsonb)) AS name',
        { product: JSON.stringify(product) }
      );
      expect(row.name).toBe(resolveProductName(product).name);
      expect(row.name).toBe(product.name);
    }
  });

  test('历史分批规范与审计原子，不改金额/updated_at/来源/keys；重复运行无修改', async () => {
    original = [
      {
        model: 'MJYH4CH/A',
        name: 'iPhone 18 Pro Max 1024GB 勃艮第酒红色',
        quantity: 3,
        arbitrary: 'keep',
      },
    ];
    await db.transaction(async transaction => {
      await db.query('ALTER TABLE orders DISABLE TRIGGER orders_product_name_audit', {
        transaction,
      });
      const [row] = await query(
        'INSERT INTO orders(order_number,products,source_snapshot,official_products,order_amount,order_amount_price_version,product_filter_items,updated_at) VALUES (:number,CAST(:products AS jsonb),CAST(:products AS jsonb),CAST(:products AS jsonb),999.99,\'frozen-proof\',\'[{"key":"legacy-key","keys":["legacy-key"]}]\',\'2026-01-01\') RETURNING id',
        { number: `PN${Date.now()}`, products: JSON.stringify(original) },
        transaction
      );
      historicalId = row.id;
      await db.query('ALTER TABLE orders ENABLE TRIGGER orders_product_name_audit', {
        transaction,
      });
    });
    const before = await protectedSnapshot(db);
    const dry = await runProductNameBatch(db, { mode: 'dry-run', batchId, batchSize: 2 });
    expect(dry.candidates).toBeGreaterThan(0);
    expect(dry.changed).toBe(0);
    const applied = await runProductNameBatch(db, { mode: 'apply', batchId, batchSize: 2 });
    expect(applied.changed).toBeGreaterThan(0);
    expect(applied.conflicts).toBe(0);
    expect(applied.protectedUnchanged).toBe(true);
    expect(await protectedSnapshot(db)).toEqual(before);
    const [row] = await query('SELECT products,source_snapshot FROM orders WHERE id=:id', {
      id: historicalId,
    });
    expect(row.products[0].name).toBe('iPhone 18 Pro Max 勃艮第酒红色 1T');
    expect(row.source_snapshot).toEqual(original);
    const audits = await query(
      "SELECT * FROM product_name_changes WHERE entity_type='orders' AND entity_id=:id",
      { id: String(historicalId) }
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].original_name).toBe(original[0].name);
    expect(audits[0].identity).not.toHaveProperty('arbitrary');
    expect((await runProductNameBatch(db, { mode: 'apply' })).changed).toBe(0);
    expect(await runProductNameBatch(db, { mode: 'verify', batchId })).toMatchObject({
      pending: 0,
      invalid: 0,
      currentMismatches: 0,
    });
  });

  test('未来写入事务回滚同时撤销原名审计，提交保留审计', async () => {
    const name = 'iPhone Duo 2048GB 夜空色';
    const [before] = await query('SELECT count(*)::int AS count FROM product_name_changes');
    await expect(
      db.transaction(async transaction => {
        await db.query(
          'INSERT INTO orders(order_number,products) VALUES (:number,CAST(:products AS jsonb))',
          {
            transaction,
            replacements: {
              number: `PN${Date.now()}`,
              products: JSON.stringify([{ model: 'MK2W4CH/A', name, quantity: 1 }]),
            },
          }
        );
        throw new Error('deliberate rollback');
      })
    ).rejects.toThrow('deliberate rollback');
    const [after] = await query('SELECT count(*)::int AS count FROM product_name_changes');
    expect(after.count).toBe(before.count);
    const [saved] = await query(
      'INSERT INTO orders(order_number,products) VALUES (:number,CAST(:products AS jsonb)) RETURNING products',
      {
        number: `PN${Date.now()}X`,
        products: JSON.stringify([{ model: 'MK2W4CH/A', name, quantity: 1 }]),
      }
    );
    expect(saved.products[0].name).toBe('iPhone Duo 夜空色 2T');
  });

  test('verify发现所有可识别身份字段变化，URL及图片不进入审计', async () => {
    const identityFields = [
      'partNumber',
      'product_sku',
      'productId',
      'product_id',
      'modelName',
      'model_name',
      'productModel',
      'colorName',
      'color_name',
      'color',
      'storageGb',
      'storage_gb',
      'capacity',
      'storage',
      'title',
      'productName',
      'product_name',
    ];
    const [saved] = await query('SELECT products FROM orders WHERE id=:id', { id: historicalId });
    for (const field of identityFields) {
      const changed = [{ ...saved.products[0], [field]: 'changed-identity' }];
      await db.query('UPDATE orders SET products=CAST(:products AS jsonb) WHERE id=:id', {
        replacements: { products: JSON.stringify(changed), id: historicalId },
      });
      expect((await runProductNameBatch(db, { mode: 'verify', batchId })).currentMismatches).toBe(
        1
      );
      await db.query('UPDATE orders SET products=CAST(:products AS jsonb) WHERE id=:id', {
        replacements: { products: JSON.stringify(saved.products), id: historicalId },
      });
      expect((await runProductNameBatch(db, { mode: 'verify', batchId })).currentMismatches).toBe(
        0
      );
    }
    const [identity] = await query(
      "SELECT product_name_identity(CAST(:product AS jsonb),'name') AS value",
      {
        product: JSON.stringify({
          ...saved.products[0],
          image: 'private-image',
          actionUrl: 'private-action',
          password: 'private-password',
        }),
      }
    );
    expect(identity.value).not.toHaveProperty('image');
    expect(identity.value).not.toHaveProperty('actionUrl');
    expect(identity.value).not.toHaveProperty('password');
  });

  test('已有原名审计时拒绝破坏性down', async () => {
    await expect(migration.down(db.getQueryInterface())).rejects.toThrow('已有商品原名审计事实');
  });
});
