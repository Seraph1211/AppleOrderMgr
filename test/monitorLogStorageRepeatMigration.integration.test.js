const enabled = process.env.RUN_LOG_REPEAT_CLI_DB === 'true';
const { randomUUID, createHash } = require('crypto');
(enabled ? describe : describe.skip)('周期辅助元数据正式迁移和CLI独立PostgreSQL回归', () => {
  const { sequelize, AosDevice, MonitorLogEntry, MonitorLogBlock } = require('../src/models');
  const service = require('../src/services/monitorLogService');
  const store = require('../src/services/monitorLogBlockStore');
  const policy = require('../src/services/monitorLogPolicy');
  const { compact } = require('../src/services/monitorLogBlockCompactor');
  const auxiliary = require('../migrations/20261007000002-add-monitor-log-repeat-limits');
  const { createMigration, parseOptions } = require('../scripts/monitorLogStorageMigration');
  const migration = createMigration({ sequelize, store });
  const deviceId = randomUUID();
  const localId = randomUUID();
  const fileId = randomUUID();
  const today = policy.retention().today;
  const options = command =>
    parseOptions([command, `--device=${deviceId}`, `--instance=${localId}`]);
  function messageFor(index) {
    if (index === 24)
      return Array.from({ length: 257 }, (_, key) =>
        String.fromCodePoint(0x400 + key).repeat(4)
      ).join('|');
    if (index % 2) return `普通 ${index} 中文🙂`;
    return `日志 ${index}:` + '🙂ab'.repeat(8);
  }
  const entry = index => ({
    id: randomUUID(),
    localId,
    fileId,
    fileName: `Log${today.replace(/-/g, '')}_repeat.txt`,
    businessDate: today,
    loggedAt: `${today}T02:00:00.123Z`,
    accountNumber: index % 2 ? '001' : null,
    lineNumber: index + 1,
    partIndex: 0,
    byteOffset: index * 2000000,
    message: messageFor(index),
    rawBase64: null,
    parseState: 'parsed',
    contextAt: null,
  });
  const rows = Array.from({ length: 25 }, (_, index) => entry(index));
  async function query(sql, replacements = {}) {
    try {
      const [result] = await sequelize.query(sql, { replacements });
      return result;
    } catch (error) {
      throw new Error(`周期测试SQL失败:${error.name}:${error.original?.code || ''}`);
    }
  }
  async function businessSnapshot() {
    try {
      return {
        blocks:
          await query(`SELECT id,business_date,device_id,local_id,file_key,file_name,format_version,codec,
        encode(payload,'hex') AS payload,encode(payload_hash,'hex') AS hash,signature,entry_count,raw_bytes,
        min_sort_at,min_file_id,min_byte_offset,max_sort_at,max_file_id,max_byte_offset,created_at FROM monitor_log_blocks ORDER BY id`),
        receipts: await query(
          `SELECT id,file_key,byte_offset,encode(payload_hash,'hex') AS hash,business_date,block_id,ordinal
          FROM monitor_log_receipts ORDER BY id`
        ),
        old: (await MonitorLogEntry.findAll({ order: [['id', 'ASC']] })).map(row => row.toJSON()),
      };
    } catch (error) {
      throw new Error(`周期业务快照失败:${error.name}`);
    }
  }
  beforeAll(async () => {
    try {
      if (sequelize.config.database !== 'aos_log_test_repeat_cli' || process.env.DATABASE_URL)
        throw new Error('周期CLI仅允许独立合成空库');
      await query(
        'TRUNCATE monitor_log_receipts,monitor_log_block_accounts,monitor_log_blocks,monitor_log_files,monitor_log_entries,monitor_log_storage_scopes,monitor_log_storage_metrics,aos_devices CASCADE'
      );
      const columns = await sequelize.getQueryInterface().describeTable('monitor_log_blocks');
      if (!columns.repeat_limits) await auxiliary.up(sequelize.getQueryInterface());
      await AosDevice.create({
        id: deviceId,
        name: '周期CLI合成验收',
        credentialHash: createHash('sha256').update(randomUUID()).digest('hex'),
      });
      await service.receive(deviceId, { entries: rows });
      await migration.run(options('shadow'));
      await migration.run({ ...options('backfill'), batchSize: 1, maxBatches: 40 });
    } catch (error) {
      throw new Error(`周期CLI准备失败:${error.name}:${error.message}`);
    }
  }, 30000);
  afterAll(async () => {
    try {
      await sequelize.close();
    } catch (error) {
      throw new Error(error.name);
    }
  });
  test('up/down/up是仅辅助catalog变更，原载荷/摘要/回执/旧行全字段不变', async () => {
    try {
      const before = await businessSnapshot();
      const nodes = () =>
        query(
          "SELECT oid,relfilenode FROM pg_class WHERE relname LIKE 'monitor_log_blocks_%' ORDER BY oid"
        );
      const files = await nodes();
      await auxiliary.down(sequelize.getQueryInterface());
      expect(
        (await sequelize.getQueryInterface().describeTable('monitor_log_blocks')).repeat_limits
      ).toBeUndefined();
      expect(await businessSnapshot()).toEqual(before);
      expect((await migration.run(options('verify'))).complete).toBe(true);
      await auxiliary.up(sequelize.getQueryInterface());
      const column = (await sequelize.getQueryInterface().describeTable('monitor_log_blocks'))
        .repeat_limits;
      expect(column.allowNull).toBe(true);
      expect(column.defaultValue).toBeNull();
      expect(await nodes()).toEqual(files);
      expect(await businessSnapshot()).toEqual(before);
      expect(await MonitorLogBlock.count()).toBe(25);
      expect(MonitorLogBlock.rawAttributes.repeatLimits.field).toBe('repeat_limits');
      expect(
        (await query('SELECT repeat_limits FROM monitor_log_blocks')).every(
          row => row.repeat_limits === null
        )
      ).toBe(true);
    } catch (error) {
      throw new Error(`辅助迁移catalog回归失败:${error.message}`);
    }
  });
  test('NULL未回填拒绝认证，事务故障回滚，断点续跑含capNULL，目录tamper阻断普通认证', async () => {
    try {
      expect(
        parseOptions(['derive-repeat', `--device=${deviceId}`, `--instance=${localId}`]).batchSize
      ).toBe(16);
      expect(() =>
        parseOptions([
          'derive-repeat',
          `--device=${deviceId}`,
          `--instance=${localId}`,
          '--batch-size=17',
        ])
      ).toThrow();
      await expect(migration.run(options('verify-repeat'))).rejects.toThrow('周期辅助元数据');
      const snapshot = await businessSnapshot();
      const before = await migration.run(options('status'));
      const original = sequelize.query.bind(sequelize);
      let updates = 0;
      const spy = jest.spyOn(sequelize, 'query').mockImplementation(async (sql, input) => {
        try {
          const text = typeof sql === 'string' ? sql : sql.query;
          if (/UPDATE monitor_log_blocks SET repeat_limits/.test(text) && ++updates === 2)
            throw new Error('synthetic-repeat-tx-rollback');
          return await original(sql, input);
        } catch (error) {
          throw new Error(error.message);
        }
      });
      try {
        await expect(migration.run(options('derive-repeat'))).rejects.toThrow('synthetic-repeat');
      } finally {
        spy.mockRestore();
      }
      expect(await businessSnapshot()).toEqual(snapshot);
      expect((await migration.run(options('status'))).generation).toBe(before.generation);
      expect(
        (await query('SELECT repeat_limits FROM monitor_log_blocks')).every(
          row => row.repeat_limits === null
        )
      ).toBe(true);
      const partial = await migration.run({
        ...options('derive-repeat'),
        batchSize: 1,
        maxBatches: 1,
      });
      expect(partial.complete).toBe(false);
      expect(partial.repeat.blocks).toBe(1);
      const restarted = createMigration({ sequelize, store });
      const finished = await restarted.run({ ...options('derive-repeat'), maxBatches: 40 });
      expect(finished.complete).toBe(true);
      expect(finished.repeat.blocks).toBe(25);
      expect(finished.repeat.fallbacks).toBe(1);
      const [cap] = await query(
        'SELECT id,repeat_limits IS NULL AS sql_null,jsonb_typeof(repeat_limits) AS type FROM monitor_log_blocks WHERE entry_count=1 AND repeat_limits IS NULL ORDER BY id'
      );
      expect(cap.sql_null).toBe(true);
      expect(cap.type).toBeNull();
      await query("UPDATE monitor_log_blocks SET repeat_limits='null'::jsonb WHERE id=:id", {
        id: cap.id,
      });
      await expect(
        restarted.run({ ...options('verify-repeat'), resetRepeat: true })
      ).rejects.toThrow('JSON null');
      await expect(restarted.run({ ...options('verify'), resetVerify: true })).rejects.toThrow(
        'JSON null'
      );
      const repaired = await restarted.run({
        ...options('derive-repeat'),
        resetRepeat: true,
        maxBatches: 40,
      });
      const [fixed] = await query(
        'SELECT repeat_limits IS NULL AS sql_null,jsonb_typeof(repeat_limits) AS type FROM monitor_log_blocks WHERE id=:id',
        { id: cap.id }
      );
      expect(fixed.sql_null).toBe(true);
      expect(fixed.type).toBeNull();
      const capKeyword = 'ЀЀЀЀ';
      const selected = await store.select(
        policy.query({ deviceId, localId, date: today, keyword: capKeyword }),
        null,
        'ASC',
        100
      );
      expect(selected.some(value => value.id === rows[24].id)).toBe(true);

      expect(finished.futureUploadsCovered).toBe(false);
      expect(finished.repeat.digest).toMatch(/^[a-f0-9]{64}$/);
      expect((await restarted.run(options('status'))).generation).toBe(repaired.repeat.generation);
      expect(await businessSnapshot()).toEqual(snapshot);
      const verified = await restarted.run(options('verify-repeat'));
      expect(verified.complete).toBe(true);
      expect(verified.repeat.digest).toBe(finished.repeat.digest);
      const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400000)
        .toISOString()
        .slice(0, 10);
      const bounded = { ...options('verify-repeat'), first: today, last: today };
      await expect(restarted.run(bounded)).rejects.toThrow('日期范围改变');
      expect((await restarted.run({ ...bounded, resetRepeat: true })).repeat).toMatchObject({
        first: today,
        last: today,
        complete: true,
      });
      await expect(restarted.run({ ...bounded, first: yesterday })).rejects.toThrow('日期范围改变');
      expect(
        (await restarted.run({ ...options('verify-repeat'), resetRepeat: true })).complete
      ).toBe(true);
      expect(
        parseOptions([
          'derive-repeat',
          `--device=${deviceId}`,
          `--instance=${localId}`,
          `--first=${today}`,
          `--last=${today}`,
        ]).first
      ).toBe(today);
      await migration.run(options('verify'));
      const [repeated] = await query(
        "SELECT id,business_date FROM monitor_log_blocks WHERE repeat_limits <> '{}'::jsonb ORDER BY id LIMIT 1"
      );
      await query("UPDATE monitor_log_blocks SET repeat_limits='{}'::jsonb WHERE id=:id", {
        id: repeated.id,
      });
      await expect(migration.run({ ...options('verify'), resetVerify: true })).rejects.toThrow(
        '周期辅助元数据'
      );
      await expect(
        migration.run({ ...options('verify-repeat'), resetRepeat: true })
      ).rejects.toThrow('周期辅助元数据');
      await migration.run({ ...options('derive-repeat'), resetRepeat: true, maxBatches: 40 });
      await migration.run(options('verify'));
      expect((await migration.run(options('read-switch'))).mode).toBe('blocks');
    } catch (error) {
      throw new Error(`周期回填认证回归失败:${error.message}`);
    }
  }, 30000);
  test('迟到持锁写入被捕获，压实代次自动重验，跨预算恢复维护禁止回填，全部原ID与字段保全', async () => {
    let transaction;
    let pending;
    try {
      const retire = parseOptions([
        'retire',
        `--device=${deviceId}`,
        `--instance=${localId}`,
        `--first=${today}`,
        `--last=${today}`,
        '--confirm-retire=yes',
      ]);
      await migration.run({ ...retire, maxBatches: 40 });
      expect(await MonitorLogEntry.count()).toBe(0);
      const fresh = entry(30);
      rows.push(fresh);
      await service.receive(deviceId, { entries: [fresh] });
      transaction = await sequelize.transaction();
      await AosDevice.findByPk(deviceId, { transaction, lock: transaction.LOCK.UPDATE });
      const late = entry(31);
      rows.push(late);
      const normalized = policy.entry(late);
      await store.append(
        [
          {
            ...normalized,
            deviceId,
            sortAt: normalized.loggedAt,
            payloadHash: policy.digest(normalized),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        transaction
      );
      let completed = false;
      pending = migration.run({ ...options('derive-repeat'), maxBatches: 40 }).then(value => {
        completed = true;
        return value;
      });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(completed).toBe(false);
      await transaction.commit();
      transaction = null;
      expect((await pending).repeat.blocks).toBe(27);
      await migration.run(options('verify-repeat'));
      await query(
        'INSERT INTO monitor_log_storage_metrics(name,value) VALUES(\'storage-default\',\'{"mode":"blocks"}\') ON CONFLICT(name) DO UPDATE SET value=excluded.value'
      );
      const pre = await migration.run(options('status'));
      const compacted = await compact({ today, maxBatches: 100, budgetMs: 5000 });
      expect(compacted.sourceBlocks).toBeGreaterThan(0);
      expect((await migration.run(options('status'))).generation).toBeGreaterThan(pre.generation);
      expect((await migration.run(options('verify-repeat'))).complete).toBe(true);
      const partial = await migration.run({ ...options('revert'), batchSize: 1, maxBatches: 1 });
      expect(partial.complete).toBe(false);
      await expect(migration.run(options('derive-repeat'))).rejects.toThrow('恢复维护');
      await expect(migration.run(options('verify-repeat'))).rejects.toThrow('恢复维护');
      const blocked = await compact({ today, maxBatches: 100, budgetMs: 5000 });
      expect(blocked.sourceBlocks).toBe(0);
      await migration.run(options('abort-maintenance'));
      expect((await migration.run(options('derive-repeat'))).complete).toBe(true);
      expect((await migration.run(options('revert'))).mode).toBe('rows');
      expect(await MonitorLogEntry.count()).toBe(27);
      const restored = (await migration.run(options('status'))).progress;
      expect(restored.restoredComplete).toBe(true);
      const derivedRows = await migration.run(options('derive-repeat'));
      expect(derivedRows.complete).toBe(true);
      const rebound = (await migration.run(options('status'))).progress;
      expect(rebound.restoredComplete).toBe(true);
      expect(rebound.restoreDigest).toBe(restored.restoreDigest);
      expect(rebound.restoredProofRebind).toMatchObject({
        metadataOnly: true,
        toGeneration: derivedRows.repeat.generation,
      });
      await migration.run(options('verify'));
      expect((await migration.run(options('status'))).progress.restoredComplete).toBe(true);
      expect(
        (await migration.run(parseOptions(['rollback-default', '--confirm-default-rollback=yes'])))
          .defaultRolledBack
      ).toBe(true);

      for (const row of rows) {
        const actual = await MonitorLogEntry.findByPk(row.id);
        expect(actual.message).toBe(row.message);
        expect(actual.payloadHash).toBe(policy.digest(policy.entry(row)));
        expect(actual.byteOffset).toBe(String(row.byteOffset));
        expect(actual.loggedAt.toISOString()).toBe(row.loggedAt);
      }
    } catch (error) {
      if (transaction && !transaction.finished) await transaction.rollback();
      if (pending) await pending.catch(() => undefined);
      throw new Error(`周期压实恢复回归失败:${error.message}`);
    }
  }, 30000);
  test('4MiB原文预算截断大块批次，资源capNULL推进而不中断，abort使辅助证书失效', async () => {
    const bigLocal = randomUUID();
    const bigFile = randomUUID();
    const input = command =>
      parseOptions([command, `--device=${deviceId}`, `--instance=${bigLocal}`]);
    const originalBytes = process.env.MONITOR_LOG_BLOCK_BYTES;
    try {
      process.env.MONITOR_LOG_BLOCK_BYTES = '2097152';
      await query(
        'INSERT INTO monitor_log_storage_metrics(name,value) VALUES(\'storage-default\',\'{"mode":"blocks"}\') ON CONFLICT(name) DO UPDATE SET value=excluded.value'
      );
      for (let batch = 0; batch < 4; batch++) {
        const values = Array.from({ length: 80 }, (_, index) => ({
          ...entry(batch * 80 + index),
          localId: bigLocal,
          fileId: bigFile,
          message: 'a'.repeat(15000),
        }));
        await service.receive(deviceId, { entries: values });
      }
      const before = await businessSnapshot();
      const partial = await migration.run({ ...input('derive-repeat'), maxBatches: 1 });
      expect(partial.processed).toBe(3);
      expect(partial.repeat.fallbacks).toBe(3);
      expect(partial.complete).toBe(false);
      const finished = await migration.run(input('derive-repeat'));
      expect(finished.repeat).toMatchObject({
        blocks: 4,
        entries: 320,
        fallbacks: 4,
        complete: true,
      });
      const [nulls] = await query(
        'SELECT count(*)::integer AS value FROM monitor_log_blocks WHERE local_id=:localId AND repeat_limits IS NULL',
        { localId: bigLocal }
      );
      expect(nulls.value).toBe(4);
      expect((await migration.run(input('verify-repeat'))).complete).toBe(true);
      expect(await businessSnapshot()).toEqual(before);
      const abortLocal = randomUUID();
      const abortFile = randomUUID();
      await query(
        "INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:deviceId,:localId,'rows')",
        { deviceId, localId: abortLocal }
      );
      const value = { ...entry(90), localId: abortLocal, fileId: abortFile };
      await service.receive(deviceId, { entries: [value] });
      const abortOptions = command =>
        parseOptions([command, `--device=${deviceId}`, `--instance=${abortLocal}`]);
      await migration.run(abortOptions('shadow'));
      await migration.run(abortOptions('backfill'));
      await migration.run(abortOptions('derive-repeat'));
      expect((await migration.run(abortOptions('status'))).progress.repeat.complete).toBe(true);
      expect((await migration.run(abortOptions('abort'))).mode).toBe('rows');
      expect((await migration.run(abortOptions('status'))).progress.repeat).toBeUndefined();
    } catch (error) {
      throw new Error(`周期字节预算与abort回归失败:${error.message}`);
    } finally {
      if (originalBytes === undefined) delete process.env.MONITOR_LOG_BLOCK_BYTES;
      else process.env.MONITOR_LOG_BLOCK_BYTES = originalBytes;
    }
  }, 30000);
});
