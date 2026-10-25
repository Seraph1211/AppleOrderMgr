const { randomUUID } = require('crypto');
const { Sequelize } = require('sequelize');
const inventoryMigration = require('../migrations/20261002000002-create-inventory-monitor');
const validationMigration = require('../migrations/20261002000001-create-inventory-validation');
const signalMigration = require('../migrations/20261019000001-create-aos-signal-queue');
const budgetFixture = require('./helpers/monitorNotificationBudgetFixture');
const InventoryService = require('../src/services/inventoryService');
const InventoryNotifier = require('../src/services/inventoryNotifier');
const AosSignalService = require('../src/services/aosSignalService');
const policy = require('../src/services/aosSignalPolicy');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const { encrypt } = require('../src/utils/fieldEncryption');
const suite = process.env.AOS_SIGNAL_DATABASE_TEST === '1' ? describe : describe.skip;

suite('AOS信号隔离PostgreSQL事务及模拟投递', () => {
  let db;
  let m;
  let service;
  let signals;
  let now;
  const deviceId = randomUUID();
  const localId = randomUUID();
  const fileId = randomUUID();
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
    'AosSignalInbox',
    'AosSignalContext',
  ];
  const feed = async (texts, offset = 1, at = now) => {
    try {
      const rows = texts
        .map((text, index) =>
          policy.parseEntry(
            {
              id: randomUUID(),
              deviceId,
              localId,
              fileId,
              byteOffset: offset + index,
              loggedAt: new Date(at).toISOString(),
              partIndex: 0,
              parseState: 'parsed',
              message: `2026-10-19 08:00:00.000 [2][013]A77-${text}`,
            },
            at
          )
        )
        .filter(Boolean);
      await m.AosSignalInbox.bulkCreate(rows.map(({ id, ...body }) => ({ id, body })));
      return rows;
    } catch (error) {
      throw new Error('合成信号写入失败', { cause: error });
    }
  };
  const deliveries = () =>
    service.rows('InventoryDelivery', {
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
  beforeAll(async () => {
    try {
      if (process.env.DB_HOST !== 'postgres' || process.env.DB_NAME !== 'apple_inventory_dev')
        throw new Error('ISOLATED_COMPOSE_REQUIRED');
      db = new Sequelize('test_aos_signal_backend', process.env.DB_USER, process.env.DB_PASSWORD, {
        host: 'postgres',
        dialect: 'postgres',
        logging: false,
      });
      await validationMigration.up(db.getQueryInterface(), Sequelize);
      await inventoryMigration.up(db.getQueryInterface(), Sequelize);
      await signalMigration.up(db.getQueryInterface(), Sequelize);
      await budgetFixture.up(db);
      m = { sequelize: db };
      for (const name of names) m[name] = require(`../src/models/${name}`)(db);
      m.AosDevice = {
        findAll: () => Promise.resolve([{ id: deviceId, name: 'US Server No.9', enabled: true }]),
      };
      m.MonitorInstance = {
        findAll: () => Promise.resolve([{ deviceId, localId, label: '心蓝11' }]),
      };
      m.MonitorLogState = { findAll: () => Promise.resolve([]) };
      service = new InventoryService(m);
      const locked = service.locked.bind(service);
      service.locked = callback => locked(context => callback({ ...context, now }));
      signals = new AosSignalService(service);
    } catch (error) {
      throw new Error('隔离库初始化失败', { cause: error });
    }
  });
  beforeEach(async () => {
    try {
      now = Date.now();
      for (const name of names) await m[name].destroy({ truncate: true });
      await budgetFixture.reset(db);
      await m.InventoryRuntime.create({ id: 'main', body: {} });
      await m.InventorySetting.create({
        id: 'main',
        body: {
          version: 1,
          config: { ...DEFAULT_CONFIG, aosSignalsEnabled: true },
          aosSignalsSince: now - 1000,
          destinationId: 'synthetic',
          testedDestination: 'synthetic',
          webhookCipher: encrypt(
            'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-only-key'
          ),
        },
      });
    } catch (error) {
      throw new Error('隔离库重置失败', { cause: error });
    }
  });
  afterAll(async () => {
    try {
      await budgetFixture.down(db);
      await signalMigration.down(db.getQueryInterface());
      await inventoryMigration.down(db.getQueryInterface());
      await validationMigration.down(db.getQueryInterface());
    } finally {
      await db?.close();
    }
  });

  test('首次立即、三分钟合并包含首条、空窗口结束及服务重建保留状态', async () => {
    await feed([
      '消息20110501',
      '尝试预约: Apple 王府井, 日期',
      '商品: iPhone Duo 512GB 星光白色 x 1, RMB 1',
      '取货信息: 取货日期待付款完成后确定',
    ]);
    await signals.tick();
    expect((await deliveries())[0].content).toContain('首次信号｜1次命中');
    expect((await deliveries())[0].content).toContain('US_09 / 心蓝11');
    now += 60000;
    await feed(['取货信息: 取货日期待付款完成后确定'], 8);
    await new AosSignalService(service).tick();
    expect(await deliveries()).toHaveLength(1);
    now += 120000;
    await signals.tick();
    expect((await deliveries()).find(row => row.content.includes('3分钟汇总')).content).toContain(
      '2次命中'
    );
    now += 180000;
    await signals.tick();
    expect((await m.InventoryRuntime.findByPk('main')).body.aosSignals).toBeNull();
    now += 1;
    await feed(['取货信息: 取货日期待付款完成后确定'], 9);
    await signals.tick();
    expect((await deliveries()).filter(row => row.content.includes('首次信号'))).toHaveLength(2);
  });

  test('只有首次命中也在首窗汇总一次，重复推进不会重复排队', async () => {
    await feed(['取货信息: 取货日期待付款完成后确定']);
    await signals.tick();
    const first = (await deliveries())[0];
    expect(Object.values(first.aosGroups)[0].count).toBe(1);
    now += 180000;
    await Promise.all([signals.tick(), new AosSignalService(service).tick()]);
    const rows = await deliveries();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => !row.aosImmediate).content).toContain('3分钟汇总｜1次命中');
    expect(Object.values(rows.find(row => row.id === first.id).aosGroups)[0].count).toBe(1);
  });

  test('精确边界新命中归下一窗且不累计首窗，旧空窗口升级不补首条', async () => {
    await feed(['取货信息: 取货日期待付款完成后确定']);
    await signals.tick();
    now += 180000;
    await feed(['取货信息: 取货日期待付款完成后确定'], 2);
    await signals.tick();
    let rows = await deliveries();
    expect(rows.filter(row => !row.aosImmediate)).toHaveLength(1);
    expect(rows.find(row => !row.aosImmediate).content).toContain('3分钟汇总｜1次命中');
    expect(
      Object.values((await m.InventoryRuntime.findByPk('main')).body.aosSignals.groups)[0].count
    ).toBe(1);
    now += 180000;
    await signals.tick();
    rows = await deliveries();
    expect(rows.filter(row => !row.aosImmediate)).toHaveLength(2);
    expect(
      rows.filter(row => !row.aosImmediate).every(row => row.content.includes('3分钟汇总｜1次命中'))
    ).toBe(true);
    const runtime = await m.InventoryRuntime.findByPk('main');
    await runtime.update({
      body: { ...runtime.body, aosSignals: { from: now, until: now + 180000, groups: {} } },
    });
    now += 180000;
    await new AosSignalService(service).tick();
    expect(await deliveries()).toHaveLength(3);
    expect((await m.InventoryRuntime.findByPk('main')).body.aosSignals).toBeNull();
  });

  test('接收前过期、启用前、Worker停顿超过3分钟均不补发', async () => {
    await feed(['取货信息: 取货日期待付款完成后确定'], 1, now - 2000);
    await signals.tick();
    expect(await deliveries()).toHaveLength(0);
    await feed(['取货信息: 取货日期待付款完成后确定'], 2);
    now += 180001;
    await signals.tick();
    expect(await deliveries()).toHaveLength(0);
    expect(await m.AosSignalInbox.count()).toBe(0);
  });

  test('跨批上下文持久化，官网采集和官网通知都关闭仍发送，未知回执不自动重发', async () => {
    await feed([
      '消息20110501',
      '尝试预约: Apple 王府井, 日期',
      '商品: iPhone Duo 512GB 星光白色 x 1, RMB 1',
    ]);
    await signals.tick();
    await feed(['取货信息: 取货日期待付款完成后确定'], 5);
    await signals.tick();
    const send = jest.fn().mockResolvedValue({ status: 'unknown', errorCode: 'TRANSPORT_UNKNOWN' });
    const notifier = new InventoryNotifier(service, send);
    const previousUrl = process.env.INVENTORY_PUBLIC_URL;
    process.env.INVENTORY_PUBLIC_URL = 'https://signal.example.invalid';
    try {
      await notifier.tick();
    } finally {
      if (previousUrl === undefined) delete process.env.INVENTORY_PUBLIC_URL;
      else process.env.INVENTORY_PUBLIC_URL = previousUrl;
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain('北京 · Apple 王府井\niPhone Duo\n星光白色 · 512G');
    expect(send.mock.calls[0][1]).not.toContain(
      'https://signal.example.invalid/server-monitor/logs'
    );
    expect(send.mock.calls[0][1]).not.toContain('/inventory-monitor');
    await notifier.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await deliveries())[0].status).toBe('unknown');
  });

  test('关闭取消待发，旧客户端省略AOS开关保持当前值，重新启用更换代次', async () => {
    await feed(['取货信息: 取货日期待付款完成后确定']);
    await signals.tick();
    const omitted = { ...DEFAULT_CONFIG };
    delete omitted.aosSignalsEnabled;
    await service.saveSettings({ version: 1, config: omitted }, 'synthetic');
    expect((await service.getSettings()).config.aosSignalsEnabled).toBe(true);
    await service.saveSettings(
      { version: 2, config: { ...DEFAULT_CONFIG, aosSignalsEnabled: false } },
      'synthetic'
    );
    expect((await deliveries())[0].status).toBe('skipped');
    now += 10000;
    await service.saveSettings(
      { version: 3, config: { ...DEFAULT_CONFIG, aosSignalsEnabled: true } },
      'synthetic'
    );
    const setting = await m.InventorySetting.findByPk('main');
    expect(setting.body.aosSignalsSince).toBe(now);
  });

  test('双消费者行锁串行，重复tick无新增投递，处理失败回滚队列与窗口', async () => {
    await feed(['取货信息: 取货日期待付款完成后确定']);
    await Promise.all([signals.tick(), new AosSignalService(service).tick()]);
    expect(await deliveries()).toHaveLength(1);
    await feed(['取货信息: 取货日期待付款完成后确定'], 2);
    const failure = jest
      .spyOn(m.AosSignalInbox, 'destroy')
      .mockRejectedValueOnce(new Error('synthetic'));
    await expect(signals.tick()).rejects.toThrow();
    failure.mockRestore();
    expect(await m.AosSignalInbox.count()).toBe(1);
    expect(
      Object.keys((await m.InventoryRuntime.findByPk('main')).body.aosSignals.groups)
    ).toHaveLength(1);
  });
});
