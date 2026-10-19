const { randomUUID } = require('crypto');
const { Sequelize } = require('sequelize');
const validationMigration = require('../migrations/20261002000001-create-inventory-validation');
const inventoryMigration = require('../migrations/20261002000002-create-inventory-monitor');
const signalMigration = require('../migrations/20261019000001-create-aos-signal-queue');
const robotBudgetFixture = require('./helpers/monitorNotificationBudgetFixture');
const InventoryService = require('../src/services/inventoryService');
const InventoryNotifier = require('../src/services/inventoryNotifier');
const AosSignalService = require('../src/services/aosSignalService');
const policy = require('../src/services/aosSignalPolicy');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const { encrypt } = require('../src/utils/fieldEncryption');
const suite = process.env.AOS_SIGNAL_INDEPENDENT_DB === '1' ? describe : describe.skip;

suite('AOS 独立隔离库验收：多来源全局窗口与共用投递约束', () => {
  let db;
  let models;
  let service;
  let signals;
  let now;
  const devices = Array.from({ length: 10 }, (_, i) => ({
    id: randomUUID(),
    name: `US Server No.${i + 1}`,
    enabled: true,
  }));
  const instances = Array.from({ length: 11 }, (_, i) => ({
    deviceId: devices[Math.min(i, 9)].id,
    localId: randomUUID(),
    label: `心蓝${i + 1}`,
  }));
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
  const boot = () => {
    service = new InventoryService(models);
    const locked = service.locked.bind(service);
    service.locked = callback => locked(context => callback({ ...context, now }));
    signals = new AosSignalService(service);
  };
  /** 写入安全合成片段，设备实例资料由独立合成查询返回。 */
  async function feed(index, texts, offset = 1, at = now) {
    try {
      const instance = instances[index];
      const entries = texts.map((text, i) =>
        policy.parseEntry(
          {
            id: randomUUID(),
            deviceId: instance.deviceId,
            localId: instance.localId,
            fileId: `file-${index}`,
            byteOffset: offset + i,
            loggedAt: new Date(at).toISOString(),
            parseState: 'parsed',
            partIndex: 0,
            message: `2026-10-19 08:00:00.000 [2][013]A77-${text}`,
          },
          at
        )
      );
      await models.AosSignalInbox.bulkCreate(
        entries.filter(Boolean).map(({ id, ...body }) => ({ id, body }))
      );
    } catch (error) {
      throw new Error('独立合成片段写入失败', { cause: error });
    }
  }
  const attempt = [
    '加入购物车成功',
    '尝试预约: Apple 王府井, 日期',
    '商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999',
    '取货信息: 取货日期待付款完成后确定',
  ];
  const deliveries = () => service.rows('InventoryDelivery');
  const getRuntime = async () => {
    try {
      return (await models.InventoryRuntime.findByPk('main')).body;
    } catch (error) {
      throw new Error('独立运行状态读取失败', { cause: error });
    }
  };
  /** 只修改隔离库合成状态。 */
  async function changeSetting(patch) {
    try {
      const saved = await models.InventorySetting.findByPk('main');
      await saved.update({ body: { ...saved.body, ...patch } });
    } catch (error) {
      throw new Error('独立配置更新失败', { cause: error });
    }
  }

  beforeAll(async () => {
    try {
      if (process.env.DB_HOST !== 'postgres' || process.env.DB_NAME !== 'apple_inventory_dev')
        throw new Error('仅允许专用测试Compose');
      db = new Sequelize(
        'test_aos_signal_independent',
        process.env.DB_USER,
        process.env.DB_PASSWORD,
        {
          host: 'postgres',
          dialect: 'postgres',
          logging: false,
        }
      );
      await validationMigration.up(db.getQueryInterface(), Sequelize);
      await inventoryMigration.up(db.getQueryInterface(), Sequelize);
      await signalMigration.up(db.getQueryInterface(), Sequelize);
      await robotBudgetFixture.up(db);
      models = { sequelize: db };
      for (const name of names) models[name] = require(`../src/models/${name}`)(db);
      models.AosDevice = { findAll: () => Promise.resolve(devices) };
      models.MonitorInstance = { findAll: () => Promise.resolve(instances) };
      models.MonitorLogState = { findAll: () => Promise.resolve([]) };
      boot();
    } catch (error) {
      throw new Error('独立隔离库初始化失败', { cause: error });
    }
  });
  beforeEach(async () => {
    try {
      now = Date.parse('2026-10-19T12:00:00+08:00');
      for (const name of names) await models[name].destroy({ truncate: true });
      await robotBudgetFixture.reset(db);
      await models.InventoryRuntime.create({ id: 'main', body: {} });
      await models.InventorySetting.create({
        id: 'main',
        body: {
          version: 1,
          config: { ...DEFAULT_CONFIG, aosSignalsEnabled: true },
          aosSignalsSince: now - 1,
          destinationId: 'synthetic-one',
          testedDestination: 'synthetic-one',
          webhookCipher: encrypt(
            'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=independent-synthetic-key'
          ),
        },
      });
      boot();
    } catch (error) {
      throw new Error('独立合成数据重置失败', { cause: error });
    }
  });
  afterAll(async () => {
    try {
      if (db) {
        await robotBudgetFixture.down(db);
        await signalMigration.down(db.getQueryInterface());
        await inventoryMigration.down(db.getQueryInterface());
        await validationMigration.down(db.getQueryInterface());
      }
    } finally {
      await db?.close();
    }
  });

  test('十台十一实例并发入队只有一次全局立即提醒，摘要恰好10次且不重复首条', async () => {
    try {
      await Promise.all(instances.map((_, i) => feed(i, attempt)));
      await Promise.all([signals.tick(), new AosSignalService(service).tick()]);
      let rows = await deliveries();
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toContain('首次信号：1次命中');
      expect(await models.AosSignalInbox.count()).toBe(0);
      expect(await models.AosSignalContext.count()).toBe(11);
      const firstSource = Object.keys(Object.values(rows[0].aosGroups)[0].sources)[0];
      now += 180000;
      boot();
      await signals.tick();
      rows = await deliveries();
      expect(rows).toHaveLength(2);
      const summary = rows.find(item => item.content.includes('3分钟汇总'));
      expect(summary.content).toContain('10次命中（非库存数量）');
      const sources = Object.values(summary.aosGroups).flatMap(group => Object.keys(group.sources));
      expect(sources).toHaveLength(10);
      expect(sources).not.toContain(firstSource);
      const allSources = rows.map(item => item.content).join('\n');
      for (let i = 1; i <= 11; i += 1) expect(allSources).toContain(`/心蓝${i} `);
      expect(allSources).toContain('US01/');
      expect(allSources).toContain('US10/');
    } catch (error) {
      throw new Error('全局窗口验收失败', { cause: error });
    }
  });

  test('窗口末尾新命中先摘要，完整下个空窗口结束后再立即；服务重启不丢轮次', async () => {
    try {
      await feed(0, attempt);
      await signals.tick();
      now += 179999;
      await feed(10, attempt);
      await signals.tick();
      expect(await deliveries()).toHaveLength(1);
      now += 1;
      boot();
      await signals.tick();
      expect(await deliveries()).toHaveLength(2);
      expect((await getRuntime()).aosSignals).toBeTruthy();
      now += 179999;
      await signals.tick();
      expect((await getRuntime()).aosSignals).toBeTruthy();
      now += 1;
      await signals.tick();
      expect((await getRuntime()).aosSignals).toBeNull();
      now += 1;
      await feed(9, attempt);
      await signals.tick();
      expect((await deliveries()).filter(item => item.content.includes('首次信号'))).toHaveLength(
        2
      );
    } catch (error) {
      throw new Error('空窗口验收失败', { cause: error });
    }
  });

  test('AOS信号独立于库存采集和库存通知，共用静默时段并按新鲜有效期跳过', async () => {
    try {
      await changeSetting({
        config: {
          ...DEFAULT_CONFIG,
          aosSignalsEnabled: true,
          silentStart: '11:00',
          silentEnd: '13:00',
        },
      });
      await feed(0, attempt);
      await signals.tick();
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      const notifier = new InventoryNotifier(service, send);
      await notifier.tick();
      expect(send).not.toHaveBeenCalled();
      expect((await deliveries())[0].status).toBe('pending');
      now += 180001;
      await notifier.tick();
      expect(send).not.toHaveBeenCalled();
      expect((await deliveries())[0]).toMatchObject({ status: 'skipped', errorCode: 'EXPIRED' });
    } catch (error) {
      throw new Error('静默和时效验收失败', { cause: error });
    }
  });

  test('复用18条/分钟目标群限速，额度释放后可发送且transport异常只记未知', async () => {
    try {
      await models.InventoryRuntime.update(
        {
          body: {
            notificationRate: Array.from({ length: 18 }, () => ({
              at: now,
              destinationId: 'synthetic-one',
            })),
          },
        },
        { where: { id: 'main' } }
      );
      await feed(0, attempt);
      await signals.tick();
      const send = jest.fn().mockRejectedValue(new Error('synthetic timeout'));
      await new InventoryNotifier(service, send).tick();
      expect(send).not.toHaveBeenCalled();
      now += 60001;
      await new InventoryNotifier(service, send).tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect((await deliveries())[0]).toMatchObject({ status: 'unknown', attempts: 1 });
      boot();
      now += 30000;
      await new InventoryNotifier(service, send).tick();
      expect(send).toHaveBeenCalledTimes(1);
    } catch (error) {
      throw new Error('限速和未知回执验收失败', { cause: error });
    }
  });

  test('明确失败仅有限重试，同一投递最多三次并保留失败记录', async () => {
    try {
      await feed(0, attempt);
      await signals.tick();
      const send = jest
        .fn()
        .mockResolvedValue({ status: 'pending', retryMs: 10000, errorCode: 'SYNTHETIC_REJECTED' });
      const notifier = new InventoryNotifier(service, send);
      for (let i = 0; i < 4; i += 1) {
        await notifier.tick();
        now += 10001;
      }
      expect(send).toHaveBeenCalledTimes(3);
      expect((await deliveries())[0]).toMatchObject({ status: 'failed', attempts: 3 });
    } catch (error) {
      throw new Error('明确失败重试验收失败', { cause: error });
    }
  });

  test('换机器人必须重测，取消旧目标且清空轮次，旧代次信号不能重新入队', async () => {
    try {
      await feed(0, attempt);
      await signals.tick();
      await service.saveSettings(
        {
          version: 1,
          config: { ...DEFAULT_CONFIG, aosSignalsEnabled: false },
          webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=independent-second-key',
        },
        'synthetic'
      );
      expect((await deliveries())[0]).toMatchObject({
        status: 'skipped',
        errorCode: 'DESTINATION_CHANGED',
      });
      expect((await getRuntime()).aosSignals).toBeNull();
      await expect(
        service.saveSettings(
          { version: 2, config: { ...DEFAULT_CONFIG, aosSignalsEnabled: true } },
          'synthetic'
        )
      ).rejects.toThrow();
      const saved = (await models.InventorySetting.findByPk('main')).body;
      await changeSetting({ testedDestination: saved.destinationId });
      now += 1000;
      await service.saveSettings(
        { version: 2, config: { ...DEFAULT_CONFIG, aosSignalsEnabled: true } },
        'synthetic'
      );
      await feed(1, attempt, 1, now - 500);
      await signals.tick();
      expect(await deliveries()).toHaveLength(1);
      await feed(1, attempt, 10);
      await signals.tick();
      expect(await deliveries()).toHaveLength(2);
    } catch (error) {
      throw new Error('换机器人与代次验收失败', { cause: error });
    }
  });
});
