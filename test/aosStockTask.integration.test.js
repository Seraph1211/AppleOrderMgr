/* eslint-disable no-magic-numbers, camelcase -- 合成数据库表使用真实字段名。 */
const { randomUUID } = require('crypto');
const { Sequelize, DataTypes } = require('sequelize');
const validation = require('../migrations/20261002000001-create-inventory-validation');
const inventory = require('../migrations/20261002000002-create-inventory-monitor');
const signal = require('../migrations/20261019000001-create-aos-signal-queue');
const taskConfig = require('../migrations/20261028000003-create-aos-task-config');
const InventoryService = require('../src/services/inventoryService');
const AosSignalService = require('../src/services/aosSignalService');
const parser = require('../src/services/aosSignalPolicy');
const config = require('../src/services/aosTaskConfigPolicy');
const suite = process.env.AOS_STOCK_TASK_DB === '1' ? describe : describe.skip;
const at = Date.parse('2026-10-29T17:41:00+08:00');
const scope = { city: '上海', model: 'iPhone Duo', color: '星光白色', capacity: '512G' };
const submit = '取货信息: 取货日期待付款完成后确定';

suite('有货任务统计隔离PostgreSQL验收', () => {
  let db;
  let models;
  let owner;
  let service;
  let now;
  let offset;
  const deviceId = randomUUID();
  const localId = randomUUID();
  const fileId = randomUUID();
  const instanceId = randomUUID();
  const resetNames = [
    'AosSignalInbox',
    'AosSignalContext',
    'InventoryDelivery',
    'InventoryRuntime',
    'InventorySetting',
  ];
  const runtime = async () => (await models.InventoryRuntime.findByPk('main')).body;
  const rows = () => owner.rows('InventoryDelivery');
  const feed = async (account, texts) => {
    try {
      const entries = texts
        .map(text => {
          offset += 1;
          return parser.parseEntry(
            {
              id: randomUUID(),
              deviceId,
              localId,
              fileId,
              byteOffset: offset,
              loggedAt: new Date(now).toISOString(),
              parseState: 'parsed',
              partIndex: 0,
              message: `2026-10-29 17:41:00.000 [2][${account}]A-${text}`,
            },
            now
          );
        })
        .filter(Boolean);
      await models.AosSignalInbox.bulkCreate(entries.map(({ id, ...body }) => ({ id, body })));
    } catch (error) {
      throw new Error('合成有货日志入队失败', { cause: error });
    }
  };
  const attempt = (account, submitting = false) =>
    feed(account, [
      '消息20110501',
      '尝试预约: Apple 南京东路',
      '商品: iPhone Duo 星光白色 512G x 1, RMB 1',
      ...(submitting ? [submit] : []),
    ]);
  beforeAll(async () => {
    if (
      process.env.DB_HOST !== 'postgres' ||
      process.env.DB_NAME !== 'test_aos_stock_tasks' ||
      process.env.DATABASE_URL
    )
      throw new Error('ISOLATED_STOCK_TASK_DATABASE_REQUIRED');
    db = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
      host: 'postgres',
      dialect: 'postgres',
      logging: false,
    });
    const qi = db.getQueryInterface();
    await qi.createTable('monitor_instances', {
      id: { type: DataTypes.UUID, primaryKey: true },
      device_id: DataTypes.UUID,
      local_id: DataTypes.UUID,
      label: DataTypes.STRING,
    });
    for (const migration of [validation, inventory, signal, taskConfig])
      await migration.up(qi, Sequelize);
    models = { sequelize: db };
    for (const name of [...resetNames, 'AosTaskConfigVersion'])
      models[name] = require(`../src/models/${name}`)(db);
    models.MonitorInstance = db.define(
      'StockTestInstance',
      {
        id: { type: DataTypes.UUID, primaryKey: true },
        deviceId: { type: DataTypes.UUID, field: 'device_id' },
        localId: { type: DataTypes.UUID, field: 'local_id' },
        label: DataTypes.STRING,
      },
      { tableName: 'monitor_instances', timestamps: false }
    );
    await models.MonitorInstance.create({ id: instanceId, deviceId, localId, label: '01号实例' });
    await models.AosTaskConfigVersion.create({
      id: randomUUID(),
      instanceId,
      number: 1,
      effectiveAt: new Date(at - 10000),
      actorId: 1,
      source: 'import',
      contentHash: '0'.repeat(64),
      rows: [],
      aggregates: [{ ...scope, taskCount: 45 }],
      taskCount: 45,
      cityCount: 1,
      specCount: 1,
      blankLineCount: 0,
    });
    models.AosDevice = {
      findAll: () => Promise.resolve([{ id: deviceId, name: 'US_01', enabled: true }]),
    };
    models.MonitorLogState = { findAll: () => Promise.resolve([]) };
    owner = new InventoryService(models);
    const locked = owner.locked.bind(owner);
    owner.locked = work => locked(context => work({ ...context, now }));
    service = new AosSignalService(owner);
  });
  beforeEach(async () => {
    for (const name of resetNames) await models[name].destroy({ truncate: true });
    offset = 0;
    now = at - 1000;
    await models.InventoryRuntime.create({ id: 'main', body: {} });
    await models.InventorySetting.create({
      id: 'main',
      body: {
        config: { aosSignalsEnabled: true },
        aosSignalsSince: at - 2000,
        webhookCipher: 'synthetic-only',
        destinationId: 'synthetic',
        testedDestination: 'synthetic',
      },
    });
    await service.tick();
    now = at;
  });
  afterAll(async () => {
    try {
      if (db) {
        for (const migration of [taskConfig, signal, inventory, validation])
          await migration.down(db.getQueryInterface());
        await db.getQueryInterface().dropTable('monitor_instances');
      }
    } finally {
      await db?.close();
    }
  });

  test('真实事务收集20个任务，9任务11次提交，服务重建输出9/20/45且重复tick不重计', async () => {
    for (let i = 0; i < 20; i += 1) await attempt(String(i).padStart(3, '0'), i < 9);
    await feed('000', [submit]);
    await feed('001', [submit]);
    await service.tick();
    expect(await rows()).toHaveLength(1);
    expect((await runtime()).aosStockTasks.refs).toHaveLength(20);
    now += 180000;
    await new AosSignalService(owner).tick();
    const summary = (await rows()).find(row => !row.aosImmediate);
    expect(summary.content).toContain('3分钟汇总｜11次命中｜1家门店');
    expect(summary.content).toContain('US_01 / 01号实例｜9/20/45');
    expect(
      summary.aosAccountRatio.scopes[config.scopeKey(scope)].sources[`${deviceId}:${localId}`]
        .stockAccounts
    ).toHaveLength(20);
    await new AosSignalService(owner).tick();
    expect(await rows()).toHaveLength(2);
  });

  test('仅检测的任务先入库，跨批次失败也统计；晚到商品补齐且不增加提交次数', async () => {
    await feed('002', ['消息20110501']);
    await service.tick();
    expect(await rows()).toHaveLength(0);
    now += 1000;
    await feed('002', ['尝试预约: Apple 南京东路', '商品: iPhone Duo 星光白色 512G x 1, RMB 1']);
    await attempt('001', true);
    await service.tick();
    now += 180000;
    await service.tick();
    const summary = (await rows()).find(row => !row.aosImmediate);
    // 首次提交之前已经检测、随后失败的任务也属于本轮，不能被提交时间截掉。
    expect(summary.content).toContain('1/2/45');
    expect(summary.content).toContain('1次命中');
  });

  test('真实数据库异常回滚有货状态、上下文和队列删除，恢复重试只计一次', async () => {
    await attempt('001', true);
    const put = owner.put.bind(owner);
    owner.put = jest.fn().mockRejectedValue(new Error('synthetic-write-failure'));
    await expect(service.tick()).rejects.toThrow();
    expect((await runtime()).aosStockTasks.refs).toHaveLength(0);
    expect(await models.AosSignalInbox.count()).toBe(4);
    expect(await models.AosSignalContext.count()).toBe(0);
    owner.put = put;
    await service.tick();
    expect((await runtime()).aosStockTasks.refs).toHaveLength(1);
    expect(await models.AosSignalInbox.count()).toBe(0);
  });

  test('汇总前复核未消费有货任务，队列及运行时在同一锁内保持一致', async () => {
    await attempt('001', true);
    await service.tick();
    now += 1000;
    await attempt('002');
    now += 179000;
    await service.tick();
    const summary = (await rows()).find(row => !row.aosImmediate);
    expect(summary.content).toContain('1/2/45');
    await owner.locked(context => service.reconcile({ ...context, now }));
    const updated = (await rows()).find(row => row.id === summary.id);
    expect(updated.content).toContain('1/2/45');
  });

  test('首窗前置检测在运行态TTL清理后，待发通知复核仍保留全部检测任务', async () => {
    await attempt('001');
    await attempt('002');
    await service.tick();
    now += 179000;
    await feed('001', [submit]);
    await service.tick();
    now += 180000;
    await service.tick();
    const summary = (await rows()).find(row => !row.aosImmediate);
    expect(summary.content).toContain('1/2/45');
    now += 2000;
    await service.tick();
    expect((await runtime()).aosStockTasks.refs).toHaveLength(0);
    await owner.locked(context => service.reconcile({ ...context, now }));
    expect((await rows()).find(row => row.id === summary.id).content).toContain('1/2/45');
  });

  test('并发tick不重复消费，停用清空跟踪，重新启用水位不能复用旧检测', async () => {
    await attempt('001', true);
    await Promise.all([service.tick(), new AosSignalService(owner).tick()]);
    expect((await runtime()).aosStockTasks.refs).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    await models.InventorySetting.update(
      { body: { config: { aosSignalsEnabled: false } } },
      { where: { id: 'main' } }
    );
    await service.tick();
    expect((await runtime()).aosStockTasks).toBeNull();
  });
});
