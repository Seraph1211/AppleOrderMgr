const { Sequelize, QueryTypes } = require('sequelize');
const migration = require('../migrations/20261002000001-create-inventory-validation');
const InventoryValidationGate = require('../src/services/inventoryValidationGate');

const suite = process.env.INVENTORY_DATABASE_TEST === '1' ? describe : describe.skip;
suite('库存验证专用数据库（只连接 test_inventory_validation）', () => {
  let db;
  let gate;
  beforeAll(async () => {
    try {
      if (process.env.DB_HOST !== 'postgres' || process.env.DB_NAME !== 'apple_inventory_dev')
        throw new Error('ISOLATED_COMPOSE_REQUIRED');
      db = new Sequelize(
        'test_inventory_validation',
        process.env.DB_USER,
        process.env.DB_PASSWORD,
        {
          host: 'postgres',
          dialect: 'postgres',
          logging: false,
        }
      );
      await migration.up(db.getQueryInterface(), Sequelize);
      gate = new InventoryValidationGate(db);
    } catch (error) {
      throw new Error('验证库初始化失败', { cause: error });
    }
  });
  afterAll(async () => {
    try {
      if (db) {
        await migration.down(db.getQueryInterface());
        const tables = await db.getQueryInterface().showAllTables();
        expect(tables).not.toContain('inventory_validation_state');
        expect(tables).not.toContain('inventory_validation_attempts');
      }
    } catch (error) {
      throw new Error('验证库回滚失败', { cause: error });
    } finally {
      if (db) await db.close();
    }
  });
  test('并发进程只获得一份许可；失败记账及暂停重启保留；重复结果不改变状态', async () => {
    try {
      const permits = await Promise.all(
        Array.from({ length: 8 }, () =>
          new InventoryValidationGate(db).reserve('connect', 'test-main', {})
        )
      );
      const ids = permits.filter(p => p.id);
      expect(ids).toHaveLength(1);
      const result = {
        id: ids[0].id,
        outcome: 'PROXY_CONNECT_REJECTED',
        egress: 'test-main',
        status: 416,
        durationMs: 1,
      };
      await gate.finish(result);
      const restarted = new InventoryValidationGate(db);
      expect((await restarted.reserve('connect', 'test-main', {})).blocked).toBe(
        'PROXY_CONNECT_REJECTED'
      );
      const before = await db.query('SELECT body FROM inventory_validation_state', {
        type: QueryTypes.SELECT,
      });
      await restarted.finish({ ...result, outcome: 'TARGET_CHALLENGE' });
      const after = await db.query('SELECT body FROM inventory_validation_state', {
        type: QueryTypes.SELECT,
      });
      expect(after).toEqual(before);
      expect(after[0].body.dayCount).toBe(1);
      const attempts = await db.query('SELECT outcome FROM inventory_validation_attempts', {
        type: QueryTypes.SELECT,
      });
      expect(attempts).toEqual([{ outcome: 'PROXY_CONNECT_REJECTED' }]);
    } catch (error) {
      throw new Error('库存验证事务断言失败', { cause: error });
    }
  });
});
