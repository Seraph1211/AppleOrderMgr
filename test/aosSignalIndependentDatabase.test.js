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
  /** 写入同一任务的异时到达事件，模拟日志顺序早于网络到达顺序。 */
  async function feedTimed(index, events, receivedAt) {
    try {
      const instance = instances[index];
      const entries = events
        .map(({ text, offset, loggedAt }) =>
          policy.parseEntry(
            {
              id: randomUUID(),
              deviceId: instance.deviceId,
              localId: instance.localId,
              fileId: `file-${index}`,
              byteOffset: offset,
              loggedAt: new Date(loggedAt).toISOString(),
              parseState: 'parsed',
              partIndex: 0,
              message: `2026-10-19 08:00:00.000 [2][013]A77-${text}`,
            },
            receivedAt
          )
        )
        .filter(Boolean);
      await models.AosSignalInbox.bulkCreate(entries.map(({ id, ...body }) => ({ id, body })));
    } catch (error) {
      throw new Error('异时合成片段写入失败', { cause: error });
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
      const isolatedCompose =
        process.env.DB_HOST === 'postgres' && process.env.DB_NAME === 'apple_inventory_dev';
      const isolatedDedicated =
        process.env.DB_HOST === '127.0.0.1' &&
        process.env.DB_NAME === 'test_aos_signal_association' &&
        process.env.AOS_SIGNAL_TEST_DATABASE === 'test_aos_signal_association';
      if (!isolatedCompose && !isolatedDedicated) throw new Error('仅允许专用测试Compose');
      const databaseName = process.env.AOS_SIGNAL_TEST_DATABASE || 'test_aos_signal_independent';
      db = new Sequelize(databaseName, process.env.DB_USER, process.env.DB_PASSWORD, {
        host: process.env.DB_HOST,
        dialect: 'postgres',
        logging: false,
      });
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

  /* eslint-disable no-magic-numbers */
  test('晚到预约在原接收时刻10秒内补全首次与摘要分组，重启不延长期限', async () => {
    try {
      const base = now;
      await feedTimed(
        0,
        [
          {
            text: '商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999',
            offset: 3,
            loggedAt: base + 16419,
          },
          {
            text: '取货信息: 取货日期待付款完成后确定',
            offset: 4,
            loggedAt: base + 16419,
          },
          {
            text: '取货信息: 取货日期待付款完成后确定',
            offset: 5,
            loggedAt: base + 17000,
          },
        ],
        base + 22690
      );
      now = base + 22690;
      await signals.tick();
      let rows = await deliveries();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'pending',
        aosImmediate: true,
        aosContextDeadline: base + 32690,
      });
      expect(rows[0].content).toContain('未知 · 未知');
      expect(rows[0].aosAssociation.refs).toHaveLength(1);
      expect((await getRuntime()).aosSignals.association.refs).toHaveLength(1);
      const immediateId = rows[0].id;
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      const notifier = new InventoryNotifier(service, send);
      await notifier.tick();
      expect(send).not.toHaveBeenCalled();
      expect((await deliveries())[0].attempts).toBe(0);
      const [budgetRows] = await db.query(
        'SELECT count(*)::integer AS count FROM wecom_robot_budgets'
      );
      expect(budgetRows[0].count).toBe(0);

      const immutableDeliveries = ['sending', 'accepted', 'unknown'];
      const statusSnapshotAt = now;
      const snapshotBody = { ...rows[0] };
      delete snapshotBody.id;
      for (const status of immutableDeliveries) {
        await models.InventoryDelivery.create({
          id: `association-${status}`,
          body: {
            ...snapshotBody,
            status,
            content: `snapshot:${status}`,
            attempts: 7,
            errorCode: `PRESERVE_${status}`,
            batchId: `batch-${status}`,
            claimedAt: now,
            sentAt: now,
          },
        });
      }

      // 新Worker重新读取数据库状态，deadline仍从首次收到anchor开始计算。
      boot();
      await feedTimed(
        0,
        [
          { text: '消息20110501', offset: 1, loggedAt: base + 4609 },
          { text: '尝试预约: Apple 浦东, 日期', offset: 2, loggedAt: base + 5796 },
        ],
        base + 27660
      );
      now = base + 27660;
      // booking仍只在inbox时，claim必须读取并关联；不依赖signal Worker先消费。
      await notifier.tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('上海 · Apple 浦东 · iPhone Duo 星光白色 512G：1次');
      await signals.tick();
      rows = await deliveries();
      const immediate = rows.find(row => row.id === immediateId);
      expect(immediate.aosContextDeadline).toBe(base + 32690);
      expect(immediate.content).toContain('上海 · Apple 浦东 · iPhone Duo 星光白色 512G：1次');
      expect(immediate.content).toContain('来源：S1 US01/心蓝1 1次');
      expect(immediate).toMatchObject({ status: 'accepted', attempts: 1 });
      for (const status of immutableDeliveries) {
        expect(rows.find(row => row.id === `association-${status}`)).toMatchObject({
          status,
          content: `snapshot:${status}`,
          errorCode: `PRESERVE_${status}`,
          attempts: 7,
          claimedAt: statusSnapshotAt,
          sentAt: statusSnapshotAt,
        });
      }

      now = base + 202690;
      await signals.tick();
      rows = await deliveries();
      const summary = rows.find(item => item.content.includes('3分钟汇总'));
      expect(rows.filter(item => item.content.includes('首次信号'))).toHaveLength(1);
      expect(summary.content).toContain('1次命中（非库存数量）');
      expect(summary.content).toContain('上海 · Apple 浦东 · iPhone Duo 星光白色 512G：1次');
      const immediateGroup = Object.values(immediate.aosGroups)[0];
      const summaryGroup = Object.values(summary.aosGroups)[0];
      expect(summaryGroup.count).toBe(1);
      expect(immediateGroup.count).toBe(1);
      expect(Object.values(summaryGroup.sources).map(source => source.count)).toEqual(
        Object.values(immediateGroup.sources).map(source => source.count)
      );
      expect(summary.receivedWindowFrom).toBe(base + 22690);
      expect((await getRuntime()).aosSignals.from).toBe(base + 202690);
    } catch (error) {
      throw new Error('晚到预约关联验收失败', { cause: error });
    }
  });

  test('缺失门店超过10秒后发送未知一次，之后晚到上下文不能改写或重发', async () => {
    try {
      const base = now;
      await feedTimed(
        0,
        [
          { text: '消息20110501', offset: 1, loggedAt: base + 1000 },
          {
            text: '商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999',
            offset: 2,
            loggedAt: base + 2000,
          },
          {
            text: '取货信息: 取货日期待付款完成后确定',
            offset: 3,
            loggedAt: base + 2000,
          },
        ],
        base + 3000
      );
      now = base + 3000;
      await signals.tick();
      const pending = (await deliveries())[0];
      expect(pending.aosContextDeadline).toBe(base + 13000);
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      const notifier = new InventoryNotifier(service, send);
      await notifier.tick();
      expect(send).not.toHaveBeenCalled();
      expect((await deliveries())[0].attempts).toBe(0);

      now = base + 13000;
      await signals.tick();
      await notifier.tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('未知 · 未知');
      const sent = (await deliveries())[0];
      expect(sent).toMatchObject({ status: 'accepted', attempts: 1 });

      await feedTimed(
        0,
        [{ text: '尝试预约: Apple 浦东, 日期', offset: 4, loggedAt: base + 1500 }],
        base + 14000
      );
      now = base + 14000;
      await signals.tick();
      await notifier.tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect((await deliveries())[0]).toMatchObject({
        status: 'accepted',
        attempts: 1,
        content: sent.content,
      });
    } catch (error) {
      throw new Error('晚到超时边界验收失败', { cause: error });
    }
  });

  test('首次锚点已有完整城市门店与商品时立即可发送', async () => {
    try {
      await feed(0, attempt);
      await signals.tick();
      const queued = (await deliveries())[0];
      expect(queued.aosImmediate).toBe(true);
      expect(Object.values(queued.aosGroups).every(policy.hasLocation)).toBe(true);
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      await new InventoryNotifier(service, send).tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect((await deliveries())[0]).toMatchObject({ status: 'accepted', attempts: 1 });
    } catch (error) {
      throw new Error('完整信息首次提醒验收失败', { cause: error });
    }
  });

  test('旧格式首次delivery没有关联字段时保留立即发送语义', async () => {
    try {
      await feed(0, attempt);
      await signals.tick();
      const [created] = await deliveries();
      const { id, aosAssociation, aosContextDeadline, aosImmediate, ...legacyBody } = created;
      expect(aosAssociation).toBeDefined();
      expect(aosContextDeadline).toBeDefined();
      expect(aosImmediate).toBe(true);
      await models.InventoryDelivery.update({ body: legacyBody }, { where: { id } });

      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      await new InventoryNotifier(service, send).tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('北京 · Apple 王府井 · iPhone Duo 星光白色 512G');
      expect((await deliveries()).find(row => row.id === id)).toMatchObject({
        status: 'accepted',
        attempts: 1,
      });
    } catch (error) {
      throw new Error('旧格式AOS delivery兼容验收失败', { cause: error });
    }
  });

  test('claim前晚到reset撤销完整位置时仍沿用原10秒截止', async () => {
    try {
      const base = now;
      await feedTimed(
        0,
        [
          { text: '消息20110501', offset: 1, loggedAt: base + 1000 },
          { text: '尝试预约: Apple 浦东, 日期', offset: 2, loggedAt: base + 1500 },
          {
            text: '商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999',
            offset: 3,
            loggedAt: base + 2000,
          },
          {
            text: '取货信息: 取货日期待付款完成后确定',
            offset: 5,
            loggedAt: base + 2500,
          },
        ],
        base + 3000
      );
      now = base + 3000;
      await signals.tick();
      const [pending] = await deliveries();
      expect(pending.content).toContain('上海 · Apple 浦东 · iPhone Duo 星光白色 512G');
      expect(pending.aosContextDeadline).toBe(base + 13000);

      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      const notifier = new InventoryNotifier(service, send);
      await feedTimed(
        0,
        [{ text: '加入购物车成功', offset: 4, loggedAt: base + 2200 }],
        base + 7000
      );
      now = base + 7000;
      await notifier.tick();
      expect(send).not.toHaveBeenCalled();
      let current = (await deliveries())[0];
      expect(current).toMatchObject({
        status: 'pending',
        attempts: 0,
        aosContextDeadline: base + 13000,
      });
      expect(current.content).toContain('未知 · 未知');

      now = base + 13000;
      await signals.tick();
      await notifier.tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('未知 · 未知');
      current = (await deliveries())[0];
      expect(current).toMatchObject({ status: 'accepted', attempts: 1 });
      expect(current.aosContextDeadline).toBe(base + 13000);
    } catch (error) {
      throw new Error('claim前晚到reset截止验收失败', { cause: error });
    }
  });
  /* eslint-enable no-magic-numbers */

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
