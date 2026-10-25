/* eslint-disable no-magic-numbers */
const { randomUUID, createHash } = require('crypto');
const vm = require('vm');
const { createRequire } = require('module');
const { Sequelize, QueryTypes } = require('sequelize');
const configPolicy = require('../src/services/aosAccountConfigPolicy');
const configs = require('../src/services/aosAccountConfigService');
const legacy = require('./fixtures/aosAccountRatioLegacyApi.json');
const indexMigration = require('../migrations/20261026000001-create-aos-account-config-index');
const inventoryMigration = require('../migrations/20261002000002-create-inventory-monitor');
const validationMigration = require('../migrations/20261002000001-create-inventory-validation');
const signalMigration = require('../migrations/20261019000001-create-aos-signal-queue');
const logMigration = require('../migrations/20260929000001-add-monitor-full-logs');
const blockMigration = require('../migrations/20261007000001-add-monitor-log-block-storage');
const repeatMigration = require('../migrations/20261007000002-add-monitor-log-repeat-limits');
const budgetFixture = require('./helpers/monitorNotificationBudgetFixture');
const InventoryService = require('../src/services/inventoryService');
const AosSignalService = require('../src/services/aosSignalService');
const InventoryNotifier = require('../src/services/inventoryNotifier');
const ratios = require('../src/services/aosAccountRatioService');
const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const { encrypt } = require('../src/utils/fieldEncryption');

const suite = process.env.AOS_ACCOUNT_RATIO_QA_DB === '1' ? describe : describe.skip;
const DEVICE = '11111111-1111-4111-8111-111111111111';
const INSTANCE = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const SCOPE = { city: '广州', model: 'iPhone Duo', color: '星光白色', capacity: '512G' };

suite('AOS账号比例独立真实PG：旧API协议、索引事务、覆盖及错误隔离', () => {
  let db;
  let models;
  let service;
  let now;
  let legacyPolicy;
  let legacyEnqueue;
  let active = true;
  const modelNames = [
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
    'AosAccountRegistry',
    'AosAccountConfigEvent',
    'AosAccountIndexState',
    'MonitorLogEntry',
    'MonitorLogState',
  ];

  /** 构造安全合成日志；开始设置刻意不带A头，信号仍用原任务头协议。 */
  function row(text, options = {}) {
    const at = options.at ?? now - 1000;
    const account = options.account ?? '001';
    const stamp = new Date(at + 8 * 3600000).toISOString().slice(0, 23).replace('T', ' ');
    return {
      id: options.id || randomUUID(),
      deviceId: DEVICE,
      localId: INSTANCE,
      fileId: options.fileId || FILE,
      byteOffset: options.offset ?? 10,
      loggedAt: new Date(at).toISOString(),
      accountNumber: account,
      parseState: 'parsed',
      partIndex: 0,
      message: `${stamp} [2][${account}]${options.task ? `${options.task}-` : ''}${text}\r\n`,
    };
  }

  function startup(account = '001', at = now - 7 * 3600000) {
    return [
      row('开始监控库存状态......', { account, at, offset: 1 }),
      row('开始下单 iPhone Duo 星光白色 512G(x1)....', { account, at: at + 1, offset: 2 }),
      row('消息24093001: R639, 2, , 0', { account, at: at + 2, offset: 3, task: 'A337' }),
    ];
  }

  /** 在真实事务中调用生产索引写入，不用测试模型sync或伪造新字段。 */
  async function ingest(rows) {
    try {
      return await db.transaction(transaction => configs.ingest(rows, transaction, models));
    } catch (error) {
      throw new Error('QA_INDEX_INGEST_FAILED', { cause: error });
    }
  }

  /** 仅为测试已完成回填快照设置状态；partial单独验证不可伪装ready。 */
  async function ready() {
    try {
      await models.AosAccountIndexState.update(
        { status: 'ready', body: {} },
        { where: { deviceId: DEVICE, localId: INSTANCE } }
      );
    } catch (error) {
      throw new Error('QA_COVERAGE_STATE_FAILED', { cause: error });
    }
  }

  async function read(from = now - 1000, to = now) {
    try {
      return await db.transaction(transaction =>
        configs.load(models, { deviceId: DEVICE, localId: INSTANCE }, from, to, transaction)
      );
    } catch (error) {
      throw new Error('QA_INDEX_READ_FAILED', { cause: error });
    }
  }

  beforeAll(async () => {
    try {
      if (
        process.env.DB_HOST !== 'postgres' ||
        process.env.DB_NAME !== 'apple_inventory_dev' ||
        process.env.AOS_ACCOUNT_RATIO_TEST_DATABASE !== 'test_aos_account_ratio_qa'
      )
        throw new Error('DEDICATED_QA_DATABASE_REQUIRED');
      db = new Sequelize(
        'test_aos_account_ratio_qa',
        process.env.DB_USER,
        process.env.DB_PASSWORD,
        { host: 'postgres', dialect: 'postgres', logging: false, pool: { max: 8 } }
      );
      await db.query('CREATE TABLE aos_devices(id uuid PRIMARY KEY)');
      await db.query('INSERT INTO aos_devices(id) VALUES (:id)', { replacements: { id: DEVICE } });
      await validationMigration.up(db.getQueryInterface(), Sequelize);
      await inventoryMigration.up(db.getQueryInterface(), Sequelize);
      await signalMigration.up(db.getQueryInterface(), Sequelize);
      await logMigration.up(db.getQueryInterface(), Sequelize);
      await blockMigration.up(db.getQueryInterface(), Sequelize);
      await repeatMigration.up(db.getQueryInterface(), Sequelize);
      await indexMigration.up(db.getQueryInterface(), Sequelize);
      await budgetFixture.up(db);
      models = { sequelize: db };
      for (const name of modelNames) models[name] = require(`../src/models/${name}`)(db);
      models.AosDevice = {
        findAll: () => Promise.resolve([{ id: DEVICE, name: 'US Server 12', enabled: active }]),
        findByPk: () => Promise.resolve({ id: DEVICE, name: 'US Server 12', enabled: active }),
      };
      models.MonitorInstance = {
        findAll: () =>
          Promise.resolve([{ deviceId: DEVICE, localId: INSTANCE, label: '心蓝13', active }]),
        findOne: () =>
          Promise.resolve({ deviceId: DEVICE, localId: INSTANCE, label: '心蓝13', active }),
      };
      jest.doMock('../src/models', () => models);
      const dependencies = createRequire(require.resolve('../src/services/aosSignalPolicy'));
      const policyModule = { exports: {} };
      vm.runInNewContext(
        legacy.policySource,
        { module: policyModule, require: dependencies, Buffer, structuredClone },
        { filename: 'frozen-real-legacy-api-policy.js' }
      );
      legacyPolicy = policyModule.exports;
      const enqueueModule = { exports: {} };
      vm.runInNewContext(
        `${legacy.enqueueSource}\nmodule.exports = enqueue;`,
        {
          module: enqueueModule,
          policy: legacyPolicy,
          QueryTypes,
          Date,
          require: name => (name === '../models' ? models : dependencies(name)),
        },
        { filename: 'frozen-real-legacy-api-enqueue.js' }
      );
      legacyEnqueue = enqueueModule.exports;
      expect(createHash('sha256').update(legacy.policySource).digest('hex')).toBe(
        legacy.policySha256
      );
      expect(createHash('sha256').update(legacy.enqueueSource).digest('hex')).toBe(
        legacy.enqueueSha256
      );
    } catch (error) {
      throw new Error('QA_DATABASE_SETUP_FAILED', { cause: error });
    }
  });

  beforeEach(async () => {
    try {
      now = Date.now();
      active = true;
      const resetTables = [
        'aos_account_registries',
        'aos_account_config_events',
        'aos_account_index_states',
        'inventory_deliveries',
        'aos_signal_inbox',
        'aos_signal_contexts',
        'inventory_runtime',
        'inventory_settings',
        'monitor_log_entries',
        'monitor_log_states',
        'monitor_log_receipts',
        'monitor_log_block_accounts',
        'monitor_log_blocks',
        'monitor_log_files',
        'monitor_log_storage_scopes',
        'monitor_log_storage_metrics',
      ].join(',');
      await db.query(`TRUNCATE ${resetTables} CASCADE`);
      await budgetFixture.reset(db);
      await models.InventoryRuntime.create({ id: 'main', body: {} });
      await models.InventorySetting.create({
        id: 'main',
        body: {
          version: 1,
          config: { ...DEFAULT_CONFIG, aosSignalsEnabled: true },
          aosSignalsSince: now - 60000,
          destinationId: 'qa-synthetic',
          testedDestination: 'qa-synthetic',
          webhookCipher: encrypt(
            'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=qa-synthetic-ratio-only'
          ),
        },
      });
      await models.MonitorLogState.create({
        id: randomUUID(),
        deviceId: DEVICE,
        localId: INSTANCE,
        label: '心蓝13',
        observedAt: new Date(now + 3600000),
        snapshot: {
          state: 'ready',
          pending: 0,
          issues: 0,
          scannedBytes: 100,
          totalBytes: 100,
          expired: 0,
          dates: [new Date(now + 8 * 3600000).toISOString().slice(0, 10)],
        },
      });
      service = new InventoryService(models);
      const locked = service.locked.bind(service);
      service.locked = work => locked(context => work({ ...context, now }));
    } catch (error) {
      throw new Error('QA_DATABASE_RESET_FAILED', { cause: error });
    }
  });

  afterAll(async () => {
    try {
      if (db) {
        await budgetFixture.down(db);
        await indexMigration.down(db.getQueryInterface());
        await repeatMigration.down(db.getQueryInterface());
        await blockMigration.down(db.getQueryInterface());
        await logMigration.down(db.getQueryInterface());
        await signalMigration.down(db.getQueryInterface());
        await inventoryMigration.down(db.getQueryInterface());
        await validationMigration.down(db.getQueryInterface());
        await db.query('DROP TABLE aos_devices');
      }
    } finally {
      jest.dontMock('../src/models');
      await db?.close();
    }
  });

  test('正式index Migration down/up只影响新三表，旧库存设置保留', async () => {
    try {
      await indexMigration.down(db.getQueryInterface());
      expect(await models.InventorySetting.count()).toBe(1);
      await indexMigration.up(db.getQueryInterface(), Sequelize);
      expect(await models.AosAccountRegistry.count()).toBe(0);
      expect(await models.InventorySetting.count()).toBe(1);
    } catch (error) {
      throw new Error('QA_MIGRATION_ROUNDTRIP_FAILED', { cause: error });
    }
  });

  test('200条标准批次真实写入与重复批次幂等，不触发历史信号入队', async () => {
    try {
      const rows = Array.from({ length: 100 }, (_, index) =>
        String(index + 1).padStart(3, '0')
      ).flatMap(account => startup(account).slice(1));
      expect(rows).toHaveLength(200);
      await ingest(rows);
      expect(await models.AosAccountRegistry.count()).toBe(100);
      expect(await models.AosAccountConfigEvent.count()).toBe(200);
      await ingest([...rows].reverse());
      expect(await models.AosAccountRegistry.count()).toBe(100);
      expect(await models.AosAccountConfigEvent.count()).toBe(200);
      expect(await models.AosSignalInbox.count()).toBe(0);
      expect(await models.InventoryDelivery.count()).toBe(0);
    } catch (error) {
      throw new Error('QA_BATCH_IDEMPOTENCY_FAILED', { cause: error });
    }
  });

  test('事件id冲突拒绝并回滚整个索引批次，原摘要不可覆盖', async () => {
    try {
      const original = startup('001')[1];
      await ingest([original]);
      const saved = (await models.AosAccountConfigEvent.findByPk(original.id)).toJSON();
      const conflict = row('开始下单 iPhone Duo 夜空色 1T(x1)....', {
        id: original.id,
        account: '999',
      });
      await expect(ingest([conflict])).rejects.toThrow('QA_INDEX_INGEST_FAILED');
      expect((await models.AosAccountConfigEvent.findByPk(original.id)).payloadHash).toBe(
        saved.payloadHash
      );
      expect(await models.AosAccountRegistry.count()).toBe(1);
      expect(await models.AosAccountRegistry.count({ where: { accountNumber: '999' } })).toBe(0);
    } catch (error) {
      throw new Error('QA_CONFLICT_ROLLBACK_FAILED', { cause: error });
    }
  });

  test('实时/回填相反顺序并发写同批次保持幂等，无重复账号或事件', async () => {
    try {
      const rows = Array.from({ length: 40 }, (_, index) =>
        String(index + 1).padStart(3, '0')
      ).flatMap(account => startup(account));
      await Promise.all([ingest(rows), ingest([...rows].reverse())]);
      expect(await models.AosAccountRegistry.count()).toBe(40);
      expect(await models.AosAccountConfigEvent.count()).toBe(120);
    } catch (error) {
      throw new Error('QA_CONCURRENT_INGEST_FAILED', { cause: error });
    }
  });

  test('回填partial/空索引不可精确D，ready完整覆盖后可读取历史设置', async () => {
    try {
      expect((await read()).ready).toBe(false);
      await ingest(startup());
      expect((await read()).ready).toBe(false);
      await ready();
      const loaded = await read();
      expect(loaded.ready).toBe(true);
      expect(configPolicy.population(loaded.registries, loaded.events, SCOPE, now).members).toEqual(
        ['001']
      );
    } catch (error) {
      throw new Error('QA_COVERAGE_GATE_FAILED', { cause: error });
    }
  });

  test('20001条同配置重复city监控7小时仍有精确D且保留首hit前城市证据', async () => {
    try {
      await ingest(startup());
      await db.query(
        `INSERT INTO aos_account_config_events
        (id,device_id,local_id,account_number,file_id,byte_offset,line_index,
         logged_at,kind,body,payload_hash)
        SELECT md5('qa-city-'||g::text),:device,:local,'001',:file,100+g,0,
          :at::timestamptz + (g * interval '1 second'),'city',
          '{"cities":["广州"],"unknown":false}'::jsonb,:hash FROM generate_series(1,20001) AS g`,
        {
          replacements: {
            device: DEVICE,
            local: INSTANCE,
            file: FILE,
            at: new Date(now - 6 * 3600000),
            hash: '0'.repeat(64),
          },
        }
      );
      await ready();
      expect(await models.AosAccountConfigEvent.count()).toBeGreaterThan(20000);
      const loaded = await read(now - 1000, now);
      expect(loaded.ready).toBe(true);
      expect(loaded.events.length).toBeLessThan(10);
      expect(
        configPolicy.population(loaded.registries, loaded.events, SCOPE, now - 1000).members
      ).toEqual(['001']);
    } catch (error) {
      throw new Error('QA_DUPLICATE_CITY_COMPACTION_FAILED', { cause: error });
    }
  }, 30000);

  test('load查询42P01仅比例降级，保存点恢复后父事务仍可提交旧通知', async () => {
    try {
      await ingest(startup());
      await ready();
      await db.transaction(async transaction => {
        try {
          await db.query('ALTER TABLE aos_account_registries RENAME TO qa_missing_registry', {
            transaction,
          });
          const loaded = await configs.load(
            models,
            { deviceId: DEVICE, localId: INSTANCE },
            now - 1000,
            now,
            transaction
          );
          expect(loaded.ready).toBe(false);
          const [check] = await db.query('SELECT 1 AS ok', {
            type: QueryTypes.SELECT,
            transaction,
          });
          expect(check.ok).toBe(1);
          await db.query('ALTER TABLE qa_missing_registry RENAME TO aos_account_registries', {
            transaction,
          });
          await models.InventoryDelivery.create(
            { id: 'qa-parent-delivery', body: { kind: 'test', content: '旧通知继续' } },
            { transaction }
          );
        } catch (error) {
          throw new Error('QA_PARENT_LOAD_TRANSACTION_FAILED', { cause: error });
        }
      });
      expect(await models.InventoryDelivery.count()).toBe(1);
    } catch (error) {
      throw new Error('QA_LOAD_SAVEPOINT_FAILED', { cause: error });
    }
  });

  test('attachAccounts查询42P01仅编号未知，父事务继续且不借任务hash猜账号', async () => {
    try {
      const signal = row('取货信息: 取货日期待付款完成后确定', { task: 'A337' });
      const anchor = legacyPolicy.parseEntries(signal, now)[0];
      await ingest([signal]);
      await db.transaction(async transaction => {
        try {
          await db.query('ALTER TABLE aos_account_config_events RENAME TO qa_missing_events', {
            transaction,
          });
          const attached = await configs.attachAccounts(models, [anchor], transaction);
          expect(attached[0].accountNumber).toBeNull();
          const [check] = await db.query('SELECT 1 AS ok', {
            type: QueryTypes.SELECT,
            transaction,
          });
          expect(check.ok).toBe(1);
          await db.query('ALTER TABLE qa_missing_events RENAME TO aos_account_config_events', {
            transaction,
          });
        } catch (error) {
          throw new Error('QA_PARENT_ATTACH_TRANSACTION_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('QA_ATTACH_SAVEPOINT_FAILED', { cause: error });
    }
  });

  test('真实旧API enqueue写无accountNumber inbox，新索引按事件/位置补齐含多行编号', async () => {
    try {
      const one = row('取货信息: 取货日期待付款完成后确定', { account: '001', task: 'A337' });
      const two = row('取货信息: 取货日期待付款完成后确定', { account: '002', task: 'A338' });
      const combined = { ...one, message: one.message + two.message };
      await db.transaction(async transaction => {
        try {
          await configs.ingest([combined], transaction, models);
          await legacyEnqueue([combined], transaction);
        } catch (error) {
          throw new Error('QA_LEGACY_ENQUEUE_TRANSACTION_FAILED', { cause: error });
        }
      });
      const inbox = await models.AosSignalInbox.findAll({ order: [['id', 'ASC']] });
      expect(inbox).toHaveLength(2);
      expect(inbox.every(event => event.body.accountNumber === undefined)).toBe(true);
      const anchors = inbox.map(event => ({ id: event.id, ...event.body }));
      const attached = await db.transaction(transaction =>
        configs.attachAccounts(models, anchors, transaction)
      );
      expect(attached.map(anchor => [anchor.id, anchor.accountNumber])).toEqual([
        [`${combined.id}:0`, '001'],
        [`${combined.id}:1`, '002'],
      ]);
      const mismatch = { ...anchors[0], fileId: randomUUID() };
      const rejected = await db.transaction(transaction =>
        configs.attachAccounts(models, [mismatch], transaction)
      );
      expect(rejected[0].accountNumber).toBeNull();
    } catch (error) {
      throw new Error('QA_REAL_LEGACY_COMPATIBILITY_FAILED', { cause: error });
    }
  });

  test('真实旧API→独立索引→新Worker→实际Notifier：跨门店同编号只算1且首次计入汇总', async () => {
    try {
      await ingest([...startup('001'), ...startup('002')]);
      await ready();
      const attempts = [
        row('消息20110501', { task: 'A337', offset: 100 }),
        row('尝试预约: Apple 天环广场, 日期', { task: 'A337', offset: 101 }),
        row('商品: iPhone Duo 512GB 星光白色 x 1, RMB 1', { task: 'A337', offset: 102 }),
        row('取货信息: 取货日期待付款完成后确定', { task: 'A337', offset: 103 }),
        row('尝试预约: Apple 珠江新城, 日期', { task: 'A337', offset: 104 }),
        row('商品: iPhone Duo 512GB 星光白色 x 1, RMB 1', { task: 'A337', offset: 105 }),
        row('取货信息: 取货日期待付款完成后确定', { task: 'A337', offset: 106 }),
      ];
      await db.transaction(async transaction => {
        try {
          await configs.ingest(attempts, transaction, models);
          await legacyEnqueue(attempts, transaction);
        } catch (error) {
          throw new Error('QA_LEGACY_API_CHAIN_FAILED', { cause: error });
        }
      });
      const inbox = await models.AosSignalInbox.findAll();
      expect(inbox.filter(event => event.body.kind === 'anchor')).toHaveLength(2);
      expect(inbox.every(event => event.body.accountNumber === undefined)).toBe(true);
      await new AosSignalService(service).tick();
      const first = (await service.rows('InventoryDelivery'))[0];
      expect(first.content).toContain('首次信号｜1次命中');
      expect(first.content).not.toMatch(/｜\d+\/\d+/);
      now = (await models.InventoryRuntime.findByPk('main')).body.aosSignals.until + 1;
      await new AosSignalService(service).tick();
      const summary = (await service.rows('InventoryDelivery')).find(event => !event.aosImmediate);
      expect(summary.content).toContain('3分钟汇总｜2次命中｜2家门店');
      expect(summary.content).toContain('US_12 / 心蓝13｜1/2');
      const send = jest.fn().mockResolvedValue({ status: 'accepted' });
      const result = await new InventoryNotifier(service, send).tick();
      expect(result.status).toBe('accepted');
      expect(send).toHaveBeenCalledTimes(1);
      const content = send.mock.calls[0][1];
      expect(content).toContain('US_12 / 心蓝13｜1/2');
      expect(content).not.toMatch(/https?:|[\r\n]$/);
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(1600);
      const directory = process.env.AOS_RATIO_QA_EVIDENCE_DIR;
      if (directory) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, '旧API到新Worker实际模拟发送.txt'), content);
      }
    } catch (error) {
      throw new Error('QA_FULL_LEGACY_API_SENDER_CHAIN_FAILED', { cause: error });
    }
  });

  /** 仅ratio边界测试构造可信结构信号；旧API真实信封路径由上面的独立用例覆盖。 */
  function trackerFor(hits) {
    let tracker = null;
    const item = {
      ...SCOPE,
      storeCode: 'R577',
      storeName: 'Apple 天环广场',
      source: { key: `${DEVICE}:${INSTANCE}`, server: 'US_12', instance: '心蓝13' },
    };
    for (const hit of hits)
      tracker = ratios.add(
        tracker,
        {
          id: randomUUID(),
          deviceId: DEVICE,
          localId: INSTANCE,
          fileId: FILE,
          byteOffset: hit.offset || 100,
          loggedAt: hit.at,
          accountNumber: hit.account,
        },
        item
      );
    return tracker;
  }

  async function evaluate(tracker) {
    try {
      const result = await db.transaction(transaction =>
        ratios.evaluate(tracker, models, transaction)
      );
      return result.scopes[ratios.scopeKey(SCOPE)].sources[`${DEVICE}:${INSTANCE}`];
    } catch (error) {
      throw new Error('QA_RATIO_EVALUATE_FAILED', { cause: error });
    }
  }

  test('窗内配置集合变化保留真实N但D未知，不借末hit设置删除先前真实参与者', async () => {
    try {
      await ingest([
        ...startup('001'),
        ...startup('002'),
        row('开始下单 iPhone Duo 夜空色 1T(x1)....', { account: '002', at: now - 750, offset: 50 }),
      ]);
      await ready();
      const ratio = await evaluate(
        trackerFor([
          { account: '001', at: now - 1000 },
          { account: '002', at: now - 500 },
        ])
      );
      expect(ratio.numerator).toBe(2);
      expect(ratio.denominator).toBeNull();
    } catch (error) {
      throw new Error('QA_FROZEN_POPULATION_CHANGE_FAILED', { cause: error });
    }
  });

  test('两hit之间仅普通日志注册的新编号也须进入membership时点，不可漏unknown继续精确D', async () => {
    try {
      await ingest([
        ...startup('001'),
        ...startup('002'),
        row('普通无配置状态记录', { account: '099', at: now - 750, offset: 50 }),
      ]);
      await ready();
      const ratio = await evaluate(
        trackerFor([
          { account: '001', at: now - 1000 },
          { account: '002', at: now - 500 },
        ])
      );
      expect(ratio.numerator).toBe(2);
      expect(ratio.denominator).toBeNull();
      expect(ratio.reason).toBeTruthy();
    } catch (error) {
      throw new Error('QA_REGISTRY_TIME_BOUNDARY_FAILED', { cause: error });
    }
  });

  test('任务关联refs超1000而scope不可证明时分子也未知，不展示可能偏小的N', async () => {
    try {
      await ingest(startup());
      await ready();
      const tracker = trackerFor(
        Array.from({ length: 1002 }, (_, index) => ({
          account: '001',
          at: now - 1000,
          offset: 100 + index,
        }))
      );
      const refreshed = ratios.refresh(tracker, { refs: [], overflowCount: 2 });
      const ratio = await evaluate(refreshed);
      expect(ratio.numerator).toBeNull();
      expect(ratio.denominator).toBeNull();
    } catch (error) {
      throw new Error('QA_ASSOCIATION_OVERFLOW_NUMERATOR_FAILED', { cause: error });
    }
  });

  test('parsed但无完整编号头的新startup必须令旧scope分母未知，不能静默沿用旧精确D', async () => {
    try {
      await ingest(startup());
      await ready();
      const malformed = row('开始下单 iPhone Duo 夜空色 1T(x1)....', { at: now - 750, offset: 50 });
      malformed.message = malformed.message.replace('[2][001]', '');
      malformed.accountNumber = null;
      await ingest([malformed]);
      const ratio = await evaluate(trackerFor([{ account: '001', at: now - 500 }]));
      expect(ratio.numerator).toBe(1);
      expect(ratio.denominator).toBeNull();
    } catch (error) {
      throw new Error('QA_PARSED_HEAD_GAP_FAILED', { cause: error });
    }
  });

  /** 使用真实接收契约，文件内偏移唯一，客户端不能传deviceId。 */
  function apiRows(inputs, offset = 1000) {
    return inputs.map((input, index) => {
      const date = new Date(Date.parse(input.loggedAt) + 8 * 3600000).toISOString().slice(0, 10);
      return {
        id: input.id,
        localId: input.localId,
        fileId: input.fileId,
        fileName: `Log${date.replace(/-/g, '')}_qa.txt`,
        businessDate: date,
        loggedAt: input.loggedAt,
        accountNumber: input.accountNumber,
        lineNumber: index + 1,
        partIndex: 0,
        byteOffset: offset + index * 200,
        message: input.message,
        rawBase64: null,
        parseState: 'parsed',
      };
    });
  }

  test('实际monitorLogService.receive的200条batch原子入索引，重复不增；Migration缺失受控拒绝并可原样重试', async () => {
    const monitorLogs = require('../src/services/monitorLogService');
    let renamed = false;
    try {
      const inputs = Array.from({ length: 100 }, (_, index) =>
        String(index + 1).padStart(3, '0')
      ).flatMap(account => startup(account).slice(1));
      const entries = apiRows(inputs);
      await db.query('ALTER TABLE aos_account_registries RENAME TO qa_missing_registry');
      renamed = true;
      await expect(monitorLogs.receive(DEVICE, { entries })).rejects.toMatchObject({
        code: 'FULL_LOG_TEMPORARY',
      });
      expect(await models.MonitorLogEntry.count()).toBe(0);
      await db.query('ALTER TABLE qa_missing_registry RENAME TO aos_account_registries');
      renamed = false;
      expect((await monitorLogs.receive(DEVICE, { entries })).accepted).toHaveLength(200);
      expect(await models.MonitorLogEntry.count()).toBe(200);
      expect(await models.AosAccountRegistry.count()).toBe(100);
      expect(await models.AosAccountConfigEvent.count()).toBe(200);
      await monitorLogs.receive(DEVICE, { entries });
      expect(await models.AosAccountConfigEvent.count()).toBe(200);
      expect(await models.AosSignalInbox.count()).toBe(0);
    } catch (error) {
      throw new Error('QA_REAL_RECEIVE_TRANSACTION_FAILED', { cause: error });
    } finally {
      if (renamed)
        await db.query('ALTER TABLE qa_missing_registry RENAME TO aos_account_registries');
    }
  });

  test.each(['shadow', 'blocks'])(
    '%s真实接收历史signal只建索引，重传不重复也不通知',
    async mode => {
      try {
        const monitorLogs = require('../src/services/monitorLogService');
        await db.query(
          'INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:device,:local,:mode)',
          { replacements: { device: DEVICE, local: INSTANCE, mode } }
        );
        const at = now - 7 * 3600000;
        const entries = apiRows([
          ...startup('001', at),
          row('取货信息: 取货日期待付款完成后确定', { at: at + 3, task: 'A337', offset: 4 }),
        ]);
        await monitorLogs.receive(DEVICE, { entries });
        await monitorLogs.receive(DEVICE, { entries });
        expect(await models.AosAccountRegistry.count()).toBe(1);
        expect(await models.AosAccountConfigEvent.count()).toBe(4);
        expect(await models.AosSignalInbox.count()).toBe(0);
        expect(await models.InventoryDelivery.count()).toBe(0);
      } catch (error) {
        throw new Error('QA_HISTORY_RECEIVE_MODES_FAILED', { cause: error });
      }
    }
  );

  test.each(['rows', 'blocks'])(
    '%s历史回填可续跑至ready、不发送旧signal，重建对象仍沿持久游标',
    async mode => {
      try {
        const monitorLogs = require('../src/services/monitorLogService');
        const Backfill = require('../src/services/aosAccountBackfill');
        await db.query(
          'INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:device,:local,:mode)',
          { replacements: { device: DEVICE, local: INSTANCE, mode } }
        );
        const at = now - 7 * 3600000;
        const entries = apiRows([
          ...startup('001', at),
          row('取货信息: 取货日期待付款完成后确定', { at: at + 3, task: 'A337', offset: 4 }),
        ]);
        await monitorLogs.receive(DEVICE, { entries });
        await db.query(
          'TRUNCATE aos_account_registries,aos_account_config_events,aos_account_index_states'
        );
        // 升级后的真实接收建立capture水位，不用手造ready绕过回填完整性。
        await monitorLogs.receive(DEVICE, {
          entries: apiRows(
            [
              row('普通运行状态', {
                at: now - 1,
                offset: 5000,
                fileId: '44444444-4444-4444-8444-444444444444',
              }),
            ],
            5000
          ),
        });
        for (let index = 0; index < 20; index++) {
          const state = await models.AosAccountIndexState.findByPk(
            configPolicy.digest([DEVICE, INSTANCE])
          );
          if (state?.status === 'ready') break;
          const result = await new Backfill(models).tick();
          expect(result.failed).not.toBe(true);
          if (result.blocks != null) expect(result.blocks).toBeLessThanOrEqual(1);
          if (result.bytes != null) expect(result.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        }
        const state = await models.AosAccountIndexState.findByPk(
          configPolicy.digest([DEVICE, INSTANCE])
        );
        expect(state.status).toBe('ready');
        expect(await models.AosAccountConfigEvent.count()).toBe(4);
        expect(await models.AosSignalInbox.count()).toBe(0);
        expect(await models.InventoryDelivery.count()).toBe(0);
        const loaded = await read();
        expect(loaded.ready).toBe(true);
        expect(
          configPolicy.population(loaded.registries, loaded.events, SCOPE, now).members
        ).toEqual(['001']);
      } catch (error) {
        throw new Error('QA_BACKFILL_RESUME_NO_HISTORY_SEND_FAILED', { cause: error });
      }
    },
    30000
  );

  test('捕获水位后新文件UUID小于已完成cursor，也由实时索引覆盖而非被永久漏掉', async () => {
    try {
      const monitorLogs = require('../src/services/monitorLogService');
      const Backfill = require('../src/services/aosAccountBackfill');
      await ingest(startup('001'));
      await models.AosAccountIndexState.update(
        {
          status: 'ready',
          body: {
            seeded: true,
            firstDate: new Date(
              Date.parse(new Date(now + 8 * 3600000).toISOString().slice(0, 10)) - 2 * 86400000
            )
              .toISOString()
              .slice(0, 10),
            lastDate: new Date(now + 8 * 3600000).toISOString().slice(0, 10),
            afterFile: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
            captureStartedAt: new Date(now - 10000).toISOString(),
          },
        },
        { where: { deviceId: DEVICE, localId: INSTANCE } }
      );
      const entries = apiRows(
        startup('003').map(input => ({ ...input, fileId: '00000001-0000-4000-8000-000000000001' })),
        6000
      );
      await monitorLogs.receive(DEVICE, { entries });
      const state = await models.AosAccountIndexState.findByPk(
        configPolicy.digest([DEVICE, INSTANCE])
      );
      expect(await new Backfill(models).nextFile(state)).toBeNull();
      const loaded = await read();
      expect(loaded.ready).toBe(true);
      expect(configPolicy.population(loaded.registries, loaded.events, SCOPE, now).members).toEqual(
        ['001', '003']
      );
    } catch (error) {
      throw new Error('QA_LOW_UUID_REALTIME_CAPTURE_FAILED', { cause: error });
    }
  });

  test('短暂停用实例incomplete后复启可重新发现；单实例reset不删除账号/配置或发送通知', async () => {
    try {
      const Backfill = require('../src/services/aosAccountBackfill');
      await ingest(startup());
      active = false;
      await new Backfill(models).tick();
      let state = await models.AosAccountIndexState.findByPk(
        configPolicy.digest([DEVICE, INSTANCE])
      );
      expect(state.status).toBe('incomplete');
      active = true;
      await new Backfill(models).discover();
      state = await state.reload();
      expect(state.status).toBe('pending');
      expect(await models.AosAccountConfigEvent.count()).toBe(3);
      await new Backfill(models).reset(DEVICE, INSTANCE);
      expect(await models.AosAccountRegistry.count()).toBe(1);
      expect(await models.InventoryDelivery.count()).toBe(0);
    } catch (error) {
      throw new Error('QA_INCOMPLETE_REENABLE_RESET_FAILED', { cause: error });
    }
  });

  test('短暂backfill错误按retryAfter退避，之后实际重试可恢复到running', async () => {
    try {
      const Backfill = require('../src/services/aosAccountBackfill');
      const fill = new Backfill(models);
      const realSeed = fill.seed.bind(fill);
      jest
        .spyOn(fill, 'seed')
        .mockImplementation(realSeed)
        .mockRejectedValueOnce(new Error('QA_TEMPORARY_ERROR'));
      expect((await fill.tick()).failed).toBe(true);
      const state = await models.AosAccountIndexState.findByPk(
        configPolicy.digest([DEVICE, INSTANCE])
      );
      expect(state.status).toBe('error');
      expect((await fill.tick()).idle).toBe(true);
      await state.update({ body: { ...state.body, retryAfter: 0 } });
      expect((await fill.tick()).seeded).toBe(0);
      expect((await state.reload()).status).toBe('running');
    } catch (error) {
      throw new Error('QA_BACKFILL_ERROR_RECOVERY_FAILED', { cause: error });
    }
  });

  test.each(['unlock', 'release', 'destroy'])(
    'backfill finally %s异常受控，问题连接不归池且不向Worker传播未处理拒绝',
    async failure => {
      try {
        const Backfill = require('../src/services/aosAccountBackfill');
        const connection = {
          query: jest.fn(sql => {
            if (sql.includes('pg_try_advisory_lock'))
              return Promise.resolve({ rows: [{ locked: true }] });
            if (failure !== 'release') return Promise.reject(new Error('QA_UNLOCK_FAILED'));
            return Promise.resolve({ rows: [] });
          }),
          end: jest.fn().mockResolvedValue(),
        };
        const release = jest.fn().mockRejectedValue(new Error('QA_RELEASE_FAILED'));
        const destroy =
          failure === 'destroy'
            ? jest.fn().mockRejectedValue(new Error('QA_DESTROY_FAILED'))
            : jest.fn().mockResolvedValue();
        const fill = new Backfill({
          ...models,
          sequelize: {
            connectionManager: {
              getConnection: () => Promise.resolve(connection),
              releaseConnection: release,
              pool: { destroy },
            },
          },
        });
        fill.discover = jest.fn().mockResolvedValue();
        await expect(fill.tick()).resolves.toEqual({ idle: true });
        expect(destroy).toHaveBeenCalledWith(connection);
        if (failure === 'release') expect(release).toHaveBeenCalledTimes(1);
        else expect(release).not.toHaveBeenCalled();
        if (failure === 'destroy') expect(connection.end).toHaveBeenCalledTimes(1);
      } catch (error) {
        throw new Error('QA_BACKFILL_FINALLY_SAFETY_FAILED', { cause: error });
      }
    }
  );

  test.each(['rows', 'blocks'])(
    '%s仅回填北京时间最近3自然日：第三日边界包含、第四日payload不读，老编号metadata保留未知，reset仍三日',
    async mode => {
      let spy;
      try {
        const monitorLogs = require('../src/services/monitorLogService');
        const Backfill = require('../src/services/aosAccountBackfill');
        const blockStore = require('../src/services/monitorLogBlockStore');
        await db.query(
          `INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode)
          VALUES(:device,:local,:mode)`,
          { replacements: { device: DEVICE, local: INSTANCE, mode } }
        );
        const lastDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
        const firstDate = new Date(Date.parse(lastDate) - 2 * 86400000).toISOString().slice(0, 10);
        const boundary = Date.parse(`${firstDate}T00:00:00.000+08:00`);
        const oldFile = '00000002-0000-4000-8000-000000000002';
        const history = [
          ...startup('001', boundary),
          ...startup('099', boundary - 4).map(input => ({ ...input, fileId: oldFile })),
        ];
        await monitorLogs.receive(DEVICE, { entries: apiRows(history) });
        await db.query(
          'TRUNCATE aos_account_registries,aos_account_config_events,aos_account_index_states'
        );
        await monitorLogs.receive(DEVICE, {
          entries: apiRows(
            [row('普通运行状态', { at: now - 1, fileId: '44444444-4444-4444-8444-444444444444' })],
            8000
          ),
        });
        const fill = new Backfill(models);
        await fill.tick();
        let state = await models.AosAccountIndexState.findByPk(
          configPolicy.digest([DEVICE, INSTANCE])
        );
        expect(state.body.firstDate).toBe(firstDate);
        expect(state.body.lastDate).toBe(lastDate);
        expect(await fill.nextFile(state)).toBe(FILE);
        spy = jest.spyOn(blockStore, 'readBlock');
        for (let index = 0; index < 20; index++) {
          state = await state.reload();
          if (state.status === 'ready') break;
          expect((await new Backfill(models).tick()).failed).not.toBe(true);
        }
        expect((await state.reload()).status).toBe('ready');
        expect(await models.AosAccountRegistry.count()).toBe(2);
        expect(await models.AosAccountConfigEvent.count({ where: { accountNumber: '001' } })).toBe(
          3
        );
        expect(await models.AosAccountConfigEvent.count({ where: { accountNumber: '099' } })).toBe(
          0
        );
        if (mode === 'blocks') {
          expect(spy).toHaveBeenCalled();
          expect(spy.mock.calls.every(([block]) => String(block.business_date) >= firstDate)).toBe(
            true
          );
        }
        const loaded = await read();
        const pop = configPolicy.population(loaded.registries, loaded.events, SCOPE, now);
        expect(pop.members).toEqual(['001']);
        expect(pop.unknownAccounts).toEqual(['099']);
        expect(pop.complete).toBe(false);
        expect(await models.AosSignalInbox.count()).toBe(0);
        expect(await models.InventoryDelivery.count()).toBe(0);
        await fill.reset(DEVICE, INSTANCE);
        await fill.tick();
        state = await state.reload();
        expect(state.body.firstDate).toBe(firstDate);
        expect(state.body.lastDate).toBe(lastDate);
        expect(await fill.nextFile(state)).toBe(FILE);
        expect(await models.AosAccountRegistry.count()).toBe(2);
      } catch (error) {
        throw new Error('QA_THREE_DAY_PAYLOAD_BOUNDARY_FAILED', { cause: error });
      } finally {
        spy?.mockRestore();
      }
    },
    30000
  );

  test.each([false, true])(
    '三日内日期丢失=%s：窗口外旧日期淘汰/累计expired增长不能误判三日缺口',
    async loseInside => {
      try {
        const Backfill = require('../src/services/aosAccountBackfill');
        await ingest(startup());
        const lastDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
        const firstDate = new Date(Date.parse(lastDate) - 2 * 86400000).toISOString().slice(0, 10);
        const outside = new Date(Date.parse(firstDate) - 86400000).toISOString().slice(0, 10);
        const monitor = await models.MonitorLogState.findOne({
          where: { deviceId: DEVICE, localId: INSTANCE },
        });
        await monitor.update({
          snapshot: { ...monitor.snapshot, dates: [outside, firstDate, lastDate], expired: 0 },
        });
        const fill = new Backfill(models);
        const state = await models.AosAccountIndexState.findByPk(
          configPolicy.digest([DEVICE, INSTANCE])
        );
        const seed = await fill.seed(state);
        expect(seed.initialDates).toEqual([firstDate, lastDate]);
        await fill.save(state, 'running', {
          ...seed,
          afterFile: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          fileId: null,
        });
        await monitor.update({
          snapshot: {
            ...monitor.snapshot,
            dates: loseInside ? [lastDate] : [firstDate, lastDate],
            expired: 99,
          },
        });
        expect((await fill.tick()).completed).toBe(true);
        await state.reload();
        expect(state.status).toBe(loseInside ? 'incomplete' : 'ready');
        expect(state.body.reason).toBe(loseInside ? 'HISTORY_GAP_DURING_BACKFILL' : null);
      } catch (error) {
        throw new Error('QA_SCOPED_RETENTION_GAP_FAILED', { cause: error });
      }
    }
  );

  test('跨北京时间午夜续跑沿用固定三日范围，显式reset后才重取当日三日，不回退全史', async () => {
    let clock;
    try {
      const monitorLogs = require('../src/services/monitorLogService');
      const Backfill = require('../src/services/aosAccountBackfill');
      const lastDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const firstDate = new Date(Date.parse(lastDate) - 2 * 86400000).toISOString().slice(0, 10);
      const boundary = Date.parse(`${firstDate}T00:00:00.000+08:00`);
      const currentFile = '44444444-4444-4444-8444-444444444444';
      await monitorLogs.receive(DEVICE, { entries: apiRows(startup('001', boundary)) });
      await monitorLogs.receive(DEVICE, {
        entries: apiRows([row('普通运行状态', { at: now - 1, fileId: currentFile })], 9000),
      });
      const fill = new Backfill(models);
      const state = await models.AosAccountIndexState.findByPk(
        configPolicy.digest([DEVICE, INSTANCE])
      );
      const seed = await fill.seed(state);
      await fill.save(state, 'running', { ...seed, afterFile: null });
      clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.parse(`${lastDate}T23:59:59.999+08:00`) + 2);
      expect(await fill.nextFile(state)).toBe(FILE);
      expect(state.body.firstDate).toBe(firstDate);
      await fill.reset(DEVICE, INSTANCE);
      await state.reload();
      const reseed = await fill.seed(state);
      await fill.save(state, 'running', reseed);
      expect(state.body.firstDate).toBe(
        new Date(Date.parse(firstDate) + 86400000).toISOString().slice(0, 10)
      );
      expect(await fill.nextFile(state)).toBe(currentFile);
      expect(await models.AosAccountRegistry.count()).toBe(1);
    } catch (error) {
      throw new Error('QA_FIXED_RANGE_MIDNIGHT_RESET_FAILED', { cause: error });
    } finally {
      clock?.mockRestore();
    }
  });

  /** 将真实旧API信封送入Worker；这里不人为给anchor填accountNumber。 */
  async function legacyAttempt(account, task, baseOffset) {
    try {
      const rows = [
        row('消息20110501', { account, task, offset: baseOffset }),
        row('尝试预约: Apple 天环广场, 日期', { account, task, offset: baseOffset + 1 }),
        row('商品: iPhone Duo 512GB 星光白色 x 1, RMB 1', {
          account,
          task,
          offset: baseOffset + 2,
        }),
        row('取货信息: 取货日期待付款完成后确定', { account, task, offset: baseOffset + 3 }),
      ];
      await db.transaction(async transaction => {
        try {
          await configs.ingest(rows, transaction, models);
          await legacyEnqueue(rows, transaction);
        } catch (error) {
          throw new Error('QA_LEGACY_WINDOW_FEED_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('QA_LEGACY_WINDOW_ATTEMPT_FAILED', { cause: error });
    }
  }

  test('旧活动窗口已有raw命中无tracker，新增hit后不可只算新N；raw含首次保持，比例均未知', async () => {
    try {
      await ingest([...startup('001'), ...startup('002')]);
      await ready();
      await legacyAttempt('001', 'A337', 100);
      // 先按旧模型能力消费，产生真实groups/association但没有比例tracker的活动窗口。
      const previous = new InventoryService({ ...models, AosAccountRegistry: undefined });
      const locked = previous.locked.bind(previous);
      previous.locked = work => locked(context => work({ ...context, now }));
      await new AosSignalService(previous).tick();
      let state = (await models.InventoryRuntime.findByPk('main')).body.aosSignals;
      expect(state.association.refs).toHaveLength(1);
      expect(state.accountTracker).toBeUndefined();
      await legacyAttempt('002', 'A338', 200);
      await new AosSignalService(service).tick();
      state = (await models.InventoryRuntime.findByPk('main')).body.aosSignals;
      expect(Object.values(state.groups).reduce((sum, group) => sum + group.count, 0)).toBe(2);
      now = state.until + 1;
      await new AosSignalService(service).tick();
      const summary = (await service.rows('InventoryDelivery')).find(event => !event.aosImmediate);
      expect(summary.content).toContain('3分钟汇总｜2次命中');
      expect(summary.content).toContain('US_12 / 心蓝13｜—/—');
      const ratio =
        summary.aosAccountRatio.scopes[ratios.scopeKey(SCOPE)].sources[`${DEVICE}:${INSTANCE}`];
      expect(ratio.numerator).toBeNull();
      expect(ratio.denominator).toBeNull();
      expect(ratio.reason).toBe('LEGACY_WINDOW_WITHOUT_ACCOUNT_TRACKER');
    } catch (error) {
      throw new Error('QA_ACTIVE_LEGACY_WINDOW_FAILED', { cause: error });
    }
  });

  test('正常后续空窗口无tracker并非历史缺失，新hit仍可计算精确1/2', async () => {
    try {
      await ingest([...startup('001'), ...startup('002')]);
      await ready();
      await models.InventoryRuntime.update(
        {
          body: {
            aosSignals: {
              from: now - 1000,
              until: now + 179000,
              groups: {},
            },
          },
        },
        { where: { id: 'main' } }
      );
      await legacyAttempt('001', 'A337', 100);
      await new AosSignalService(service).tick();
      const state = (await models.InventoryRuntime.findByPk('main')).body.aosSignals;
      expect(state.accountTracker.incomplete).toBeUndefined();
      now = state.until + 1;
      await new AosSignalService(service).tick();
      const summary = (await service.rows('InventoryDelivery')).find(event => !event.aosImmediate);
      expect(summary.content).toContain('US_12 / 心蓝13｜1/2');
    } catch (error) {
      throw new Error('QA_EMPTY_CONTINUATION_WINDOW_FAILED', { cause: error });
    }
  });
});
