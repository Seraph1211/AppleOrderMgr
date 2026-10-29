const { randomUUID } = require('crypto');
const { Sequelize } = require('sequelize');
const logMigration = require('../migrations/20260929000001-add-monitor-full-logs');
const blockMigration = require('../migrations/20261007000001-add-monitor-log-block-storage');
const repeatMigration = require('../migrations/20261007000002-add-monitor-log-repeat-limits');
const signalMigration = require('../migrations/20261019000001-create-aos-signal-queue');
const accountMigration = require('../migrations/20261026000001-create-aos-account-config-index');
const suite = process.env.AOS_SIGNAL_DATABASE_TEST === '1' ? describe : describe.skip;

suite('AOS日志实际新增事件的行表／压缩块事务入队', () => {
  let db;
  let models;
  let receive;
  const deviceId = randomUUID();
  const localId = randomUUID();
  const fileId = randomUUID();
  function entry(offset, extra = {}) {
    const loggedAt = new Date(Date.now() - 1000).toISOString();
    const date = new Date(Date.parse(loggedAt) + 8 * 3600000).toISOString().slice(0, 10);
    return {
      id: randomUUID(),
      localId,
      fileId,
      fileName: `Log${date.replace(/-/g, '')}_signal.txt`,
      businessDate: date,
      loggedAt,
      accountNumber: '013',
      lineNumber: offset + 1,
      partIndex: 0,
      byteOffset: offset,
      message: '2026-10-19 08:00:00.000 [2][013]A77-取货信息: 取货日期待付款完成后确定\r\n',
      rawBase64: null,
      parseState: 'parsed',
      ...extra,
    };
  }
  beforeAll(async () => {
    try {
      if (process.env.DB_HOST !== 'postgres' || process.env.DB_NAME !== 'apple_inventory_dev')
        throw new Error('ISOLATED_COMPOSE_REQUIRED');
      db = new Sequelize('test_aos_signal_receive', process.env.DB_USER, process.env.DB_PASSWORD, {
        host: 'postgres',
        dialect: 'postgres',
        logging: false,
      });
      models = { sequelize: db };
      for (const name of [
        'AosDevice',
        'MonitorLogEntry',
        'MonitorLogState',
        'AosSignalInbox',
        'AosSignalContext',
        'AosAccountRegistry',
        'AosAccountConfigEvent',
        'AosAccountIndexState',
      ])
        models[name] = require(`../src/models/${name}`)(db);
      const attributes = Object.fromEntries(
        Object.entries(models.AosDevice.getAttributes()).map(([key, value]) => [
          value.field || key,
          value,
        ])
      );
      await db.getQueryInterface().createTable('aos_devices', attributes);
      await logMigration.up(db.getQueryInterface(), Sequelize);
      await blockMigration.up(db.getQueryInterface(), Sequelize);
      await repeatMigration.up(db.getQueryInterface(), Sequelize);
      await signalMigration.up(db.getQueryInterface(), Sequelize);
      await accountMigration.up(db.getQueryInterface(), Sequelize);
      await models.AosDevice.create({
        id: deviceId,
        name: 'US Server No.9',
        credentialHash: 'synthetic',
      });
      jest.doMock('../src/models', () => models);
      receive = require('../src/services/monitorLogService').receive;
    } catch (error) {
      throw new Error('日志接收隔离初始化失败', { cause: error });
    }
  });
  beforeEach(async () => {
    try {
      await db.query(
        'TRUNCATE monitor_log_states,monitor_log_entries,monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,monitor_log_files,monitor_log_storage_scopes,monitor_log_storage_metrics,aos_signal_inbox,aos_account_config_events,aos_account_registries,aos_account_index_states RESTART IDENTITY CASCADE'
      );
    } catch (error) {
      throw new Error('日志接收隔离重置失败', { cause: error });
    }
  });
  afterAll(async () => {
    try {
      await accountMigration.down(db.getQueryInterface());
      await signalMigration.down(db.getQueryInterface());
      await repeatMigration.down(db.getQueryInterface());
      await blockMigration.down(db.getQueryInterface());
      await logMigration.down(db.getQueryInterface());
      await db.getQueryInterface().dropTable('aos_devices');
    } finally {
      await db?.close();
    }
  });
  test.each(['rows', 'shadow', 'blocks'])(
    '%s实际新增才入队，消费后重复上传仍不会重新入队',
    async mode => {
      await db.query(
        'INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:deviceId,:localId,:mode)',
        { replacements: { deviceId, localId, mode } }
      );
      const row = entry(1);
      expect((await receive(deviceId, { entries: [row, row] })).accepted).toEqual([row.id, row.id]);
      expect(await models.AosSignalInbox.count()).toBe(1);
      const inbox = await models.AosSignalInbox.findByPk(row.id);
      expect(inbox.body).toMatchObject({ deviceId, localId, kind: 'anchor' });
      // UUID和摘要可能随机包含账号的数字片段，按结构白名单验证脱敏边界。
      expect(Object.keys(inbox.body).sort()).toEqual(
        [
          'kind',
          'fileId',
          'localId',
          'taskKey',
          'deviceId',
          'loggedAt',
          'byteOffset',
          'receivedAt',
          'accountNumber',
        ].sort()
      );
      await models.AosSignalInbox.destroy({ where: {} });
      await receive(deviceId, { entries: [row] });
      expect(await models.AosSignalInbox.count()).toBe(0);
      expect(await models.MonitorLogEntry.count()).toBe(mode === 'blocks' ? 0 : 1);
    }
  );
  test.each(['rows', 'shadow', 'blocks'])(
    '%s独立有货事件无需提交也入队，重传不重计',
    async mode => {
      await db.query(
        'INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:deviceId,:localId,:mode)',
        { replacements: { deviceId, localId, mode } }
      );
      const row = entry(11, {
        message: '2026-10-19 08:00:00.000 [2][013]A77-消息20110501\r\n',
      });
      await receive(deviceId, { entries: [row, row] });
      expect(await models.AosSignalInbox.count()).toBe(1);
      expect((await models.AosSignalInbox.findByPk(row.id)).body).toMatchObject({
        deviceId,
        localId,
        kind: 'stock',
        accountNumber: '013',
      });
      await models.AosSignalInbox.destroy({ where: {} });
      await receive(deviceId, { entries: [row] });
      expect(await models.AosSignalInbox.count()).toBe(0);
    }
  );
  test('队列存储失败会回滚原始日志及块回执，重试正常一次入队', async () => {
    await db.query(
      "INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:deviceId,:localId,'blocks')",
      { replacements: { deviceId, localId } }
    );
    const row = entry(2);
    const failure = jest
      .spyOn(models.AosSignalInbox, 'bulkCreate')
      .mockRejectedValueOnce(new Error('synthetic'));
    await expect(receive(deviceId, { entries: [row] })).rejects.toMatchObject({ statusCode: 503 });
    failure.mockRestore();
    expect(
      (await db.query('SELECT count(*)::int AS count FROM monitor_log_receipts'))[0][0].count
    ).toBe(0);
    await receive(deviceId, { entries: [row] });
    expect(await models.AosSignalInbox.count()).toBe(1);
  });
  test('历史补传仍完整入日志但不入提醒队列，载荷冲突整批回滚', async () => {
    const old = entry(3, { loggedAt: new Date(Date.now() - 180001).toISOString() });
    await receive(deviceId, { entries: [old] });
    expect(await models.MonitorLogEntry.count()).toBe(1);
    expect(await models.AosSignalInbox.count()).toBe(0);
    const newRow = entry(4);
    await expect(
      receive(deviceId, { entries: [newRow, { ...old, message: 'changed' }] })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await models.MonitorLogEntry.count()).toBe(1);
    expect(await models.AosSignalInbox.count()).toBe(0);
  });

  test('Worker未运行时，接收端有界清理过期脱敏队列并保留新事件', async () => {
    await models.AosSignalInbox.create({
      id: 'expired-synthetic',
      body: {},
      createdAt: new Date(Date.now() - 180100),
    });
    const row = entry(10);
    await receive(deviceId, { entries: [row] });
    expect(await models.AosSignalInbox.findByPk('expired-synthetic')).toBeNull();
    expect(await models.AosSignalInbox.findByPk(row.id)).not.toBeNull();
  });
  test('真实接收历史启动设置仅建索引，旧anchor不因backfill重发，重复batch不反复写registry', async () => {
    const loggedAt = new Date(Date.now() - 600000).toISOString();
    const clock = new Date(Date.parse(loggedAt) + 8 * 3600000)
      .toISOString()
      .slice(0, 23)
      .replace('T', ' ');
    const row = entry(500, {
      loggedAt,
      accountNumber: '001',
      message: `${clock} [2][001]开始下单 iPhone Duo 星光白色 512G(x1)....`,
    });
    await receive(deviceId, { entries: [row] });
    const registry = (await models.AosAccountRegistry.findAll())[0];
    expect(registry.accountNumber).toBe('001');
    expect(await models.AosAccountConfigEvent.count()).toBe(1);
    expect(await models.AosSignalInbox.count()).toBe(0);
    const updatedAt = registry.updatedAt;
    await receive(deviceId, { entries: [row] });
    expect((await registry.reload()).updatedAt).toEqual(updatedAt);
    expect(await models.AosAccountConfigEvent.count()).toBe(1);
  });

  test('独立设置索引故障回滚实际日志与通知队列，重试能完整恢复', async () => {
    const row = entry(700);
    const failure = jest
      .spyOn(models.AosAccountConfigEvent, 'bulkCreate')
      .mockRejectedValueOnce(new Error('synthetic index failure'));
    await expect(receive(deviceId, { entries: [row] })).rejects.toMatchObject({ statusCode: 503 });
    failure.mockRestore();
    expect(await models.MonitorLogEntry.count()).toBe(0);
    expect(await models.AosSignalInbox.count()).toBe(0);
    expect(await models.AosAccountRegistry.count()).toBe(0);
    await receive(deviceId, { entries: [row] });
    expect(await models.AosAccountConfigEvent.count()).toBe(1);
    expect(await models.AosSignalInbox.count()).toBe(1);
  });
  test('全重复已验证日志batch也建立新API捕获水位，且不重入信号队列', async () => {
    const row = entry(800);
    await receive(deviceId, { entries: [row] });
    await models.AosAccountIndexState.destroy({ where: {}, truncate: true });
    await receive(deviceId, { entries: [row] });
    const state = (await models.AosAccountIndexState.findAll())[0];
    expect(Number.isFinite(Date.parse(state.body.captureStartedAt))).toBe(true);
    expect(state.status).toBe('pending');
    expect(await models.MonitorLogEntry.count()).toBe(1);
    expect(await models.AosSignalInbox.count()).toBe(1);
  });

  test('新普通无账号行也证明捕获已启用，不依赖parser识别账号或缺口', async () => {
    const row = entry(900, {
      loggedAt: null,
      accountNumber: null,
      message: '普通采集进度',
      parseState: 'unparsed',
    });
    await receive(deviceId, { entries: [row] });
    expect((await models.AosAccountIndexState.findAll())[0].body.captureStartedAt).toBeTruthy();
    expect(await models.AosAccountRegistry.count()).toBe(0);
    expect(await models.AosAccountConfigEvent.count()).toBe(0);
  });

  function report() {
    const observedAt = new Date().toISOString();
    return {
      observedAt,
      instances: [
        {
          localId,
          label: '合成实例',
          state: 'ready',
          dates: [new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)],
          fileCount: 1,
          totalBytes: 0,
          scannedBytes: 0,
          pending: 0,
          issues: 0,
          expired: 0,
        },
      ],
    };
  }

  test('真实采集状态报告仅写一次服务器捕获边界，不将回填状态伪作ready', async () => {
    const receiveStates = require('../src/services/monitorLogService').receiveStates;
    const body = report();
    await receiveStates(deviceId, body);
    const state = (await models.AosAccountIndexState.findAll())[0];
    expect(state.status).toBe('pending');
    expect(Date.parse(state.body.captureStartedAt)).toBeGreaterThanOrEqual(
      Date.parse(body.observedAt)
    );
    const before = state.toJSON();
    await receiveStates(deviceId, body);
    expect((await state.reload()).body.captureStartedAt).toBe(before.body.captureStartedAt);
    expect(state.updatedAt).toEqual(before.updatedAt);
    expect(await models.AosAccountConfigEvent.count()).toBe(0);
  });

  test('状态报告事务失败时捕获边界回滚，非法空日志batch也不写边界', async () => {
    const receiveStates = require('../src/services/monitorLogService').receiveStates;
    const failure = jest
      .spyOn(models.MonitorLogState, 'create')
      .mockRejectedValueOnce(new Error('synthetic state failure'));
    await expect(receiveStates(deviceId, report())).rejects.toMatchObject({ statusCode: 503 });
    failure.mockRestore();
    expect(await models.AosAccountIndexState.count()).toBe(0);
    await expect(receive(deviceId, { entries: [] })).rejects.toMatchObject({ statusCode: 400 });
    expect(await models.AosAccountIndexState.count()).toBe(0);
  });
});
