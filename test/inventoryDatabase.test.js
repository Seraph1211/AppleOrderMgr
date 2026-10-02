const { Sequelize } = require('sequelize');
const validationMigration = require('../migrations/20261002000001-create-inventory-validation');
const migration = require('../migrations/20261002000002-create-inventory-monitor');
const timeIndexes = require('../migrations/20261002000003-add-inventory-time-indexes');
const InventoryService = require('../src/services/inventoryService');
const InventoryCollector = require('../src/services/inventoryCollector');
const InventoryNotifier = require('../src/services/inventoryNotifier');
const InventoryAnalysis = require('../src/services/inventoryAnalysis');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const inventoryFailure = require('../src/utils/inventoryFailure');
const suite = process.env.INVENTORY_DATABASE_TEST === '1' ? describe : describe.skip;
suite('完整库存模块真实 PostgreSQL 事务（仅隔离测试库）', () => {
  let db;
  let m;
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
  const store = {
    id: 'R320',
    storeCode: 'R320',
    storeName: '三里屯',
    city: '北京',
    location: '100027',
    enabled: true,
  };
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
      await migration.up(db.getQueryInterface(), Sequelize);
      await timeIndexes.up(db.getQueryInterface());
      m = { sequelize: db };
      for (const name of names) m[name] = require(`../src/models/${name}`)(db);
      service = new InventoryService(m);
      collector = new InventoryCollector(service);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  beforeEach(async () => {
    try {
      for (const name of names) await m[name].destroy({ where: {}, truncate: true });
      await db.query("UPDATE inventory_validation_state SET body = '{}'::jsonb");
      await m.InventoryRuntime.create({ id: 'main', body: { seeded: true } });
      await m.InventorySetting.create({
        id: 'main',
        body: { version: 1, config: { ...DEFAULT_CONFIG, enabled: true } },
      });
      await m.InventoryProduct.create({ id: product.id, body: product });
      await m.InventoryStore.create({ id: store.id, body: store });
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  afterAll(async () => {
    try {
      if (db) {
        await timeIndexes.down(db.getQueryInterface());
        await migration.down(db.getQueryInterface());
        await validationMigration.down(db.getQueryInterface());
        expect(await db.getQueryInterface().showAllTables()).not.toContain('inventory_events');
      }
    } catch (error) {
      throw inventoryFailure(error);
    } finally {
      await db?.close();
    }
  });
  test('范围外旧商品不出现在目录和全国库存，不能通过批量接口重新启用', async () => {
    try {
      const outside = {
        ...product,
        id: 'MG724CH/A',
        sku: 'MG724CH/A',
        model: 'iPhone 17',
        title: 'iPhone 17 512GB Black',
      };
      await m.InventoryProduct.create({ id: outside.id, body: outside });
      const catalog = await service.catalog();
      expect(catalog.products.map(row => row.model)).toEqual(['iPhone 18 Pro']);
      expect((await service.latest()).items.map(row => row.model)).toEqual(['iPhone 18 Pro']);
      expect((await service.latest({ models: 'iPhone 17' })).total).toBe(0);
      await expect(
        service.setCatalog({ kind: 'products', ids: [product.id, outside.id], enabled: false }, 1)
      ).rejects.toThrow('目录项不存在');
      expect((await m.InventoryProduct.findByPk(product.id)).body.enabled).toBe(true);
      await expect(service.refresh({ models: 'iPhone 17' }, 1)).rejects.toThrow();
      const claim = await collector.claim();
      expect(claim.task.skus).toEqual([product.sku]);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('首次目录只装入 Pro 与 Pro Max 共 32 个 SKU', async () => {
    try {
      await m.InventoryProduct.destroy({ truncate: true });
      await m.InventoryStore.destroy({ truncate: true });
      await m.InventoryRuntime.update({ body: {} }, { where: { id: 'main' } });
      const catalog = await service.catalog();
      expect(catalog.products).toHaveLength(32);
      expect(catalog.products.filter(row => row.model === 'iPhone 18 Pro')).toHaveLength(16);
      expect(catalog.products.filter(row => row.model === 'iPhone 18 Pro Max')).toHaveLength(16);
      expect(catalog.products.every(row => !row.enabled)).toBe(true);
      expect(await m.InventoryProduct.count()).toBe(32);
      expect(catalog.stores).toHaveLength(49);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  async function round(status, manual = false) {
    try {
      if (manual) await service.refresh({}, 1);
      for (let i = 0; i < 6; i += 1) {
        const claim = await collector.claim();
        expect(claim).toBeTruthy();
        await collector.settle(claim, {
          id: `test-${i}`,
          outcome: 'INVENTORY_VALID',
          evidence: [
            {
              sku: product.sku,
              storeCode: store.storeCode,
              storeName: store.storeName,
              title: 'iPhone 18 Pro 512GB 黑色',
              status,
              quote: '测试提示',
            },
          ],
        });
      }
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  test('轮次失败保留代理根因和上次有效状态，不伪造新的库存', async () => {
    try {
      await round('in_stock');
      await service.refresh({}, 1);
      for (let i = 0; i < 6; i += 1) {
        const claim = await collector.claim();
        if (!claim) break;
        await collector.settle(claim, { outcome: 'NO_HEALTHY_PROXY' });
      }
      const [snapshot] = await service.rows('InventorySnapshot');
      expect(snapshot).toMatchObject({ status: 'in_stock', error: 'NO_HEALTHY_PROXY' });
      expect((await service.health()).reason).toBe('NO_HEALTHY_PROXY');
      expect(await m.InventorySample.count()).toBe(1);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('同轮六区域去重、跨轮到货唯一、快照与小时统计一致', async () => {
    try {
      await round('out_of_stock');
      await round('in_stock', true);
      expect(await m.InventorySample.count()).toBe(2);
      expect(await m.InventoryEvent.count()).toBe(1);
      expect((await service.rows('InventoryEvent'))[0].kind).toBe('arrival');
      const latest = await service.latest({});
      expect(latest.summary.inStock).toBe(1);
      const hourly = await service.rows('InventoryHourly');
      expect(hourly.reduce((sum, r) => sum + r.arrivals, 0)).toBe(1);
      await round('in_stock', true);
      expect(await m.InventoryEvent.count()).toBe(1);
      expect((await service.list('InventoryRound')).items.every(r => r.completed === 1)).toBe(true);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('多 Worker 不重叠，旧租约结果不可写入', async () => {
    try {
      const other = new InventoryCollector(service);
      const results = await Promise.all([collector.claim(), other.claim()]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const active = results[0] ? collector : other;
      const claim = results.find(Boolean);
      await m.InventoryRuntime.update(
        { body: { ...(await m.InventoryRuntime.findByPk('main')).body, leaseOwner: 'another' } },
        { where: { id: 'main' } }
      );
      expect(
        await active.settle(claim, { id: 'x', outcome: 'INVENTORY_VALID', evidence: [] })
      ).toEqual({ ignored: true });
      expect(await m.InventorySample.count()).toBe(0);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('手动请求合并，不因页面筛选关闭全局目录', async () => {
    try {
      const first = await service.refresh({ cities: '北京' }, 1);
      const second = await service.refresh({ cities: '北京' }, 1);
      expect(second).toEqual({ id: first.id, coalesced: true });
      expect(await m.InventoryProduct.count()).toBe(1);
      await expect(service.refresh({ cities: '上海' }, 1)).rejects.toMatchObject({
        statusCode: 400,
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('缺失覆盖保留失败及错误，不写成无货', async () => {
    try {
      for (let i = 0; i < 6; i += 1) {
        const claim = await collector.claim();
        await collector.settle(claim, { id: String(i), outcome: 'INVENTORY_VALID', evidence: [] });
      }
      const latest = await service.latest({});
      expect(latest.items[0].displayStatus).toBe('error');
      expect(latest.items[0].lastStatus).toBeNull();
      expect(latest.items[0].observedAt).toBeNull();
      expect((await service.list('InventoryRound')).items[0]).toMatchObject({
        status: 'partial',
        expected: 1,
        completed: 0,
        failed: 1,
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('失败重试受全轮 20% 限制，重启不重放在途未知尝试', async () => {
    try {
      let claim = await collector.claim();
      await collector.settle(claim, { id: 'failed', outcome: 'REQUEST_TIMEOUT' });
      claim = await collector.claim();
      const runtime = await m.InventoryRuntime.findByPk('main');
      await runtime.update({ body: { ...runtime.body, leaseUntil: 0 } });
      const restarted = new InventoryCollector(service);
      await restarted.claim();
      const active = (await service.rows('InventoryRound'))[0];
      expect(active.retries).toBe(1);
      expect(active.tasks.some(t => t.error === 'INTERRUPTED_ATTEMPT_UNKNOWN')).toBe(true);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('停机错过轮次保留分母，不批量追赶请求', async () => {
    try {
      await m.InventoryRuntime.update(
        { body: { seeded: true, nextRoundAt: Date.now() - 3600000 } },
        { where: { id: 'main' } }
      );
      await collector.claim();
      const rounds = await service.rows('InventoryRound');
      expect(rounds).toHaveLength(2);
      expect(rounds.find(r => r.status === 'missed').plannedCount).toBeGreaterThanOrEqual(12);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('Webhook 加密不回显、测试 accepted 后才能启用且版本冲突受控', async () => {
    try {
      const notifier = new InventoryNotifier(service, async () => ({
        status: await Promise.resolve('accepted'),
      }));
      const settings = await service.saveSettings(
        {
          version: 1,
          config: DEFAULT_CONFIG,
          webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test_inventory_123',
        },
        1
      );
      expect(settings.hasWebhook).toBe(true);
      expect(JSON.stringify(settings)).not.toContain('test_inventory_123');
      expect((await m.InventorySetting.findByPk('main')).body.webhookCipher).toMatch(/^enc:/);
      await expect(
        service.saveSettings({ version: 1, config: DEFAULT_CONFIG }, 1)
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        service.saveSettings(
          { version: 2, config: { ...DEFAULT_CONFIG, notificationsEnabled: true } },
          1
        )
      ).rejects.toMatchObject({ statusCode: 400 });
      await notifier.test(1);
      await notifier.tick();
      expect((await service.getSettings()).webhookTested).toBe(true);
      await service.saveSettings(
        { version: 2, config: { ...DEFAULT_CONFIG, notificationsEnabled: true } },
        1
      );
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('未知投递不会重发，换群跳过旧任务', async () => {
    try {
      const send = jest
        .fn()
        .mockResolvedValue({ status: 'unknown', errorCode: 'TRANSPORT_UNKNOWN' });
      const notifier = new InventoryNotifier(service, send);
      await service.saveSettings(
        {
          version: 1,
          config: DEFAULT_CONFIG,
          webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test_inventory_123',
        },
        1
      );
      await notifier.test(1);
      await notifier.tick();
      await notifier.tick();
      expect(send).toHaveBeenCalledTimes(1);
      await notifier.test(1);
      await service.saveSettings(
        {
          version: 2,
          config: DEFAULT_CONFIG,
          webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test_inventory_456',
        },
        1
      );
      await notifier.tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        (await service.rows('InventoryDelivery')).some(r => r.errorCode === 'DESTINATION_CHANGED')
      ).toBe(true);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('统计筛选与历史一致，缺口不伪造零；旧明细不能假下钻', async () => {
    try {
      await round('out_of_stock');
      await round('in_stock', true);
      const query = {
        from: new Date(Date.now() - 3600000).toISOString(),
        to: new Date(Date.now() + 1000).toISOString(),
        metric: 'arrivals',
        cities: '北京',
      };
      const history = await service.history(query);
      const analysis = await new InventoryAnalysis(service).get(query);
      expect(history.total).toBe(1);
      expect(analysis.cities).toEqual([{ key: '北京', count: 1 }]);
      expect(analysis.heatmap.some(r => r.count === null)).toBe(true);
      await expect(
        new InventoryAnalysis(service).get({
          ...query,
          metric: 'detections',
          from: new Date(Date.now() - 10 * 86400000).toISOString(),
          bucketMinutes: 10,
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('监控范围排除未启用及不支持项目，配置开关与运行状态分离', async () => {
    try {
      await m.InventoryProduct.bulkCreate([
        { id: 'disabled', body: { ...product, sku: 'disabled', enabled: false } },
        { id: 'unsupported', body: { ...product, sku: 'unsupported', supported: false } },
      ]);
      await m.InventoryStore.create({
        id: 'disabled',
        body: { ...store, storeCode: 'disabled', enabled: false },
      });
      const runtime = await m.InventoryRuntime.findByPk('main');
      await runtime.update({
        body: {
          ...runtime.body,
          workerHeartbeat: Date.now(),
          lastSuccessAt: Date.now(),
          lastError: 'NO_HEALTHY_PROXY',
        },
      });
      expect(await service.scope()).toMatchObject({
        products: [{ sku: product.sku }],
        stores: [{ storeCode: store.storeCode }],
        combinations: 1,
        enabled: true,
        state: 'degraded',
      });
      const settings = await m.InventorySetting.findByPk('main');
      await settings.update({
        body: { ...settings.body, config: { ...settings.body.config, enabled: false } },
      });
      expect(await service.scope()).toMatchObject({
        combinations: 1,
        enabled: false,
        state: 'disabled',
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('API 管理员边界、严格输入、CSV 与历史小时筛选', async () => {
    let server;
    try {
      const express = require('express');
      const { createRouter } = require('../src/routes/inventory');
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.user = req.headers['x-test-anonymous']
          ? null
          : {
            id: 1,
            role: req.headers['x-test-role'] || 'operator',
            permissions:
                req.headers['x-test-role'] === 'admin' || req.headers['x-test-read']
                  ? ['inventory.read']
                  : [],
          };
        next();
      });
      app.use('/inventory', createRouter(service));
      app.use((error, _req, res, _next) =>
        res.status(error.statusCode || 500).json({ error: error.message })
      );
      server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      });
      const base = `http://127.0.0.1:${server.address().port}/inventory`;
      expect((await fetch(`${base}/latest`)).status).toBe(403);
      const headers = { 'x-test-role': 'admin', 'content-type': 'application/json' };
      expect(
        (await fetch(`${base}/scope`, { headers: { 'x-test-anonymous': 'true' } })).status
      ).toBe(401);
      const reader = { 'x-test-read': 'true', 'content-type': 'application/json' };
      for (const path of ['catalog', 'scope', 'latest', 'history', 'history/export', 'analysis']) {
        expect((await fetch(`${base}/${path}`, { headers: reader })).status).toBe(200);
      }
      for (const [method, path] of [
        ['GET', 'settings'],
        ['GET', 'health'],
        ['GET', 'rounds'],
        ['GET', 'rounds/anything'],
        ['GET', 'deliveries'],
        ['PUT', 'catalog'],
        ['POST', 'catalog/refresh'],
        ['PUT', 'settings'],
        ['POST', 'refresh'],
        ['POST', 'resume'],
        ['POST', 'notifications/test'],
      ]) {
        expect((await fetch(`${base}/${path}`, { method, headers: reader })).status).toBe(403);
      }
      const scope = (await (await fetch(`${base}/scope`, { headers: reader })).json()).data;
      expect(scope).toMatchObject({
        products: [{ sku: product.sku }],
        stores: [{ storeCode: store.storeCode }],
        combinations: 1,
        state: 'offline',
      });
      expect(Object.keys(scope).sort()).toEqual([
        'combinations',
        'enabled',
        'lastSuccessAt',
        'products',
        'state',
        'stores',
      ]);
      expect(Object.keys(scope.products[0]).sort()).toEqual(['capacity', 'color', 'model', 'sku']);
      expect((await fetch(`${base}/latest?page=-1`, { headers })).status).toBe(400);
      expect(
        (
          await fetch(`${base}/settings`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ version: 1, config: { enabled: 'yes' } }),
          })
        ).status
      ).toBe(400);
      await round('in_stock');
      const hour = new Date(Date.now() + 28800000).getUTCHours();
      expect((await service.history({ metric: 'first', hour })).total).toBe(1);
      expect((await service.history({ metric: 'first', hour: (hour + 1) % 24 })).total).toBe(0);
      const response = await fetch(`${base}/history/export?metric=first`, { headers });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('MJTC4CH/A');
      const latest = await fetch(`${base}/latest`, { headers });
      expect(latest.headers.get('cache-control')).toBe('no-store');
      expect((await latest.json()).data.summary.currentStores).toBe(1);
    } catch (error) {
      throw inventoryFailure(error);
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
    }
  });
  test('通知 18/min 包含测试；明确失败有限重试，过期跳过', async () => {
    try {
      const notifier = new InventoryNotifier(
        service,
        jest
          .fn()
          .mockResolvedValue({ status: 'pending', errorCode: 'CONNECT_FAILED', retryMs: 10000 })
      );
      await service.saveSettings(
        {
          version: 1,
          config: DEFAULT_CONFIG,
          webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test_inventory_123',
        },
        1
      );
      const pending = await notifier.test(1);
      await notifier.tick();
      expect((await service.rows('InventoryDelivery'))[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
      });
      const item = await m.InventoryDelivery.findByPk(pending.id);
      await item.update({ body: { ...item.body, expiresAt: Date.now() - 1 } });
      await notifier.tick();
      expect((await service.rows('InventoryDelivery'))[0].status).toBe('skipped');
      const setting = await service.getSettings();
      const runtime = await m.InventoryRuntime.findByPk('main');
      await runtime.update({
        body: {
          ...runtime.body,
          notificationRate: Array.from({ length: 18 }, () => ({
            at: Date.now(),
            destinationId: setting.destinationId,
          })),
        },
      });
      await notifier.test(1);
      expect(await notifier.claim()).toBeNull();
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('到货合并后发送前复核；无货、关闭、保护暂停不推送', async () => {
    try {
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      const notifier = new InventoryNotifier(service, send);
      const setting = await m.InventorySetting.findByPk('main');
      const { encrypt } = require('../src/utils/fieldEncryption');
      await setting.update({
        body: {
          ...setting.body,
          webhookCipher: encrypt(
            'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test_inventory_123'
          ),
          destinationId: 'dest',
          testedDestination: 'dest',
          notificationSince: Date.now() - 1000,
          config: { ...DEFAULT_CONFIG, enabled: true, notificationsEnabled: true },
        },
      });
      await round('out_of_stock');
      await round('in_stock', true);
      const pending = (await m.InventoryDelivery.findAll())[0];
      expect(pending).toBeTruthy();
      await pending.update({ body: { ...pending.body, notBefore: 0 } });
      await notifier.tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('到货提醒');
      await round('out_of_stock', true);
      await round('in_stock', true);
      const next = (await m.InventoryDelivery.findAll()).find(r => r.body.status === 'pending');
      await next.update({ body: { ...next.body, notBefore: 0 } });
      await db.query(
        'UPDATE inventory_validation_state SET body = \'{"pausedReason":"TEST_PAUSE"}\'::jsonb'
      );
      await notifier.tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        (await service.rows('InventoryDelivery')).some(
          r => r.errorCode === 'INVENTORY_NO_LONGER_CURRENT'
        )
      ).toBe(true);
      await db.query("UPDATE inventory_validation_state SET body = '{}'::jsonb");
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('保留期清理与恢复不清空预算', async () => {
    try {
      const Maintenance = require('../src/services/inventoryMaintenance');
      const Gate = require('../src/services/inventoryValidationGate');
      const maintenance = new Maintenance(service, null, new Gate(db, { production: true }));
      await m.InventorySample.create({
        id: 'old',
        body: {},
        createdAt: new Date(Date.now() - 10 * 86400000),
      });
      await m.InventoryEvent.create({
        id: 'retained',
        body: {},
        createdAt: new Date(Date.now() - 10 * 86400000),
      });
      await maintenance.retain();
      expect(await m.InventorySample.count()).toBe(0);
      expect(await m.InventoryEvent.count()).toBe(1);
      await db.query('UPDATE inventory_validation_state SET body = :body::jsonb', {
        replacements: {
          body: JSON.stringify({
            pausedReason: 'TEST',
            hourCount: 100,
            cooldownUntil: Date.now() + 600000,
          }),
        },
      });
      await maintenance.resume(1);
      const [rows] = await db.query('SELECT body FROM inventory_validation_state');
      expect(rows[0].body.hourCount).toBe(100);
      expect(rows[0].body.cooldownUntil).toBeGreaterThan(Date.now());
      expect(rows[0].body.recovering).toBe(true);
      await db.query("UPDATE inventory_validation_state SET body = '{}'::jsonb");
    } catch (error) {
      throw inventoryFailure(error);
    }
  });

  test('目录按日发现新增待启用，官网失败不删除原目录', async () => {
    try {
      const Maintenance = require('../src/services/inventoryMaintenance');
      const metrics = {
        data: {
          category: 'iphone_18_pro',
          products: [
            { category: 'iphone', partNumber: 'NEW11CH/A', name: 'iPhone 18 Pro 256GB Black' },
            { category: 'iphone', partNumber: 'OTHER17CH/A', name: 'iPhone 17 256GB Black' },
          ],
        },
      };
      const selection = {
        products: [
          { partNumber: 'NEW11CH/A', dimensionCapacity: '256gb', dimensionColor: 'black' },
          { partNumber: 'OTHER17CH/A', dimensionCapacity: '256gb', dimensionColor: 'black' },
        ],
        displayValues: { dimensionColor: { black: { value: '黑色' } } },
      };
      const productPage = `<script id="metrics">${JSON.stringify(metrics)}</script><script>productSelectionData: ${JSON.stringify(selection)}</script>`;
      const storePage = `<a data-store-number="R320">三里屯</a><script id="__NEXT_DATA__">${JSON.stringify([{ id: 'R320', name: '三里屯', address: { city: '北京', postalCode: '100027' } }])}</script>`;
      const driver = {
        request: jest
          .fn()
          .mockResolvedValueOnce({
            outcome: 'CATALOG_RECEIVED',
            evidence: '<a href="/shop/buy-iphone/iphone-18-pro">iPhone</a>',
          })
          .mockResolvedValueOnce({ outcome: 'CATALOG_RECEIVED', evidence: storePage })
          .mockResolvedValueOnce({ outcome: 'CATALOG_RECEIVED', evidence: productPage }),
      };
      const maintenance = new Maintenance(service, driver, null);
      expect(await maintenance.catalogTick()).toBe(true);
      expect(await maintenance.catalogTick()).toBe(true);
      expect(await maintenance.catalogTick()).toBe(true);
      expect((await m.InventoryProduct.findByPk('NEW11CH/A')).body.enabled).toBe(false);
      expect(await m.InventoryProduct.findByPk('OTHER17CH/A')).toBeNull();
      expect((await m.InventoryProduct.findByPk(product.id)).body.enabled).toBe(true);
      await service.refreshCatalog();
      driver.request.mockResolvedValue({ outcome: 'INVALID_RESPONSE' });
      await maintenance.catalogTick();
      expect(await m.InventoryProduct.count()).toBe(2);
      expect((await service.health()).catalogError).toBe('INVALID_RESPONSE');
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('关闭监控取消活动租约，不接收已停止轮次的迟到结果', async () => {
    try {
      const claim = await collector.claim();
      await service.saveSettings({ version: 1, config: DEFAULT_CONFIG }, 1);
      expect(
        (await collector.settle(claim, { id: 'late', outcome: 'INVENTORY_VALID', evidence: [] }))
          .ignored
      ).toBe(true);
      expect((await service.list('InventoryRound')).items[0].status).toBe('partial');
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('生产闸门读取正式设置并持久化预算；覆盖矩阵保留缺失和过期边界', async () => {
    try {
      const Gate = require('../src/services/inventoryValidationGate');
      const gate = new Gate(db, { production: true });
      const permits = await Promise.all(
        Array.from({ length: 5 }, () => gate.reserve('inventory', 'main', {}))
      );
      expect(permits.filter(p => p.id)).toHaveLength(1);
      const permit = permits.find(p => p.id);
      await gate.finish({
        id: permit.id,
        outcome: 'INVENTORY_VALID',
        egress: 'main',
        bytes: 100,
        durationMs: 1,
      });
      const [rows] = await db.query('SELECT body FROM inventory_validation_state');
      expect(rows[0].body.hourCount).toBe(1);
      expect(rows[0].body.byteCount).toBe(100);
      await round('in_stock');
      const current = (await service.rows('InventoryRound'))[0];
      const detail = await service.roundDetail(current.id);
      expect(detail.items[0]).toMatchObject({ status: 'complete', stockStatus: 'in_stock' });
      await expect(service.roundDetail('missing')).rejects.toMatchObject({ statusCode: 404 });
      await m.InventoryRound.update(
        { body: { ...current, plannedAt: Date.now() - 10 * 86400000 } },
        { where: { id: current.id } }
      );
      expect((await service.roundDetail(current.id)).detailAvailable).toBe(false);
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('旧目录 65 SKU 只采集 Pro 系列 32 SKU × 49 门店，42 请求去重为 1568 组合', async () => {
    try {
      const seed = require('../src/data/inventoryCatalog.json');
      await m.InventoryProduct.destroy({ truncate: true });
      await m.InventoryStore.destroy({ truncate: true });
      await m.InventoryProduct.bulkCreate(
        seed.products.map(p => ({ id: p.sku, body: { ...p, enabled: true, supported: true } }))
      );
      await m.InventoryStore.bulkCreate(
        seed.stores.map(s => ({ id: s.storeCode, body: { ...s, enabled: true } }))
      );
      const products = new Map(seed.products.map(p => [p.sku, p]));
      let tasks = 0;
      for (let i = 0; i < 42; i += 1) {
        const claim = await collector.claim();
        expect(claim).toBeTruthy();
        const evidence = claim.task.skus.flatMap(sku =>
          seed.stores.map(store => ({
            sku,
            storeCode: store.storeCode,
            storeName: store.storeName,
            title: products.get(sku).title,
            status: 'in_stock',
            quote: '合成全国验证',
          }))
        );
        await collector.settle(claim, {
          id: `national-${i}`,
          outcome: 'INVENTORY_VALID',
          evidence,
        });
        tasks += 1;
      }
      expect(tasks).toBe(42);
      expect(await m.InventorySample.count()).toBe(1568);
      expect(await m.InventoryEvent.count()).toBe(1568);
      const summary = (await service.list('InventoryRound')).items[0];
      expect(summary).toMatchObject({
        expected: 1568,
        completed: 1568,
        failed: 0,
        status: 'complete',
      });
      const latest = await service.latest({});
      expect(latest.summary.currentStores).toBe(49);
      expect(latest.summary.inStock).toBe(1568);
    } catch (error) {
      throw inventoryFailure(error);
    }
  }, 60000);
  test('首轮摘要等待轮次完成，再按独立有效期发送', async () => {
    try {
      const { encrypt } = require('../src/utils/fieldEncryption');
      const setting = await m.InventorySetting.findByPk('main');
      await setting.update({
        body: {
          ...setting.body,
          webhookCipher: encrypt(
            'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test_inventory_123'
          ),
          destinationId: 'dest',
          notificationSince: Date.now() - 1000,
          config: { ...DEFAULT_CONFIG, enabled: true, notificationsEnabled: true },
        },
      });
      const claim = await collector.claim();
      await collector.settle(claim, {
        id: 'first-result',
        outcome: 'INVENTORY_VALID',
        evidence: [
          {
            sku: product.sku,
            storeCode: store.storeCode,
            storeName: store.storeName,
            title: 'iPhone 18 Pro 512GB 黑色',
            status: 'in_stock',
            quote: '合成首次',
          },
        ],
      });
      const initial = (await m.InventoryDelivery.findAll())[0];
      expect(initial.body.expiresAt - Date.now()).toBeGreaterThan(300000);
      await initial.update({ body: { ...initial.body, notBefore: 0 } });
      const notifier = new InventoryNotifier(
        service,
        jest.fn().mockResolvedValue({ status: 'accepted' })
      );
      expect(await notifier.claim()).toBeNull();
      for (let i = 0; i < 5; i += 1) {
        const next = await collector.claim();
        await collector.settle(next, {
          id: String(i),
          outcome: 'INVENTORY_VALID',
          evidence: [
            {
              sku: product.sku,
              storeCode: store.storeCode,
              storeName: store.storeName,
              title: 'iPhone 18 Pro 512GB 黑色',
              status: 'in_stock',
            },
          ],
        });
      }
      await initial.reload();
      expect(initial.body.expiresAt - Date.now()).toBeLessThanOrEqual(120000);
      expect(initial.body.expiresAt).toBeGreaterThan(Date.now());
      await initial.update({ body: { ...initial.body, notBefore: 0 } });
      expect((await notifier.claim()).content).toContain('初始库存摘要');
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
  test('恢复不执行过期在途轮次，旧明细导出明确拒绝且小时范围显式对齐', async () => {
    try {
      const claim = await collector.claim();
      const row = await m.InventoryRound.findByPk(claim.roundId);
      await row.update({ body: { ...row.body, plannedAt: Date.now() - 3600000 } });
      const runtime = await m.InventoryRuntime.findByPk('main');
      await runtime.update({ body: { ...runtime.body, leaseUntil: 0 } });
      expect(await collector.claim()).toBeNull();
      expect((await service.rows('InventoryRound'))[0].status).toBe('partial');
      const query = {
        metric: 'detections',
        from: new Date(Date.now() - 20 * 86400000 + 12345).toISOString(),
        to: new Date().toISOString(),
      };
      expect((await service.history(query)).detailsPartiallyExpired).toBe(true);
      await expect(service.history(query, true)).rejects.toMatchObject({ statusCode: 400 });
      const analysis = await new InventoryAnalysis(service).get(query);
      expect(analysis.detailAvailable).toBe(false);
      expect(analysis.from % 3600000).toBe(0);
      expect(analysis.to % 3600000).toBe(0);
      expect(analysis.notice).toContain('实际范围');
    } catch (error) {
      throw inventoryFailure(error);
    }
  });
});
