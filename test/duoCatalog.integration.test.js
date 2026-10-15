const crypto = require('crypto');
const enabled = process.env.RUN_DUO_DEV_DB === 'true';
if (
  enabled &&
  (process.env.DB_NAME !== 'apple_order_mgr_duo_dev_1015' ||
    process.env.DB_NAME_TEST !== process.env.DB_NAME ||
    process.env.DATABASE_URL)
)
  throw new Error('仅允许Duo开发隔离库');
(enabled ? describe : describe.skip)('Duo正式迁移与真实库存订单业务', () => {
  const db = enabled ? require('../src/models') : null;
  const migration = require('../migrations/20261015000001-add-iphone-duo-catalog');
  const InventoryService = require('../src/services/inventoryService');
  const command = require('../src/services/stockCommandService');
  const ledger = require('../src/services/stockLedgerService');
  const projection = require('../src/services/stockLedgerProjectionService');
  const { CATALOG } = require('../src/services/stockFixedCatalog');
  const prefix = crypto.randomBytes(3).toString('hex').toUpperCase();
  let admin, warehouse, products;
  const serial = index => `D${prefix}${String(index).padStart(3, '0')}`;
  async function execute(method, input) {
    try {
      const payload = { requestKey: crypto.randomUUID(), ...input };
      return await command.runCommand(admin, payload, `duo.${method}`, ['stock.read'], ctx =>
        ledger[method](ctx, payload)
      );
    } catch (error) {
      throw new Error(`Duo业务验证失败: ${error.message}`, { cause: error });
    }
  }
  beforeAll(async () => {
    try {
      await db.sequelize.authenticate();
      products = await db.StockProduct.findAll({
        where: { modelName: 'iPhone Duo' },
        order: [['skuCode', 'ASC']],
      });
      admin = await db.User.create({
        username: `duo_${prefix}`,
        password: crypto.randomBytes(20).toString('hex'),
        role: 'admin',
      });
      warehouse = await db.StockLocation.create({
        name: `Duo合成仓${prefix}`,
        kind: 'warehouse',
        city: '重庆',
      });
      await db.StockSetting.update({ enabled: true }, { where: { id: 1 } });
    } catch (error) {
      throw new Error('Duo隔离夹具失败', { cause: error });
    }
  });
  afterAll(async () => {
    try {
      await db.sequelize.close();
    } catch (error) {
      throw new Error('Duo关闭失败', { cause: error });
    }
  });
  test('up/down/up幂等保留旧目录、启停、配置及历史字段', async () => {
    try {
      const service = new InventoryService(db);
      await service.catalog();
      const existing = await db.InventoryProduct.findByPk('MJY64CH/A');
      await existing.update({
        body: { ...existing.body, enabled: true, customHistory: 'preserve' },
      });
      const prior = JSON.stringify(
        await db.InventoryProduct.findAll({ order: [['id', 'ASC']], raw: true })
      );
      const settings = JSON.stringify((await db.InventorySetting.findByPk('main')).toJSON());
      const product = products[0];
      await product.update({ isActive: false });
      await migration.up(db.sequelize.getQueryInterface());
      await migration.down(db.sequelize.getQueryInterface());
      await migration.up(db.sequelize.getQueryInterface());
      expect(
        JSON.stringify(await db.InventoryProduct.findAll({ order: [['id', 'ASC']], raw: true }))
      ).toBe(prior);
      expect(JSON.stringify((await db.InventorySetting.findByPk('main')).toJSON())).toBe(settings);
      expect((await product.reload()).isActive).toBe(false);
      await product.update({ isActive: true });
      expect(await db.StockProduct.count()).toBe(24);
      expect(await db.StockOfficialPrice.count()).toBe(24);
      expect(await db.InventoryProduct.count()).toBe(40);
      expect(
        (await service.catalog()).products
          .filter(p => p.model === 'iPhone Duo')
          .every(p => !p.enabled)
      ).toBe(true);
    } catch (error) {
      throw new Error('Duo迁移幂等失败', { cause: error });
    }
  });
  test('价格冲突整批回滚，不改原价格', async () => {
    try {
      const price = await db.StockOfficialPrice.findOne({ where: { productId: products[0].id } });
      const amount = price.amount;
      await price.update({ amount: '1.00' });
      await expect(migration.up(db.sequelize.getQueryInterface())).rejects.toThrow('固定价格冲突');
      expect((await price.reload()).amount).toBe('1.00');
      await price.update({ amount });
    } catch (error) {
      throw new Error('Duo迁移冲突失败', { cause: error });
    }
  });
  test('8规格入库固定成本快照准确，旧规格成本保持', async () => {
    try {
      const result = await execute('receiveUnits', {
        units: products.map((product, index) => ({
          serialNumber: serial(index),
          productId: product.id,
          warehouseId: warehouse.id,
          receivedOn: '2026-10-15',
        })),
      });
      expect(result.ledgerUnitIds).toHaveLength(8);
      const units = await db.StockUnit.findAll({ where: { id: result.ledgerUnitIds } });
      for (const unit of units) {
        const product = products.find(row => row.id === unit.productId);
        const spec = CATALOG.find(row => row.skuCode === product.skuCode);
        expect(unit.officialCostAmount).toBe(spec.amount);
        expect(unit.costSource).toBe('fixed_catalog');
        expect((await db.StockOfficialPrice.findByPk(unit.priceId)).sourceVersion).toBe(
          'cn-iphone-duo-20261015'
        );
      }
      const catalog = await projection.catalog(await command.createReadContext(admin));
      expect(catalog.products.filter(p => p.entryEligible)).toHaveLength(24);
      expect(catalog.products.find(p => p.skuCode === 'MK2M4CH/A')).toMatchObject({
        fixedCostAmount: '15999.00',
        priceVersion: 'cn-iphone-duo-20261015',
      });
      expect(catalog.products.find(p => p.skuCode === 'MJY64CH/A')).toMatchObject({
        fixedCostAmount: '10999.00',
        priceVersion: 'cn-iphone18-20260921',
      });
    } catch (error) {
      throw new Error('Duo入库失败', { cause: error });
    }
  });
  test('出库既有库存与直接补入出库均保留Duo成本和销售历史', async () => {
    try {
      const unit = await db.StockUnit.findOne({ where: { serialNumber: serial(0) } });
      for (const data of [
        {
          serialNumber: unit.serialNumber,
          id: unit.id,
          expectedVersion: unit.version,
          needsReceive: false,
          productId: unit.productId,
        },
        {
          serialNumber: serial(20),
          needsReceive: true,
          productId: products[0].id,
          warehouseId: warehouse.id,
          receivedOn: '2026-10-15',
        },
      ]) {
        await execute('dispatchUnit', {
          unit: { ...data, saleAmount: '18000.00', settlementAmount: '17800.00' },
          salespersonName: `销售${prefix}`,
          handlerName: `经办${prefix}`,
          soldOn: '2026-10-15',
          payment: { status: 'unpaid' },
        });
        const saved = await db.StockUnit.findOne({ where: { serialNumber: data.serialNumber } });
        expect(saved.state).toBe('sold');
        expect(saved.officialCostAmount).toBe('15999.00');
      }
      await expect(migration.down(db.sequelize.getQueryInterface())).rejects.toThrow(
        '已有 Duo 业务事实'
      );
    } catch (error) {
      throw new Error('Duo出库失败', { cause: error });
    }
  });
  test('订单新建、混合金额、普通更新保留金额与商品更新重算', async () => {
    try {
      const order = await db.Order.create({
        orderNumber: `W${Date.now().toString().slice(-10)}`,
        products: [
          { name: 'iPhone Duo 星光白色 256GB', model: 'MK2M4CH/A', quantity: 2 },
          { name: 'iPhone 18 Pro Max 黑色 256GB', quantity: 1 },
        ],
        status: 'pending',
      });
      expect(order.orderAmount).toBe('42997.00');
      expect(order.orderAmountPriceVersion).toBe('cn-iphone-duo-20261015');
      await db.sequelize.query(
        "UPDATE orders SET order_amount=1,order_amount_price_version='legacy-test' WHERE id=:id",
        { replacements: { id: order.id } }
      );
      await order.reload();
      await order.update({ notes: '合成无商品变更' });
      expect((await order.reload()).orderAmount).toBe('1.00');
      expect(order.orderAmountPriceVersion).toBe('legacy-test');
      await order.update({ products: [{ name: 'iPhone Duo 2TB 夜空色', quantity: 3 }] });
      expect((await order.reload()).orderAmount).toBe('79497.00');
      await migration.up(db.sequelize.getQueryInterface());
      expect((await order.reload()).orderAmount).toBe('79497.00');
    } catch (error) {
      throw new Error('Duo订单金额失败', { cause: error });
    }
  });
});
