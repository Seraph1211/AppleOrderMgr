const enabled = process.env.RUN_DUO_ACCEPTANCE_DB === 'true';
if (
  enabled &&
  (process.env.DB_NAME !== 'apple_order_mgr_duo_acceptance_1015' ||
    process.env.DB_HOST !== 'postgres' ||
    process.env.DATABASE_URL)
)
  throw new Error('仅限Duo独立验收库');

(enabled ? describe : describe.skip)('Duo 独立监控过滤与轮次验收', () => {
  const db = require('../src/models');
  const InventoryService = require('../src/services/inventoryService');
  const InventoryCollector = require('../src/services/inventoryCollector');
  const policy = require('../src/services/inventoryPolicy');
  const service = new InventoryService(db);
  afterAll(async () => {
    try {
      await db.sequelize.close();
    } catch (error) {
      throw new Error('Duo监控验收数据库关闭失败', { cause: error });
    }
  });

  test('应该正确标准化英文颜色并保留精确Duo身份过滤', () => {
    for (const [english, chinese] of [
      ['Star White', '星光白色'],
      ['Night Sky', '夜空色'],
    ]) {
      const item = policy.productDetails({
        sku: 'MK2M4CH/A',
        title: `iPhone Duo 256GB ${english}`,
      });
      expect(item).toMatchObject({ model: 'iPhone Duo', color: chinese, capacity: '256GB' });
      expect(
        policy.matches(item, policy.parseFilters({ models: 'iPhone Duo', colors: chinese }))
      ).toBe(true);
      expect(policy.matches(item, policy.parseFilters({ models: 'iPhone 18 Pro Max' }))).toBe(
        false
      );
    }
  });

  test('应该对Duo返回未知或待启用而不凭目录声明有货', async () => {
    await db.InventoryStore.upsert({
      id: 'R001',
      body: {
        storeCode: 'R001',
        storeName: '独立合成店',
        city: '合成城市',
        location: '100000',
        enabled: true,
      },
    });
    const result = await service.latest({ models: 'iPhone Duo', pageSize: 100 });
    expect(result.total).toBe(8);
    expect(result.items.every(item => item.model === 'iPhone Duo')).toBe(true);
    expect(
      result.items.every(item => item.lastStatus === null && item.displayStatus !== 'in_stock')
    ).toBe(true);
    expect(result.summary.inStock).toBe(0);
    const outside = await service.latest({ models: 'iPhone 17', pageSize: 100 });
    expect(outside.total).toBe(0);
  });

  test('应该将Duo筛选手动轮次限定8项而不混入其他机型', async () => {
    const catalog = await service.catalog();
    const ids = catalog.products.filter(item => item.model === 'iPhone Duo').map(item => item.id);
    expect(ids).toHaveLength(8);
    await service.setCatalog({ kind: 'products', ids, enabled: true }, 1);
    const result = await service.refresh({ models: 'iPhone Duo', stores: 'R001' }, 1);
    const round = await db.InventoryRound.findByPk(result.id);
    expect(round.body.products).toHaveLength(8);
    expect(round.body.products.every(product => product.model === 'iPhone Duo')).toBe(true);
    expect(round.body.expected).toBe(8);
    expect(round.body.tasks.flatMap(task => task.skus).sort()).toEqual(
      ids.flatMap(id => Array(6).fill(id)).sort()
    );
    expect(await db.InventoryProduct.count()).toBe(73);
  });

  test('应该在自动领取范围保留旧机型并纳入Duo且不触发任何网络', async () => {
    // 只构造与领取持久化任务，不运行driver、通知或任何官网请求。
    const runtime = await db.InventoryRuntime.findByPk('main');
    await runtime.update({
      body: { ...runtime.body, nextRoundAt: Date.now() - 1000, activeRound: null },
    });
    const collector = new InventoryCollector(service);
    const claimed = await collector.claim();
    expect(claimed).toBeTruthy();
    const rounds = await db.InventoryRound.findAll();
    const automatic = rounds.find(round => round.body.source === 'auto');
    expect(automatic).toBeTruthy();
    expect(automatic.body.products.some(product => product.model === 'iPhone Duo')).toBe(true);
    expect(
      automatic.body.products.some(
        product => product.model === 'iPhone 18 Pro' || product.model === 'iPhone 18 Pro Max'
      )
    ).toBe(true);
    expect(
      automatic.body.products.every(product => policy.MONITORED_MODELS.includes(product.model))
    ).toBe(true);
    expect((await db.InventorySetting.findByPk('main')).body.config.notificationsEnabled).toBe(
      true
    );
  });
});
