const { randomUUID, createHash } = require('crypto');
const enabled = process.env.RUN_FULL_LOG_DB === 'true';
(enabled ? describe : describe.skip)('压缩日志CLI真实PostgreSQL迁移与恢复', () => {
  const { sequelize, AosDevice, MonitorLogEntry } = require('../src/models');
  const service = require('../src/services/monitorLogService');
  const store = require('../src/services/monitorLogBlockStore');
  const { createMigration, parseOptions } = require('../scripts/monitorLogStorageMigration');
  const policy = require('../src/services/monitorLogPolicy');
  const migration = createMigration({ sequelize, store });
  const deviceId = randomUUID();
  const localId = randomUUID();
  const fileId = randomUUID();
  const today = policy.retention().today;
  const input = command => parseOptions([command, `--device=${deviceId}`, `--instance=${localId}`]);
  const entry = offset => ({
    id: randomUUID(),
    localId,
    fileId,
    fileName: `Log${today.replace(/-/g, '')}_001.txt`,
    businessDate: today,
    loggedAt: `${today}T02:00:00.000Z`,
    accountNumber: '001',
    lineNumber: offset + 1,
    partIndex: 0,
    byteOffset: offset,
    message: `日志 ${offset} 中文 %_\\\n`,
    rawBase64: null,
    parseState: 'parsed',
    contextAt: null,
  });
  beforeAll(async () => {
    try {
      if (!/^aos_log_test_/.test(sequelize.config.database) || process.env.DATABASE_URL)
        throw new Error('必须使用完整日志专用隔离测试库');
      await AosDevice.create({
        id: deviceId,
        name: 'CLI隔离测试',
        credentialHash: createHash('sha256').update(randomUUID()).digest('hex'),
      });
    } catch (error) {
      throw new Error(`CLI准备失败:${error.name}`);
    }
  });
  afterAll(async () => {
    try {
      await sequelize.close();
    } catch (error) {
      throw new Error(`CLI连接释放失败:${error.name}`);
    }
  });
  test('shadow切换等待已持设备锁的历史事务，createdAt旧值不漏迁移', async () => {
    const transaction = await sequelize.transaction();
    const lateLocalId = randomUUID();
    const lateOptions = command =>
      parseOptions([command, `--device=${deviceId}`, `--instance=${lateLocalId}`]);
    let pending;
    try {
      await AosDevice.findByPk(deviceId, { transaction, lock: transaction.LOCK.UPDATE });
      const item = { ...entry(100), localId: lateLocalId };
      const normalized = policy.entry(item);
      await MonitorLogEntry.create(
        {
          ...normalized,
          deviceId,
          payloadHash: policy.digest(normalized),
          sortAt: normalized.loggedAt,
          createdAt: `${today}T00:00:00.000Z`,
        },
        { transaction }
      );
      let finished = false;
      pending = migration.run(lateOptions('shadow')).then(value => {
        finished = true;
        return value;
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(finished).toBe(false);
      await transaction.commit();
      expect((await pending).mode).toBe('shadow');
      expect((await migration.run(lateOptions('backfill'))).processed).toBe(1);
      expect((await store.findById(item.id)).message).toBe(item.message);
    } catch (error) {
      if (!transaction.finished) await transaction.rollback();
      if (pending) await pending.catch(() => undefined);
      throw new Error(`CLI迟到提交测试失败:${error.message}`);
    }
  });
  test('非零毫秒、乱序及多账号目录在真实PG校验、回收和恢复保持精确', async () => {
    const fractionalLocal = randomUUID();
    const fractionalOptions = command =>
      parseOptions([command, `--device=${deviceId}`, `--instance=${fractionalLocal}`]);
    try {
      const changes = [
        { ms: '987', accountNumber: '0002' },
        { ms: '123', accountNumber: '001' },
        { ms: '987', accountNumber: '001' },
        { ms: '001', accountNumber: null },
        { ms: '999', accountNumber: '0002' },
      ];
      const rows = changes.map((change, index) => ({
        ...entry(500 + index),
        localId: fractionalLocal,
        loggedAt: `${today}T03:00:00.${change.ms}Z`,
        accountNumber: change.accountNumber,
      }));
      const shuffled = [rows[4], rows[2], rows[0], rows[3], rows[1]];
      await service.receive(deviceId, { entries: shuffled });
      await migration.run(fractionalOptions('shadow'));
      expect(
        (await migration.run({ ...fractionalOptions('backfill'), batchSize: 2 })).complete
      ).toBe(true);
      const [blocks] = await sequelize.query(
        'SELECT * FROM monitor_log_blocks WHERE device_id=:deviceId AND local_id=:localId ORDER BY id',
        { replacements: { deviceId, localId: fractionalLocal } }
      );
      expect(blocks[0].min_sort_at).toBeInstanceOf(Date);
      expect(blocks[0].min_sort_at.getUTCMilliseconds()).toBe(1);
      expect((await migration.run(fractionalOptions('verify'))).complete).toBe(true);
      expect((await migration.run(fractionalOptions('read-switch'))).mode).toBe('blocks');
      const query = {
        deviceId,
        localId: fractionalLocal,
        date: today,
        account: '',
        fromTime: '',
        toTime: '',
        keyword: '',
      };
      const expected = [rows[3], rows[1], rows[0], rows[2], rows[4]].map(row => row.id);
      expect((await store.select(query, null, 'ASC', 100)).map(row => row.id)).toEqual(expected);
      const retire = parseOptions([
        'retire',
        `--device=${deviceId}`,
        `--instance=${fractionalLocal}`,
        `--first=${today}`,
        `--last=${today}`,
        '--confirm-retire=yes',
      ]);
      expect((await migration.run(retire)).processed).toBe(5);
      expect((await migration.run(fractionalOptions('revert'))).mode).toBe('rows');
      for (const row of rows) {
        const restored = await MonitorLogEntry.findByPk(row.id);
        expect(restored.loggedAt.toISOString()).toBe(row.loggedAt);
        expect(restored.accountNumber).toBe(row.accountNumber);
        expect(restored.payloadHash).toBe(policy.digest(policy.entry(row)));
      }
    } catch (error) {
      throw new Error(`CLI毫秒目录回归失败:${error.message}`);
    }
  });
  test('恢复维护跨预算和执行器重启持续，终止维护保留部分旧行并能重新完整恢复', async () => {
    const maintenanceLocal = randomUUID();
    const options = command =>
      parseOptions([command, `--device=${deviceId}`, `--instance=${maintenanceLocal}`]);
    try {
      const rows = Array.from({ length: 6 }, (_, index) => ({
        ...entry(800 + index),
        localId: maintenanceLocal,
        loggedAt: `${today}T03:00:00.123Z`,
      }));
      await service.receive(deviceId, { entries: rows });
      await migration.run(options('shadow'));
      await migration.run({ ...options('backfill'), batchSize: 1 });
      await migration.run(options('verify'));
      await migration.run(options('read-switch'));
      await migration.run(
        parseOptions([
          'retire',
          `--device=${deviceId}`,
          `--instance=${maintenanceLocal}`,
          `--first=${today}`,
          `--last=${today}`,
          '--confirm-retire=yes',
        ])
      );
      const partial = await migration.run({ ...options('revert'), batchSize: 1, maxBatches: 1 });
      expect(partial).toMatchObject({ mode: 'blocks', complete: false });
      expect(await MonitorLogEntry.count({ where: { deviceId, localId: maintenanceLocal } })).toBe(
        1
      );
      const restarted = createMigration({ sequelize, store });
      expect((await restarted.run(options('status'))).progress.maintenance).toMatchObject({
        kind: 'revert',
      });
      await expect(restarted.run(options('verify'))).rejects.toThrow('恢复维护');
      await expect(
        restarted.run(
          parseOptions([
            'retire',
            `--device=${deviceId}`,
            `--instance=${maintenanceLocal}`,
            `--first=${today}`,
            `--last=${today}`,
            '--confirm-retire=yes',
          ])
        )
      ).rejects.toThrow('恢复维护');
      expect(await restarted.run(options('abort-maintenance'))).toMatchObject({
        mode: 'blocks',
        maintenanceAborted: true,
      });
      const aborted = (await restarted.run(options('status'))).progress;
      expect(aborted.maintenance).toBeUndefined();
      expect(aborted.restoreBlockId).toBeUndefined();
      expect(await MonitorLogEntry.count({ where: { deviceId, localId: maintenanceLocal } })).toBe(
        1
      );
      expect((await createMigration({ sequelize, store }).run(options('revert'))).mode).toBe(
        'rows'
      );
      const completed = (await restarted.run(options('status'))).progress;
      expect(completed.maintenance).toBeUndefined();
      expect(completed.restoredComplete).toBe(true);
      expect(await MonitorLogEntry.count({ where: { deviceId, localId: maintenanceLocal } })).toBe(
        6
      );
      for (const row of rows) {
        const restored = await MonitorLogEntry.findByPk(row.id);
        expect(restored.loggedAt.toISOString()).toBe(row.loggedAt);
        expect(restored.payloadHash).toBe(policy.digest(policy.entry(row)));
      }
    } catch (error) {
      throw new Error(`CLI跨进程维护恢复失败:${error.message}`);
    }
  });
  test('旧行->shadow原子双写->重启补齐->校验->blocks->有界回收->新增->完整回滚', async () => {
    try {
      const original = [entry(0), entry(1)];
      await service.receive(deviceId, { entries: original });
      expect((await migration.run(input('shadow'))).mode).toBe('shadow');
      const during = entry(2);
      await service.receive(deviceId, { entries: [during] });
      const partial = await migration.run({ ...input('backfill'), batchSize: 1, maxBatches: 1 });
      expect(partial.complete).toBe(false);
      await expect(migration.run(input('read-switch'))).rejects.toThrow('尚未完成');
      const resumed = await createMigration({ sequelize, store }).run(input('backfill'));
      expect(resumed.complete).toBe(true);
      expect((await migration.run(input('verify'))).complete).toBe(true);
      expect((await migration.run(input('read-switch'))).mode).toBe('blocks');
      const after = entry(3);
      await service.receive(deviceId, { entries: [after] });
      expect(await MonitorLogEntry.findByPk(after.id)).toBeNull();
      const retire = parseOptions([
        'retire',
        `--device=${deviceId}`,
        `--instance=${localId}`,
        `--first=${today}`,
        `--last=${today}`,
        '--confirm-retire=yes',
      ]);
      expect((await migration.run(retire)).processed).toBe(3);
      expect(await MonitorLogEntry.count({ where: { deviceId, localId } })).toBe(0);
      const reverted = await migration.run(input('revert'));
      expect(reverted.mode).toBe('rows');
      expect(await MonitorLogEntry.count({ where: { deviceId, localId } })).toBe(4);
      for (const item of [...original, during, after]) {
        const restored = await MonitorLogEntry.findByPk(item.id);
        expect(restored.message).toBe(item.message);
        expect(restored.payloadHash).toBe(policy.digest(policy.entry(item)));
      }
      await service.receive(deviceId, { entries: [after] });
      expect(await MonitorLogEntry.count({ where: { deviceId, localId } })).toBe(4);
    } catch (error) {
      throw new Error(`CLI真实迁移演练失败:${error.message}`);
    }
  });
});
