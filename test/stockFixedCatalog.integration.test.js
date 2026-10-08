const crypto = require('crypto');
const logger = require('../src/utils/logger');
const enabled = process.env.RUN_STOCK_BOX_INTEGRATION === 'true';
if (
  enabled &&
  (process.env.DB_NAME !== 'apple_order_mgr_stock_test_1009' ||
    process.env.DB_NAME_TEST !== process.env.DB_NAME ||
    process.env.DATABASE_URL)
)
  throw new Error('仅允许盒标专用合成库1009');
(enabled ? describe : describe.skip)('固定目录真实 PostgreSQL', () => {
  const db = require('../src/models');
  const command = require('../src/services/stockCommandService');
  const ledger = require('../src/services/stockLedgerService');
  const projection = require('../src/services/stockLedgerProjectionService');
  const migration = require('../migrations/20261004000003-stock-fixed-catalog');
  const prefix = crypto.randomBytes(3).toString('hex').toUpperCase();
  let admin, limited, warehouse, products;
  let sequence = 0;
  const serial = () => `B${prefix}${String(++sequence).padStart(3, '0')}`;
  const input = (product = products[0]) => ({
    serialNumber: serial(),
    productId: product.id,
    warehouseId: warehouse.id,
    receivedOn: '2026-10-04',
  });
  async function execute(method, units, actor = admin, extra = {}, key = crypto.randomUUID()) {
    try {
      const payload = { units, requestKey: key, ...extra };
      return await command.runCommand(actor, payload, `box.${method}`, ['stock.read'], ctx =>
        ledger[method](ctx, payload)
      );
    } catch (error) {
      logger.debug('合成测试', { code: error.code });
      throw error;
    }
  }
  beforeAll(async () => {
    try {
      await db.sequelize.authenticate();
      products = await db.StockProduct.findAll({
        where: { modelName: 'iPhone 18 Pro Max' },
        order: [['skuCode', 'ASC']],
      });
      admin = await db.User.create({
        username: `box_admin_${prefix}`,
        password: crypto.randomBytes(20).toString('hex'),
        role: 'admin',
      });
      limited = await db.User.create({
        username: `box_operator_${prefix}`,
        password: crypto.randomBytes(20).toString('hex'),
        role: 'operator',
      });
      await db.UserPermission.bulkCreate(
        [
          'stock.read',
          'stock.receive',
          'stock.import',
          'stock.sales.edit',
          'stock.sales.ship',
          'stock.sales.read',
        ].map(permissionCode => ({ userId: limited.id, permissionCode }))
      );
      warehouse = await db.StockLocation.create({
        name: `盒标合成仓${prefix}`,
        kind: 'warehouse',
        city: '重庆',
      });
      await db.StockSetting.update({ enabled: true }, { where: { id: 1 } });
    } catch (error) {
      logger.debug('合成测试', { code: error.code });
      throw error;
    }
  });
  afterAll(async () => {
    try {
      await db.sequelize.close();
    } catch (error) {
      logger.debug('合成测试关闭', { code: error.code });
      throw error;
    }
  });
  test('迁移重复运行保持16身份、停用和价格；无新事实可down再up', async () => {
    try {
      const before = await db.StockProduct.count();
      await products[0].update({ isActive: false });
      await migration.up(db.sequelize.getQueryInterface());
      expect(await db.StockProduct.count()).toBe(before);
      expect((await products[0].reload()).isActive).toBe(false);
      if (await db.StockUnit.count({ where: { costSource: 'fixed_catalog' } }))
        await expect(migration.down(db.sequelize.getQueryInterface())).rejects.toThrow(
          '拒绝破坏性回退'
        );
      else await migration.down(db.sequelize.getQueryInterface());
      await migration.up(db.sequelize.getQueryInterface());
      await products[0].update({ isActive: true });
    } catch (error) {
      logger.debug('合成测试', { code: error.code });
      throw error;
    }
  });
  test('同规格别名冲突拒绝，历史身份不合并', async () => {
    let conflict;
    try {
      conflict = await db.StockProduct.create({
        modelKey: `alias_${prefix}`,
        modelName: 'iPhone 18 Pro Max',
        storageGb: 256,
        colorKey: `alias_${prefix}`,
        colorName: 'Black',
      });
      await expect(migration.up(db.sequelize.getQueryInterface())).rejects.toThrow('库存规格冲突');
    } catch (error) {
      logger.debug('合成测试', { code: error.code });
      throw error;
    } finally {
      if (conflict) await conflict.destroy();
    }
  });
  test('16规格混合入库后台赋价，未知日期保持null，读回priceId和source', async () => {
    try {
      const result = await execute(
        'receiveUnits',
        products.map(product => input(product)),
        limited
      );
      const rows = await db.StockUnit.findAll({ where: { id: result.ledgerUnitIds } });
      expect(rows).toHaveLength(16);
      for (const row of rows) {
        expect(row.costSource).toBe('fixed_catalog');
        expect(row.acquiredOn).toBeNull();
        expect(row.priceId).toBeTruthy();
        expect(row.costStatus).toBe('confirmed');
      }
      const context = await command.createReadContext(limited);
      const dto = await projection.detail(context, rows[0].id);
      expect(JSON.stringify(dto)).not.toMatch(
        /officialCostAmount|fixedCostAmount|priceId|costSource/
      );
      const catalog = await projection.catalog(context);
      expect(JSON.stringify(catalog)).not.toMatch(/fixedCostAmount|priceVersion/);
      await expect(migration.down(db.sequelize.getQueryInterface())).rejects.toThrow(
        '拒绝破坏性回退'
      );
    } catch (error) {
      logger.debug('合成测试', { code: error.code });
      throw error;
    }
  });
  test.each([null, '0', '10999.00'])('普通人员显式成本 %s 被拒绝', async amount => {
    try {
      await expect(
        execute('receiveUnits', [{ ...input(), officialCostAmount: amount }], limited)
      ).rejects.toMatchObject({ statusCode: 403 });
    } catch (error) {
      logger.debug('合成测试', { code: error.code });
      throw error;
    }
  });
  test('已核定身份保留原价格引用/成本来源/金额，不覆盖', async () => {
    try {
      const item = input();
      const unit = await db.StockUnit.create({
        serialNumber: item.serialNumber,
        productId: item.productId,
        state: 'registered',
        originMode: 'legacy_binding',
        costStatus: 'confirmed',
        costSource: 'manual',
        officialCostAmount: '12345.00',
      });
      await execute('receiveUnits', [item], limited);
      await unit.reload();
      expect(unit.officialCostAmount).toBe('12345.00');
      expect(unit.costSource).toBe('manual');
      expect(unit.priceId).toBeNull();
    } catch (error) {
      logger.debug('合成测试', { code: error.code });
      throw error;
    }
  });
  test('同批重复/第二行失败整体回滚；幂等重放只一台', async () => {
    try {
      const item = input();
      const key = crypto.randomUUID();
      const a = await execute('receiveUnits', [item], admin, {}, key);
      const b = await execute('receiveUnits', [item], admin, {}, key);
      expect(b.ledgerUnitIds).toEqual(a.ledgerUnitIds);
      expect(b.idempotent).toBe(true);
      const fresh = input();
      await expect(execute('receiveUnits', [fresh, item])).rejects.toMatchObject({
        details: { row: 2 },
      });
      expect(await db.StockUnit.count({ where: { serialNumber: fresh.serialNumber } })).toBe(0);
      await expect(execute('receiveUnits', [fresh, fresh])).rejects.toMatchObject({
        code: 'SN_EXISTS',
      });
    } catch (error) {
      logger.debug('合成测试', { code: error.code });
      throw error;
    }
  });
  test('历史补录独立价格快照，不改变现货', async () => {
    try {
      const before = await db.StockUnit.count({ where: { state: 'in_stock' } });
      const result = await execute(
        'importHistory',
        products
          .slice(0, 2)
          .map(product => ({ ...input(product), receivedOn: null, saleAmount: '15000.00' })),
        limited,
        { soldOn: '2026-10-03', payment: { status: 'unknown' } }
      );
      expect(await db.StockUnit.count({ where: { state: 'in_stock' } })).toBe(before);
      const rows = await db.StockUnit.findAll({ where: { id: result.ledgerUnitIds } });
      expect(rows.every(row => row.state === 'sold' && row.costSource === 'fixed_catalog')).toBe(
        true
      );
    } catch (error) {
      logger.debug('合成测试', { code: error.code });
      throw error;
    }
  });
});
