const crypto = require('crypto');
const enabled = process.env.RUN_DUO_ACCEPTANCE_DB === 'true';
if (
  enabled &&
  (process.env.DB_NAME !== 'apple_order_mgr_duo_acceptance_1015' ||
    process.env.DB_HOST !== 'postgres' ||
    process.env.DATABASE_URL)
)
  throw new Error('独立Duo验收只允许指定隔离库');

(enabled ? describe : describe.skip)('Duo 独立真实 PostgreSQL 验收', () => {
  const db = require('../src/models');
  const migration = require('../migrations/20261015000001-add-iphone-duo-catalog');
  const command = require('../src/services/stockCommandService');
  const ledger = require('../src/services/stockLedgerService');
  const InventoryService = require('../src/services/inventoryService');
  const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
  const oldSeed = require('../src/data/inventoryCatalog.json');
  let admin, warehouse, oldProduct, oldUnit, oldOrder, historical, products;
  let sequence = 0;
  const serial = () => `DA${String(++sequence).padStart(8, '0')}`;
  const snapshot = async () => {
    try {
      const tables = [
        'inventory_products',
        'inventory_settings',
        'inventory_runtime',
        'stock_products',
        'stock_official_prices',
        'stock_units',
        'orders',
      ];
      const result = {};
      for (const table of tables)
        result[table] = (await db.sequelize.query(`SELECT * FROM ${table} ORDER BY id`))[0];
      return result;
    } catch (error) {
      throw new Error('独立快照失败', { cause: error });
    }
  };
  const execute = async (method, input) => {
    try {
      const payload = { requestKey: crypto.randomUUID(), ...input };
      return await command.runCommand(
        admin,
        payload,
        `duo.acceptance.${method}`,
        ['stock.read'],
        ctx => ledger[method](ctx, payload)
      );
    } catch (error) {
      throw new Error('Duo独立库存命令失败', { cause: error });
    }
  };
  beforeAll(async () => {
    try {
      await db.sequelize.authenticate();
      expect(await db.StockUnit.count()).toBe(0);
      admin = await db.User.create({
        username: 'duo_independent_acceptance',
        password: crypto.randomBytes(24).toString('hex'),
        role: 'admin',
      });
      warehouse = await db.StockLocation.create({
        name: 'Duo独立合成仓',
        kind: 'warehouse',
        city: '合成城市',
      });
      await db.StockSetting.update({ enabled: true }, { where: { id: 1 } });
      oldProduct = await db.StockProduct.findOne({ where: { skuCode: 'MJY64CH/A' } });
      await oldProduct.update({ isActive: false });
      oldUnit = await db.StockUnit.create({
        serialNumber: serial(),
        productId: oldProduct.id,
        state: 'registered',
        originMode: 'legacy_binding',
        costStatus: 'confirmed',
        costSource: 'manual',
        officialCostAmount: '12345.00',
      });
      oldOrder = await db.Order.create({
        orderNumber: 'W7999999991',
        appleId: 'duo-synthetic@example.test',
        products: [{ name: 'iPhone 18 Pro 256GB 黑色', quantity: 2 }],
        status: 'pending',
        paymentMethod: '微信',
        orderDate: new Date('2026-10-01T12:00:00Z'),
      });
      await db.InventoryProduct.destroy({ where: {} });
      const historicalProducts = oldSeed.products.map((item, index) => ({
        id: item.sku,
        body: { ...item, enabled: index % 3 === 0, supported: true, historicalMarker: index },
      }));
      expect(historicalProducts).toHaveLength(65);
      await db.InventoryProduct.bulkCreate(historicalProducts);
      await db.InventoryRuntime.upsert({
        id: 'main',
        body: { seeded: true, customRuntime: 'preserve', roundId: null },
      });
      await db.InventorySetting.upsert({
        id: 'main',
        body: {
          version: 3,
          config: {
            ...DEFAULT_CONFIG,
            enabled: true,
            notificationsEnabled: true,
            groupName: '合成不可发送',
          },
        },
      });
      historical = await snapshot();
    } catch (error) {
      throw new Error('Duo独立夹具初始化失败', { cause: error });
    }
  });
  afterAll(async () => {
    try {
      await db.sequelize.close();
    } catch (error) {
      throw new Error('Duo独立数据库关闭失败', { cause: error });
    }
  });

  test('应该在末尾SKU身份冲突时整批回滚而不留下前7项', async () => {
    let conflict;
    try {
      conflict = await db.StockProduct.create({
        modelKey: 'conflict',
        modelName: '错误型号',
        storageGb: 2048,
        colorKey: 'conflict',
        colorName: '夜空色',
        skuCode: 'MK2W4CH/A',
      });
      const before = await snapshot();
      await expect(migration.up(db.sequelize.getQueryInterface())).rejects.toThrow('冲突');
      expect(await snapshot()).toEqual(before);
    } finally {
      if (conflict) await conflict.destroy();
    }
  });

  test('应该增量迁移8项且完整保留65监控历史、开关、成本、旧价与订单', async () => {
    await migration.up(db.sequelize.getQueryInterface());
    const after = await snapshot();
    for (const table of ['inventory_settings', 'inventory_runtime', 'stock_units', 'orders'])
      expect(after[table]).toEqual(historical[table]);
    for (const table of ['inventory_products', 'stock_products', 'stock_official_prices']) {
      const ids = new Set(historical[table].map(row => row.id));
      expect(after[table].filter(row => ids.has(row.id))).toEqual(historical[table]);
      expect(after[table]).toHaveLength(historical[table].length + 8);
    }
    const added = after.inventory_products.filter(row => row.body.model === 'iPhone Duo');
    expect(added).toHaveLength(8);
    expect(added.every(row => row.body.enabled === false)).toBe(true);
    products = await db.StockProduct.findAll({
      where: { modelName: 'iPhone Duo' },
      order: [['skuCode', 'ASC']],
    });
  });

  test('应该幂等保留新增项人工停用和监控启停，空事实down不删目录', async () => {
    await products[0].update({ isActive: false });
    const first = await db.InventoryProduct.findByPk(products[0].skuCode);
    await first.update({ body: { ...first.body, enabled: true } });
    const before = await snapshot();
    await migration.up(db.sequelize.getQueryInterface());
    expect(await snapshot()).toEqual(before);
    await migration.down(db.sequelize.getQueryInterface());
    expect(await snapshot()).toEqual(before);
    await products[0].update({ isActive: true });
  });

  test('应该拒绝同规格英文别名歧义并保持事务原样', async () => {
    let alias;
    try {
      alias = await db.StockProduct.create({
        modelKey: 'alias',
        modelName: 'iPhone Duo',
        storageGb: 256,
        colorKey: 'alias',
        colorName: 'Star White',
      });
      const before = await snapshot();
      await expect(migration.up(db.sequelize.getQueryInterface())).rejects.toThrow('冲突');
      expect(await snapshot()).toEqual(before);
    } finally {
      if (alias) await alias.destroy();
    }
  });

  test('应该对同版本冲突价拒绝迁移且不重写价格', async () => {
    const price = await db.StockOfficialPrice.findOne({ where: { productId: products[7].id } });
    const amount = price.amount;
    try {
      await price.update({ amount: '1.00' });
      const before = await snapshot();
      await expect(migration.up(db.sequelize.getQueryInterface())).rejects.toThrow('价格冲突');
      expect(await snapshot()).toEqual(before);
    } finally {
      await price.update({ amount });
    }
  });

  test('应该将全部8规格入库赋正确版本及单价并保护down', async () => {
    const result = await execute('receiveUnits', {
      units: products.map(product => ({
        serialNumber: serial(),
        productId: product.id,
        warehouseId: warehouse.id,
        receivedOn: '2026-10-15',
      })),
    });
    const units = await db.StockUnit.findAll({ where: { id: result.ledgerUnitIds } });
    expect(units).toHaveLength(8);
    for (const unit of units) {
      const price = await db.StockOfficialPrice.findByPk(unit.priceId);
      expect(price.sourceVersion).toBe('cn-iphone-duo-20261015');
      expect(unit.officialCostAmount).toBe(price.amount);
      expect(unit.costSource).toBe('fixed_catalog');
      expect(unit.state).toBe('in_stock');
    }
    await expect(migration.down(db.sequelize.getQueryInterface())).rejects.toThrow('拒绝回退');
    expect((await oldUnit.reload()).officialCostAmount).toBe('12345.00');
    expect((await oldOrder.reload()).orderAmount).toBe('19998.00');
    expect(oldOrder.orderAmountPriceVersion).toBe('cn-iphone18-20260921');
  });

  test('应该支持已有及未入库Duo出库并保存独立销售成本快照', async () => {
    const existing = await db.StockUnit.findOne({
      where: { productId: products[1].id, state: 'in_stock' },
    });
    const common = {
      soldOn: '2026-10-15',
      salespersonName: '独立合成销售',
      handlerName: '独立合成经手',
      payment: { status: 'unpaid' },
    };
    const a = await execute('dispatchUnit', {
      ...common,
      unit: {
        id: existing.id,
        serialNumber: existing.serialNumber,
        expectedVersion: existing.version,
        needsReceive: false,
        productId: products[1].id,
        saleAmount: '20000.00',
      },
    });
    const freshSerial = serial();
    const b = await execute('dispatchUnit', {
      ...common,
      unit: {
        serialNumber: freshSerial,
        needsReceive: true,
        productId: products[7].id,
        warehouseId: warehouse.id,
        receivedOn: '2026-10-15',
        saleAmount: '30000.00',
      },
    });
    for (const result of [a, b]) {
      const unit = await db.StockUnit.findByPk(result.ledgerUnitIds[0]);
      const sale = await db.StockSaleUnit.findOne({ where: { stockUnitId: unit.id } });
      expect(unit.state).toBe('sold');
      expect(sale.costAmountSnapshot).toBe(unit.officialCostAmount);
    }
    expect(
      (await db.StockUnit.findOne({ where: { serialNumber: freshSerial } })).officialCostAmount
    ).toBe('26499.00');
  });

  test('应该仅扩大可见白名单并保留所有历史65记录', async () => {
    const service = new InventoryService(db);
    const catalog = await service.catalog();
    expect(catalog.products).toHaveLength(40);
    expect(catalog.products.filter(row => row.model === 'iPhone Duo')).toHaveLength(8);
    expect(await db.InventoryProduct.count()).toBe(73);
    const setting = await db.InventorySetting.findByPk('main');
    expect(setting.body.config.enabled).toBe(true);
    expect(setting.body.config.notificationsEnabled).toBe(true);
  });
});
