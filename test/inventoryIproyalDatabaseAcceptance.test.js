const { Sequelize } = require('sequelize');
const validationMigration = require('../migrations/20261002000001-create-inventory-validation');
const monitorMigration = require('../migrations/20261002000002-create-inventory-monitor');
const timeIndexes = require('../migrations/20261002000003-add-inventory-time-indexes');
const InventoryService = require('../src/services/inventoryService');
const InventoryCollector = require('../src/services/inventoryCollector');
const InventoryNotifier = require('../src/services/inventoryNotifier');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const { encrypt } = require('../src/utils/fieldEncryption');
const inventoryFailure = require('../src/utils/inventoryFailure');
const suite = process.env.INVENTORY_DATABASE_TEST === '1' ? describe : describe.skip;

suite('IPRoyal 独立验收：真实 PostgreSQL 等待、快照与通知', () => {
  let db;
  let models;
  let service;
  let collector;
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
      await timeIndexes.up(db.getQueryInterface());
      models = { sequelize: db };
      for (const name of names) models[name] = require(`../src/models/${name}`)(db);
      service = new InventoryService(models);
      collector = new InventoryCollector(service);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  beforeEach(async () => {
    try {
      for (const name of names) await models[name].destroy({ where: {}, truncate: true });
      await db.query("UPDATE inventory_validation_state SET body = '{}'::jsonb");
      await models.InventoryRuntime.create({
        id: 'main',
        body: { seeded: true, workerHeartbeat: Date.now() },
      });
      await models.InventorySetting.create({
        id: 'main',
        body: {
          version: 1,
          destinationId: 'synthetic-destination',
          webhookCipher: encrypt('synthetic-webhook'),
          notificationSince: Date.now() - 1000,
          config: { ...DEFAULT_CONFIG, enabled: true, notificationsEnabled: true },
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
        await timeIndexes.down(db.getQueryInterface());
        await monitorMigration.down(db.getQueryInterface());
        await validationMigration.down(db.getQueryInterface());
      }
    } catch (error) {
      throw inventoryFailure(error);
    } finally {
      await db?.close();
    }
  });

  function valid(rows = stores) {
    return {
      id: 'synthetic-valid',
      outcome: 'INVENTORY_VALID',
      evidence: rows.map(store => ({
        sku: product.sku,
        storeCode: store.storeCode,
        storeName: store.storeName,
        title: product.title,
        status: 'in_stock',
        quote: '合成有货',
      })),
    };
  }
  async function seedSnapshot(store = stores[0], extra = {}) {
    try {
      await models.InventorySnapshot.create({
        id: `${product.sku}|${store.storeCode}`,
        body: {
          ...product,
          ...store,
          observedAt: Date.now() - 1000,
          expiresAt: Date.now() + 600000,
          status: 'in_stock',
          error: null,
          interrupted: false,
          ...extra,
          id: `${product.sku}|${store.storeCode}`,
        },
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  async function runtime(extra) {
    try {
      const row = await models.InventoryRuntime.findByPk('main');
      await row.update({ body: { ...row.body, ...extra } });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }

  test.each([
    'TARGET_COOLDOWN',
    'PROXY_PROVIDER_COOLDOWN',
    'ALTERNATE_EGRESS_REQUIRED',
    'RECOVERY_PROBE_REQUIRED',
    'REQUEST_IN_FLIGHT',
  ])('%s 仅等待，不污染新鲜快照或预算口径', async outcome => {
    try {
      await seedSnapshot();
      const previous = (await models.InventorySnapshot.findByPk(`${product.sku}|R320`)).body;
      const claim = await collector.claim();
      const result = await collector.settle(claim, { outcome, until: Date.now() + 20000 });
      expect(result.deferred).toBe(true);
      const round = (await models.InventoryRound.findByPk(claim.roundId)).body;
      expect(round.tasks[claim.taskIndex]).toMatchObject({ status: 'pending', attempts: 0 });
      expect(round.retries).toBe(0);
      expect((await models.InventorySnapshot.findByPk(`${product.sku}|R320`)).body).toEqual(
        previous
      );
      expect(await models.InventorySample.count()).toBe(0);
      expect(
        (await service.latest()).items.find(row => row.storeCode === 'R320').displayStatus
      ).toBe('in_stock');
      if (outcome === 'REQUEST_IN_FLIGHT') {
        const state = (await models.InventoryRuntime.findByPk('main')).body;
        expect(state.lastError).toBeFalsy();
        expect(state.stoppedAt).toBeFalsy();
        expect((await service.health()).state).toBe('normal');
      }
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('截止停止未发任务，固定分母和未发出／真实失败分项一致', async () => {
    try {
      const claim = await collector.claim();
      await collector.settle(claim, {
        outcome: 'ALTERNATE_EGRESS_REQUIRED',
        until: Date.now() + 600000,
      });
      const row = await models.InventoryRound.findByPk(claim.roundId);
      await row.update({ body: { ...row.body, plannedAt: Date.now() - 301000 } });
      expect(await collector.claim()).toBeNull();
      const round = (await models.InventoryRound.findByPk(claim.roundId)).body;
      expect(round).toMatchObject({
        status: 'partial',
        expected: 2,
        completed: 0,
        failed: 2,
        notSent: 2,
        attemptedFailed: 0,
      });
      expect(round.tasks.every(task => task.status === 'not_sent')).toBe(true);
      expect(await models.InventorySample.count()).toBe(0);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('租约过期的在途未知不能算未发送，也不能迟到覆盖新轮次', async () => {
    try {
      const claim = await collector.claim();
      const row = await models.InventoryRound.findByPk(claim.roundId);
      const expired = Date.now() - 1000;
      await row.update({
        body: {
          ...row.body,
          plannedAt: Date.now() - 301000,
          tasks: row.body.tasks.map((task, index) =>
            index === claim.taskIndex ? { ...task, leaseUntil: expired } : task
          ),
        },
      });
      await runtime({ leaseUntil: expired });
      expect(await collector.claim()).toBeNull();
      const round = (await models.InventoryRound.findByPk(claim.roundId)).body;
      expect(round).toMatchObject({
        status: 'partial',
        expected: 2,
        completed: 0,
        failed: 2,
        notSent: 0,
        attemptedFailed: 2,
      });
      expect(round.tasks[claim.taskIndex].error).toBe('INTERRUPTED_ATTEMPT_UNKNOWN');
      expect((await collector.settle(claim, valid())).ignored).toBe(true);
      expect(await models.InventorySample.count()).toBe(0);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('同轮先有货，其他请求541不硬中断成功组合，再有货无到货或恢复群消息', async () => {
    try {
      const claims = await Promise.all([collector.claim(), collector.claim()]);
      await collector.settle(claims[0], valid([stores[0]]));
      await collector.settle(claims[1], { id: 'real-541', outcome: 'TARGET_REJECTED' });
      const snapshot = (await models.InventorySnapshot.findByPk(`${product.sku}|R320`)).body;
      expect(snapshot).toMatchObject({ status: 'in_stock', error: null, hardInterrupted: false });
      const next = await collector.claim();
      await collector.settle(next, valid([stores[0]]));
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
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test.each([
    { status: 'unknown', interrupted: true, error: 'INVALID_RESPONSE' },
    { expiresAt: Date.now() - 1000 },
  ])('中断或过期后观察到有货保留 recovery 事件，但不排群消息 %#', async extra => {
    try {
      await seedSnapshot(stores[0], extra);
      const claim = await collector.claim();
      await collector.settle(claim, valid([stores[0]]));
      expect(
        (await service.rows('InventoryEvent')).filter(row => row.kind === 'recovery')
      ).toHaveLength(1);
      expect(
        (await service.rows('InventoryDelivery')).filter(row => row.kind === 'recovery')
      ).toHaveLength(0);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('旧 pending recovery 不能补发，即使快照仍新鲜有货', async () => {
    try {
      await seedSnapshot();
      const now = Date.now();
      await models.InventoryDelivery.create({
        id: 'old-recovery',
        body: {
          kind: 'recovery',
          status: 'pending',
          destinationId: 'synthetic-destination',
          notBefore: now - 1000,
          expiresAt: now + 120000,
          attempts: 0,
          rows: [{ ...product, ...stores[0], observedAt: now }],
        },
      });
      const transport = jest.fn();
      const notifier = new InventoryNotifier(service, transport);
      expect(await notifier.claim()).toBeNull();
      expect((await models.InventoryDelivery.findByPk('old-recovery')).body).toMatchObject({
        status: 'skipped',
        errorCode: 'RECOVERY_NOTIFICATION_RETIRED',
      });
      expect(transport).not.toHaveBeenCalled();
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('健康摘要显示实际1/2覆盖和1个有货，不声称全国完整稳定', async () => {
    try {
      await seedSnapshot();
      await models.InventoryProduct.create({
        id: 'UNSUPPORTEDCH/A',
        body: {
          ...product,
          id: 'UNSUPPORTEDCH/A',
          sku: 'UNSUPPORTEDCH/A',
          enabled: true,
          supported: false,
        },
      });
      const now = Date.now();
      await runtime({
        lastSuccessAt: now,
        healthAlerts: {
          version: 1,
          destinationId: 'synthetic-destination',
          observedKey: 'normal',
          since: now - 121000,
          announcedKey: 'degraded',
          lastAttempts: {},
        },
      });
      const claim = await new InventoryNotifier(service, jest.fn()).claim();
      expect(claim.content).toContain('当前有效覆盖：1 / 2 个组合');
      expect(claim.content).toContain('有货：1 个组合');
      expect(claim.content).toContain('查询通道恢复');
      expect(claim.content).not.toContain('已稳定恢复');
      expect((await service.health()).coverage).toEqual({ fresh: 1, expected: 2, inStock: 1 });
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('真实健康读取区分唯一出口人工停用、离线与陈旧且无凭据', async () => {
    try {
      await db.query('UPDATE inventory_validation_state SET body = :body::jsonb', {
        replacements: {
          body: JSON.stringify({ pausedEgress: { 'iproyal-main': 'PROXY_AUTH_FAILED' } }),
        },
      });
      expect((await service.health()).state).toBe('manual_required');
      await runtime({ workerHeartbeat: Date.now() - 121000 });
      expect((await service.health()).state).toBe('offline');
      await runtime({ workerHeartbeat: Date.now() });
      await db.query("UPDATE inventory_validation_state SET body = '{}'::jsonb");
      const health = await service.health();
      expect(health.state).toBe('data_stale');
      expect(health.coverage).toEqual({ fresh: 0, expected: 2, inStock: 0 });
      expect(JSON.stringify(health)).not.toMatch(/synthetic-webhook|cipher|password/);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('小时预算耗尽显示自动等待和重置时间，不要求人工解除预算', async () => {
    try {
      const now = Date.now();
      await runtime({ lastError: 'REQUEST_BUDGET_EXHAUSTED' });
      await db.query('UPDATE inventory_validation_state SET body = :body::jsonb', {
        replacements: {
          body: JSON.stringify({
            hour: Math.floor(now / 3600000),
            hourCount: DEFAULT_CONFIG.hourlyRequests,
          }),
        },
      });
      const health = await service.health();
      expect(health.state).toBe('automatic_wait');
      expect(health.actionRequired).toBe(false);
      expect(health.waitUntil).toBe((Math.floor(now / 3600000) + 1) * 3600000);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('人工恢复重置供应商尝试数，同时保留冷却、预算与 Apple 风险历史', async () => {
    try {
      const now = Date.now();
      const state = {
        providerFailures: 3,
        providerCooldownUntil: now + 60000,
        pausedEgress: { 'iproyal-main': 'PROXY_RECOVERY_EXHAUSTED' },
        hourCount: 101,
        dayCount: 305,
        byteCount: 9087,
        recent: [{ at: now - 10000, risk: true, egress: 'iproyal-main' }],
        cooldownUntil: now + 120000,
      };
      await db.query('UPDATE inventory_validation_state SET body = :body::jsonb', {
        replacements: { body: JSON.stringify(state) },
      });
      const Maintenance = require('../src/services/inventoryMaintenance');
      const Gate = require('../src/services/inventoryValidationGate');
      await new Maintenance(service, null, new Gate(db, { production: true })).resume(1);
      const [rows] = await db.query('SELECT body FROM inventory_validation_state');
      expect(rows[0].body).toMatchObject({
        providerFailures: 0,
        providerCooldownUntil: state.providerCooldownUntil,
        hourCount: 101,
        dayCount: 305,
        byteCount: 9087,
        recent: state.recent,
        cooldownUntil: state.cooldownUntil,
        recovering: true,
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
});
