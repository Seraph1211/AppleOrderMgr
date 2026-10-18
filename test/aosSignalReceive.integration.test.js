const { randomUUID } = require('crypto');
const { Sequelize } = require('sequelize');
const logMigration = require('../migrations/20260929000001-add-monitor-full-logs');
const blockMigration = require('../migrations/20261007000001-add-monitor-log-block-storage');
const repeatMigration = require('../migrations/20261007000002-add-monitor-log-repeat-limits');
const signalMigration = require('../migrations/20261019000001-create-aos-signal-queue');
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
        'TRUNCATE monitor_log_entries,monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,monitor_log_files,monitor_log_storage_scopes,monitor_log_storage_metrics,aos_signal_inbox RESTART IDENTITY CASCADE'
      );
    } catch (error) {
      throw new Error('日志接收隔离重置失败', { cause: error });
    }
  });
  afterAll(async () => {
    try {
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
      expect(JSON.stringify(inbox.body)).not.toMatch(/013|A77|取货信息/);
      await models.AosSignalInbox.destroy({ where: {} });
      await receive(deviceId, { entries: [row] });
      expect(await models.AosSignalInbox.count()).toBe(0);
      expect(await models.MonitorLogEntry.count()).toBe(mode === 'blocks' ? 0 : 1);
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
    await models.AosSignalInbox.create({ id: 'expired-synthetic', body: {}, createdAt: new Date(Date.now() - 180100) });
    const row = entry(10);
    await receive(deviceId, { entries: [row] });
    expect(await models.AosSignalInbox.findByPk('expired-synthetic')).toBeNull();
    expect(await models.AosSignalInbox.findByPk(row.id)).not.toBeNull();
  });
});
