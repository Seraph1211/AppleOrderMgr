const { EventEmitter } = require('events');
const { Sequelize } = require('sequelize');
const validationMigration = require('../migrations/20261002000001-create-inventory-validation');
const monitorMigration = require('../migrations/20261002000002-create-inventory-monitor');
const InventoryService = require('../src/services/inventoryService');
const InventoryCollector = require('../src/services/inventoryCollector');
const Gate = require('../src/services/inventoryValidationGate');
const { requestOnce } = require('../src/services/inventoryValidationClient');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const inventoryFailure = require('../src/utils/inventoryFailure');
const suite = process.env.INVENTORY_DATABASE_TEST === '1' ? describe : describe.skip;

suite('库存307独立真实 PostgreSQL 验收', () => {
  let db;
  let models;
  let service;
  let collector;
  let gate;
  const names = [
    'InventoryProduct',
    'InventoryStore',
    'InventorySetting',
    'InventoryRuntime',
    'InventoryRound',
    'InventorySnapshot',
    'InventorySample',
    'InventoryEvent',
    'InventoryHourly',
    'InventoryDelivery',
  ];
  const product = {
    id: 'MJTC4CH/A',
    sku: 'MJTC4CH/A',
    title: 'iPhone 18 Pro 512GB Black',
    model: 'iPhone 18 Pro',
    capacity: '512GB',
    color: '黑色',
    enabled: true,
    supported: true,
  };
  const stores = [
    { id: 'R320', storeCode: 'R320', storeName: '三里屯', city: '北京', enabled: true },
    { id: 'R321', storeCode: 'R321', storeName: '合成店', city: '上海', enabled: true },
  ];
  beforeAll(async () => {
    try {
      if (process.env.DB_HOST !== 'postgres' || process.env.DB_NAME !== 'apple_inventory_dev')
        throw new Error('ISOLATED_COMPOSE_REQUIRED');
      db = new Sequelize(
        'test_inventory_validation',
        process.env.DB_USER,
        process.env.DB_PASSWORD,
        { host: 'postgres', dialect: 'postgres', logging: false }
      );
      await validationMigration.up(db.getQueryInterface(), Sequelize);
      await monitorMigration.up(db.getQueryInterface(), Sequelize);
      models = { sequelize: db };
      for (const name of names) models[name] = require(`../src/models/${name}`)(db);
      service = new InventoryService(models);
      collector = new InventoryCollector(service);
      gate = new Gate(db, { production: true });
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  beforeEach(async () => {
    try {
      for (const name of names) await models[name].destroy({ truncate: true });
      await db.query('TRUNCATE inventory_validation_attempts');
      await db.query('UPDATE inventory_validation_state SET body = :body::jsonb', {
        replacements: {
          body: JSON.stringify({
            tunnel: {
              label: 'iproyal-main',
              token: 'synthetic-candidate',
              verified: true,
              expiresAt: Date.now() + 600000,
              exitHash: 'a'.repeat(64),
              rejectedHashes: [],
            },
          }),
        },
      });
      await models.InventoryRuntime.create({ id: 'main', body: { seeded: true } });
      await models.InventorySetting.create({
        id: 'main',
        body: {
          version: 1,
          config: { ...DEFAULT_CONFIG, enabled: true },
        },
      });
      await models.InventoryProduct.create({ id: product.id, body: product });
      await models.InventoryStore.bulkCreate(stores.map(store => ({ id: store.id, body: store })));
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  afterAll(async () => {
    try {
      if (db) {
        await monitorMigration.down(db.getQueryInterface());
        await validationMigration.down(db.getQueryInterface());
      }
    } catch (error) {
      throw inventoryFailure(error);
    } finally {
      await db?.close();
    }
  });
  async function collect307(location, tunnelStatus = 200) {
    try {
      const agent = new EventEmitter();
      agent.destroy = jest.fn();
      const request = jest.fn(() => {
        agent.emit('proxyConnect', { statusCode: tunnelStatus });
        return Promise.resolve({ status: 307, headers: { location }, data: 'synthetic-307-body' });
      });
      const result = await requestOnce({
        purpose: 'inventory',
        context: { skus: [product.sku], location: '100000' },
        proxy: {
          label: 'iproyal-main',
          url: 'http://synthetic:synthetic-secret@geo.iproyal.com:12321',
        },
        gate,
        request,
        createAgent: () => Promise.resolve(agent),
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(agent.destroy).toHaveBeenCalledTimes(1);
      return result;
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  async function guard() {
    try {
      return (await db.query('SELECT body FROM inventory_validation_state'))[0][0].body;
    } catch (error) {
      throw inventoryFailure(error);
    }
  }

  test('307真实次数字节入账、释放租约、重复finish幂等，不伪装有效响应', async () => {
    try {
      const result = await collect307(undefined);
      expect(result).toMatchObject({ status: 307, outcome: 'TARGET_REJECTED' });
      expect(result.evidence).toBeUndefined();
      const before = await guard();
      expect(before).toMatchObject({
        hourCount: 1,
        dayCount: 1,
        byteCount: Buffer.byteLength('synthetic-307-body'),
        recovering: true,
        recoverySuccesses: 0,
      });
      expect(before.pausedReason).toBeUndefined();
      expect(Object.keys(before.requestLeases)).toHaveLength(0);
      expect(before.tunnel.rejectedHashes).toContain('a'.repeat(64));
      await gate.finish(result);
      expect(await guard()).toEqual(before);
      const [attempts] = await db.query(
        'SELECT outcome,http_status AS "status",summary,context FROM inventory_validation_attempts'
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        outcome: 'TARGET_REJECTED',
        status: 307,
        summary: { targetRejectReason: 'UNFOLLOWED_REDIRECT' },
      });
      expect(JSON.stringify(attempts)).not.toMatch(/synthetic-secret|synthetic-307-body/);
      expect(await models.InventorySample.count()).toBe(0);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('目标307不覆盖同轮已有效组合，也不产生到货或恢复事件', async () => {
    try {
      const claims = await Promise.all([collector.claim(), collector.claim()]);
      await collector.settle(claims[0], {
        id: 'valid-synthetic',
        outcome: 'INVENTORY_VALID',
        evidence: [
          {
            sku: product.sku,
            storeCode: stores[0].storeCode,
            storeName: stores[0].storeName,
            title: product.title,
            status: 'in_stock',
            quote: '合成有货',
          },
        ],
      });
      const snapshot = (await models.InventorySnapshot.findByPk(`${product.sku}|R320`)).body;
      const result = await collect307(undefined);
      await collector.settle(claims[1], result);
      expect((await models.InventorySnapshot.findByPk(`${product.sku}|R320`)).body).toEqual(
        snapshot
      );
      expect((await models.InventorySnapshot.findByPk(`${product.sku}|R321`)).body.error).toBe(
        'TARGET_REJECTED'
      );
      expect(await models.InventorySample.count()).toBe(1);
      expect(
        (await service.rows('InventoryEvent')).filter(row =>
          ['arrival', 'recovery'].includes(row.kind)
        )
      ).toHaveLength(0);
      expect(
        (await service.rows('InventoryDelivery')).filter(row =>
          ['arrival', 'recovery'].includes(row.kind)
        )
      ).toHaveLength(0);
      const round = (await models.InventoryRound.findByPk(claims[0].roundId)).body;
      expect(round.expected).toBe(2);
      expect(round.completed).toBe(1);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('危险Location仍持久化manual阻断，原文与凭据不存证', async () => {
    try {
      const location =
        'https://synthetic-user:synthetic-secret@evil.test/captcha?token=private-value';
      const result = await collect307(location);
      expect(result.outcome).toBe('REDIRECT_BLOCKED');
      expect((await guard()).pausedReason).toBe('REDIRECT_BLOCKED');
      const [attempts] = await db.query(
        'SELECT summary,context FROM inventory_validation_attempts'
      );
      expect(attempts).toHaveLength(1);
      expect(JSON.stringify(attempts)).not.toMatch(
        /evil\.test|private-value|synthetic-user|synthetic-secret/
      );
      expect(attempts[0].summary.redirectLocationHash).toMatch(/^[a-f0-9]{64}$/);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
});
