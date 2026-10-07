const { randomUUID, createHash } = require('crypto');
const enabled = process.env.RUN_LOG_FINALIZE_DB === 'true';
(enabled ? describe : describe.skip)('压缩日志全局收尾与旧表写保护真实数据库', () => {
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
  const finalize = () =>
    parseOptions(['finalize', '--confirm-finalize=yes', '--all-api-upgraded=yes']);
  const entry = (offset, local = localId) => ({
    id: randomUUID(),
    localId: local,
    fileId,
    fileName: `Log${today.replace(/-/g, '')}_001.txt`,
    businessDate: today,
    loggedAt: `${today}T02:00:00.000Z`,
    accountNumber: '001',
    lineNumber: offset + 1,
    partIndex: 0,
    byteOffset: offset,
    message: `收尾 ${offset} 中文日志 `.repeat(12),
    rawBase64: null,
    parseState: 'parsed',
    contextAt: null,
  });
  beforeAll(async () => {
    try {
      if (sequelize.config.database !== 'aos_log_test_cli_finalize' || process.env.DATABASE_URL)
        throw new Error('全局收尾只允许专用可清空隔离库');
      await sequelize.query(`TRUNCATE monitor_log_receipts,monitor_log_block_accounts,
        monitor_log_blocks,monitor_log_files,monitor_log_entries,monitor_log_storage_scopes,
        monitor_log_storage_metrics,aos_devices CASCADE`);
      await AosDevice.create({
        id: deviceId,
        name: 'CLI收尾隔离测试',
        credentialHash: createHash('sha256').update(randomUUID()).digest('hex'),
      });
    } catch (error) {
      throw new Error(`收尾准备失败:${error.message}`);
    }
  });
  afterAll(async () => {
    try {
      await sequelize.close();
    } catch (error) {
      throw new Error(`收尾连接释放失败:${error.name}`);
    }
  });
  test('finalize释放空旧表，压实跳过恢复维护，旧副本回收后重认证和恢复仍完整', async () => {
    try {
      const rows = Array.from({ length: 600 }, (_, index) => entry(index));
      for (let start = 0; start < rows.length; start += 200)
        await service.receive(deviceId, { entries: rows.slice(start, start + 200) });
      await expect(migration.run(finalize())).rejects.toThrow('旧表仍有片段');
      await sequelize.query(`INSERT INTO monitor_log_storage_metrics(name,value)
        VALUES('storage-default','{"mode":"blocks"}'::jsonb)`);
      expect(await store.mode(deviceId, localId)).toBe('rows');
      await sequelize.query("DELETE FROM monitor_log_storage_metrics WHERE name='storage-default'");
      await migration.run(input('shadow'));
      expect((await migration.run({ ...input('backfill'), batchSize: 100 })).complete).toBe(true);
      expect((await migration.run(input('verify'))).complete).toBe(true);
      expect((await migration.run(input('read-switch'))).mode).toBe('blocks');
      const retire = parseOptions([
        'retire',
        `--device=${deviceId}`,
        `--instance=${localId}`,
        `--first=${today}`,
        `--last=${today}`,
        '--confirm-retire=yes',
      ]);
      expect((await migration.run(retire)).processed).toBe(600);
      const result = await migration.run(finalize());
      expect(result.finalized).toBe(true);
      expect(BigInt(result.releasedBytes)).toBeGreaterThan(0n);
      const newLocal = randomUUID();
      const newRows = Array.from({ length: 8 }, (_, index) => entry(1000 + index, newLocal));
      const fresh = newRows[0];
      for (const row of newRows) await service.receive(deviceId, { entries: [row] });
      expect(await store.mode(deviceId, newLocal)).toBe('blocks');
      expect(await MonitorLogEntry.findByPk(fresh.id)).toBeNull();
      expect((await store.findById(fresh.id)).message).toBe(fresh.message);
      const stale = policy.entry(entry(1001, randomUUID()));
      await expect(
        MonitorLogEntry.create({
          ...stale,
          deviceId,
          sortAt: stale.loggedAt,
          payloadHash: policy.digest(stale),
        })
      ).rejects.toMatchObject({ original: { code: '55000' } });
      const { compact } = require('../src/services/monitorLogBlockCompactor');
      const nextDay = new Date(new Date(`${today}T00:00:00Z`).getTime() + 86400000)
        .toISOString()
        .slice(0, 10);
      const newOptions = command =>
        parseOptions([command, `--device=${deviceId}`, `--instance=${newLocal}`]);
      const blocksFor = async scope => {
        try {
          const [[value]] = await sequelize.query(
            'SELECT count(*)::integer AS count FROM monitor_log_blocks WHERE device_id=:deviceId AND local_id=:localId',
            { replacements: { deviceId, localId: scope } }
          );
          return value.count;
        } catch (error) {
          throw new Error(`压实块计数失败:${error.name}`);
        }
      };
      const initialBlocks = await blocksFor(localId);
      const newBlocks = await blocksFor(newLocal);
      const recovering = await migration.run({
        ...newOptions('revert'),
        batchSize: 1,
        maxBatches: 1,
      });
      expect(recovering).toMatchObject({ mode: 'blocks', complete: false });
      await compact({
        today: nextDay,
        maxBatches: 20,
        budgetMs: 10000,
        maxRows: 1000,
        maxSourceBlocks: 64,
      });
      expect(await blocksFor(localId)).toBeLessThan(initialBlocks);
      expect(await blocksFor(newLocal)).toBe(newBlocks);
      expect((await migration.run(input('status'))).progress.switchedComplete).toBeUndefined();
      expect((await migration.run(input('verify'))).complete).toBe(true);
      const reverified = await migration.run(input('status'));
      expect(reverified.progress.switchedGeneration).toBe(reverified.generation);
      await migration.run(newOptions('abort-maintenance'));
      await compact({
        today: nextDay,
        maxBatches: 20,
        budgetMs: 10000,
        maxRows: 1000,
        maxSourceBlocks: 64,
      });
      expect(await blocksFor(newLocal)).toBeLessThan(newBlocks);
      expect((await migration.run(newOptions('verify'))).complete).toBe(true);
      expect((await migration.run(input('revert'))).mode).toBe('rows');
      expect(await MonitorLogEntry.count({ where: { deviceId, localId } })).toBe(600);
      const rollback = parseOptions(['rollback-default', '--confirm-default-rollback=yes']);
      await expect(migration.run(rollback)).rejects.toThrow('仍有块');
      const newRevert = parseOptions(['revert', `--device=${deviceId}`, `--instance=${newLocal}`]);
      expect((await migration.run(newRevert)).mode).toBe('rows');
      for (const row of [...rows, ...newRows]) {
        const restored = await MonitorLogEntry.findByPk(row.id);
        expect(restored.message).toBe(row.message);
        expect(restored.payloadHash).toBe(policy.digest(policy.entry(row)));
      }
      expect((await migration.run(rollback)).defaultRolledBack).toBe(true);
      const legacyFresh = entry(2000, randomUUID());
      await service.receive(deviceId, { entries: [legacyFresh] });
      expect((await MonitorLogEntry.findByPk(legacyFresh.id)).message).toBe(legacyFresh.message);
      expect(await store.mode(deviceId, legacyFresh.localId)).toBe('rows');
      const [[setting]] = await sequelize.query(
        "SELECT current_setting('apple.monitor_log_restore',true) AS value"
      );
      expect(setting.value).not.toBe('verified');
      process.stdout.write(
        `${JSON.stringify({
          gate: 'finalize-isolated',
          oldBytesBefore: result.oldBytesBefore,
          oldBytesAfter: result.oldBytesAfter,
          releasedBytes: result.releasedBytes,
          restored: 600,
          restoredNew: newRows.length,
          compactInitialBefore: initialBlocks,
          compactInitialAfter: await blocksFor(localId),
          compactNewBefore: newBlocks,
          compactNewAfter: await blocksFor(newLocal),
        })}\n`
      );
    } catch (error) {
      throw new Error(`全局收尾演练失败:${error.message}`);
    }
  });
});
