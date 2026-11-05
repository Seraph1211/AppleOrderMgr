const crypto = require('crypto');
const { Sequelize, QueryTypes } = require('sequelize');
const { Client } = require('pg');
const migration = require('../migrations/20261106000001-create-apple-purchase-sync');
const { makeBatch } = require('./fixtures/applePurchaseSyncV1');

const enabled = process.env.RUN_APPLE_PURCHASE_SYNC_DB === 'true';
const describeDb = enabled ? describe : describe.skip;

describeDb('ApplePurchase 同步隔离 PostgreSQL', () => {
  let database;
  let terminalService;
  let ingestService;
  let queryService;
  let terminal;

  beforeAll(async () => {
    if (process.env.DB_HOST !== 'postgres') throw new Error('隔离测试只允许 Compose postgres');
    if (!/^apple_purchase_sync_test_/.test(process.env.DB_NAME || '')) {
      throw new Error('隔离测试库名称不符合安全前缀');
    }
    if (process.env.DATABASE_URL) throw new Error('隔离测试禁止 DATABASE_URL');
    database = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      dialect: 'postgres',
      logging: false,
      pool: { max: 10, min: 0, idle: 1000 },
    });
    await database.query(
      'CREATE TABLE IF NOT EXISTS public.users (id INTEGER PRIMARY KEY, username VARCHAR(50))'
    );
    await database.query(
      "INSERT INTO public.users(id, username) VALUES (1, 'synthetic-admin') ON CONFLICT DO NOTHING"
    );
    const queryInterface = database.getQueryInterface();
    await migration.up(queryInterface, Sequelize);
    await migration.down(queryInterface, Sequelize);
    await migration.up(queryInterface, Sequelize);
    process.env.NODE_ENV = 'test';
    const databaseService = require('../src/services/applePurchaseSyncDatabase');
    databaseService.setDatabaseForTest('admin', database);
    databaseService.setDatabaseForTest('ingest', database);
    databaseService.setDatabaseForTest('read', database);
    terminalService = require('../src/services/applePurchaseSyncTerminalService');
    ingestService = require('../src/services/applePurchaseSyncIngestService');
    queryService = require('../src/services/applePurchaseInventoryQueryService');
    terminal = await terminalService.createTerminal(
      { name: '合成 Mac 采集端' },
      { id: 1 },
      crypto.randomUUID()
    );
  }, 30_000);

  afterAll(async () => {
    if (!database) return;
    await migration.down(database.getQueryInterface(), Sequelize);
    await database.close();
  }, 30_000);

  test('Migration up/down/up 后结构、约束、索引与最小角色存在', async () => {
    const tables = await database.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema='apple_purchase_sync' ORDER BY table_name`,
      { type: QueryTypes.SELECT }
    );
    expect(tables.map(row => row.name)).toEqual([
      'ingest_batches',
      'monitor_changes',
      'observations',
      'terminal_audit_events',
      'terminals',
    ]);
    const roles = await database.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN
       ('apple_purchase_sync_ingest','apple_purchase_sync_read','apple_purchase_sync_admin')
       ORDER BY rolname`,
      { type: QueryTypes.SELECT }
    );
    expect(roles).toHaveLength(3);
  });

  test('最小角色不能跨越 Token 与终端管理边界', async () => {
    await expect(
      database.transaction(async transaction => {
        await database.query('SET LOCAL ROLE apple_purchase_sync_read', { transaction });
        await database.query('SELECT token_hash FROM apple_purchase_sync.terminals', {
          transaction,
        });
      })
    ).rejects.toBeTruthy();
    await expect(
      database.transaction(async transaction => {
        await database.query('SET LOCAL ROLE apple_purchase_sync_ingest', { transaction });
        await database.query("UPDATE apple_purchase_sync.terminals SET name='越权'", {
          transaction,
        });
      })
    ).rejects.toBeTruthy();
    await expect(
      database.transaction(async transaction => {
        await database.query('SET LOCAL ROLE apple_purchase_sync_admin', { transaction });
        await database.query('SELECT token_hash FROM apple_purchase_sync.terminals', {
          transaction,
        });
      })
    ).rejects.toBeTruthy();
    await expect(
      database.transaction(async transaction => {
        await database.query('SET LOCAL ROLE apple_purchase_sync_admin', { transaction });
        await database.query('SELECT sequence FROM apple_purchase_sync.observations', {
          transaction,
        });
      })
    ).rejects.toBeTruthy();
  });

  test('创建只保存摘要并返回一次性 Token，列表不返回摘要或明文', async () => {
    expect(terminal.token).toMatch(/^aps_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const [stored] = await database.query(
      `SELECT token_hash AS hash, token_prefix AS prefix
       FROM apple_purchase_sync.terminals WHERE id=:id`,
      { replacements: { id: terminal.terminalId }, type: QueryTypes.SELECT }
    );
    expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.hash).not.toContain(terminal.token);
    expect(JSON.stringify(await terminalService.listTerminals())).not.toContain(terminal.token);
  });

  test('混合批次提交后可读，原样重试和并发重试只保存一份', async () => {
    const batch = makeBatch({ terminalId: terminal.terminalId });
    const authenticated = await ingestService.authenticate(terminal.token);
    const first = await ingestService.ingestBatch(
      batch,
      authenticated,
      terminal.token,
      crypto.randomUUID()
    );
    expect(first).toMatchObject({
      accepted: { observations: 1, monitorChanges: 1 },
      duplicates: { observations: 0, monitorChanges: 0 },
    });
    const [retry, concurrent] = await Promise.all([
      ingestService.ingestBatch(batch, authenticated, terminal.token, crypto.randomUUID()),
      ingestService.ingestBatch(batch, authenticated, terminal.token, crypto.randomUUID()),
    ]);
    expect(retry.accepted).toEqual({ observations: 1, monitorChanges: 1 });
    expect(concurrent.accepted).toEqual({ observations: 1, monitorChanges: 1 });
    const [counts] = await database.query(
      `SELECT
        (SELECT count(*)::int FROM apple_purchase_sync.observations) AS observations,
        (SELECT count(*)::int FROM apple_purchase_sync.monitor_changes) AS changes,
        (SELECT count(*)::int FROM apple_purchase_sync.ingest_batches) AS batches`,
      { type: QueryTypes.SELECT }
    );
    expect(counts).toEqual({ observations: 1, changes: 1, batches: 1 });
    expect((await queryService.listObservations({})).items).toHaveLength(1);
    expect((await queryService.listMonitorChanges({})).items).toHaveLength(1);
  });

  test('Token 与 terminalId 不匹配返回 401 且不创建批次', async () => {
    const authenticated = await ingestService.authenticate(terminal.token);
    const batch = makeBatch({ terminalId: crypto.randomUUID() });
    await expect(
      ingestService.ingestBatch(batch, authenticated, terminal.token, crypto.randomUUID())
    ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    const [count] = await database.query(
      'SELECT count(*)::int AS count FROM apple_purchase_sync.ingest_batches',
      { type: QueryTypes.SELECT }
    );
    expect(count.count).toBe(1);
  });

  test('同事件跨批同内容计重复，同 ID 异内容整批回滚', async () => {
    const authenticated = await ingestService.authenticate(terminal.token);
    const duplicate = makeBatch({ terminalId: terminal.terminalId });
    const duplicateResult = await ingestService.ingestBatch(
      duplicate,
      authenticated,
      terminal.token,
      crypto.randomUUID()
    );
    expect(duplicateResult).toMatchObject({
      accepted: { observations: 0, monitorChanges: 0 },
      duplicates: { observations: 1, monitorChanges: 1 },
    });
    const conflict = makeBatch({ terminalId: terminal.terminalId });
    conflict.observations[0].productName = '不同合成机型';
    conflict.monitorChanges[0].eventId = 'synthetic-monitor-event-rollback';
    await expect(
      ingestService.ingestBatch(conflict, authenticated, terminal.token, crypto.randomUUID())
    ).rejects.toMatchObject({ statusCode: 409, code: 'EVENT_ID_CONFLICT' });
    const [counts] = await database.query(
      `SELECT
        (SELECT count(*)::int FROM apple_purchase_sync.monitor_changes) AS changes,
        (SELECT count(*)::int FROM apple_purchase_sync.ingest_batches) AS batches`,
      { type: QueryTypes.SELECT }
    );
    expect(counts).toEqual({ changes: 1, batches: 2 });
    const batchConflict = makeBatch({ terminalId: terminal.terminalId });
    batchConflict.batchId = duplicate.batchId;
    batchConflict.observations[0].productName = '批次内容变化';
    await expect(
      ingestService.ingestBatch(batchConflict, authenticated, terminal.token, crypto.randomUUID())
    ).rejects.toMatchObject({ statusCode: 409, code: 'BATCH_ID_CONFLICT' });
  });

  test('固定高水位分页期间新增记录不重复，bigint 始终输出字符串', async () => {
    const authenticated = await ingestService.authenticate(terminal.token);
    const original = makeBatch({ terminalId: terminal.terminalId }).observations[0];
    for (let index = 2; index <= 4; index += 1) {
      const batch = makeBatch({ terminalId: terminal.terminalId, monitorChanges: [] });
      batch.observations = [{ ...original, observationId: `synthetic-observation-000${index}` }];
      await ingestService.ingestBatch(batch, authenticated, terminal.token, crypto.randomUUID());
    }
    const first = await queryService.listObservations({ limit: '2', direction: 'asc' });
    expect(first.items).toHaveLength(2);
    expect(first.page.hasMore).toBe(true);
    const late = makeBatch({ terminalId: terminal.terminalId, monitorChanges: [] });
    late.observations = [{ ...original, observationId: 'synthetic-observation-late' }];
    await ingestService.ingestBatch(late, authenticated, terminal.token, crypto.randomUUID());
    const second = await queryService.listObservations({
      limit: '2',
      direction: 'asc',
      cursor: first.page.nextCursor,
    });
    expect(new Set([...first.items, ...second.items].map(item => item.observationId)).size).toBe(4);
    expect(second.items.some(item => item.observationId === 'synthetic-observation-late')).toBe(
      false
    );
    expect(first.items.every(item => typeof item.sequence === 'string')).toBe(true);
  });

  test('PG 通知只在成功事务提交后出现且仅含高水位', async () => {
    const listener = new Client({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    const notifications = [];
    listener.on('notification', event => notifications.push(JSON.parse(event.payload)));
    await listener.connect();
    await listener.query('LISTEN apple_purchase_inventory_version');
    const authenticated = await ingestService.authenticate(terminal.token);
    const original = makeBatch({ terminalId: terminal.terminalId }).observations[0];
    const success = makeBatch({ terminalId: terminal.terminalId, monitorChanges: [] });
    success.observations = [{ ...original, observationId: 'synthetic-observation-notify' }];
    await ingestService.ingestBatch(success, authenticated, terminal.token, crypto.randomUUID());
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      observations: expect.stringMatching(/^\d+$/),
      monitorChanges: expect.stringMatching(/^\d+$/),
    });
    const conflict = makeBatch({ terminalId: terminal.terminalId, monitorChanges: [] });
    conflict.observations = [
      { ...original, observationId: 'synthetic-observation-notify', productName: '冲突值' },
    ];
    await expect(
      ingestService.ingestBatch(conflict, authenticated, terminal.token, crypto.randomUUID())
    ).rejects.toMatchObject({ code: 'EVENT_ID_CONFLICT' });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(notifications).toHaveLength(1);
    await listener.end();
  });

  test('跨位数及超安全整数按 bigint 数值升降序分页并固定高水位', async () => {
    const boundaryTerminal = await terminalService.createTerminal(
      { name: '分页边界合成终端' },
      { id: 1 },
      crypto.randomUUID()
    );
    const authenticated = await ingestService.authenticate(boundaryTerminal.token);
    const sequences = ['9', '10', '99', '100', '999', '1000', '9007199254740993'];
    for (let index = 0; index < sequences.length; index += 1) {
      await database.query(
        `ALTER SEQUENCE apple_purchase_sync.observations_sequence_seq
         RESTART WITH ${sequences[index]}`
      );
      await database.query(
        `ALTER SEQUENCE apple_purchase_sync.monitor_changes_sequence_seq
         RESTART WITH ${sequences[index]}`
      );
      const boundaryBatch = makeBatch({ terminalId: boundaryTerminal.terminalId });
      boundaryBatch.observations[0].observationId = `boundary-observation-${index}`;
      boundaryBatch.observations[0].sourceSequence = String(10_000 + index);
      boundaryBatch.monitorChanges[0].eventId = `boundary-monitor-change-${index}`;
      boundaryBatch.monitorChanges[0].sourceSequence = String(20_000 + index);
      await ingestService.ingestBatch(
        boundaryBatch,
        authenticated,
        boundaryTerminal.token,
        crypto.randomUUID()
      );
    }

    const collectPages = async (listPage, direction, firstPage = null) => {
      const items = [];
      let page = firstPage;
      let cursor;
      do {
        if (!page) {
          page = await listPage({
            limit: '2',
            direction,
            terminalId: boundaryTerminal.terminalId,
            ...(cursor ? { cursor } : {}),
          });
        }
        items.push(...page.items);
        cursor = page.page.nextCursor;
        page = null;
      } while (cursor);
      return items;
    };

    for (const listPage of [
      queryService.listObservations,
      queryService.listMonitorChanges,
    ]) {
      const ascending = await collectPages(listPage, 'asc');
      const descending = await collectPages(listPage, 'desc');
      expect(ascending.map(item => item.sequence)).toEqual(sequences);
      expect(descending.map(item => item.sequence)).toEqual([...sequences].reverse());
      expect(ascending.every(item => typeof item.sequence === 'string')).toBe(true);
    }

    const fixedPages = {
      observationsAsc: await queryService.listObservations({
        limit: '2',
        direction: 'asc',
        terminalId: boundaryTerminal.terminalId,
      }),
      observationsDesc: await queryService.listObservations({
        limit: '2',
        direction: 'desc',
        terminalId: boundaryTerminal.terminalId,
      }),
      monitorChangesAsc: await queryService.listMonitorChanges({
        limit: '2',
        direction: 'asc',
        terminalId: boundaryTerminal.terminalId,
      }),
      monitorChangesDesc: await queryService.listMonitorChanges({
        limit: '2',
        direction: 'desc',
        terminalId: boundaryTerminal.terminalId,
      }),
    };
    for (const page of Object.values(fixedPages)) {
      expect(page.page.highWaterSequence).toBe('9007199254740993');
    }

    await database.query(
      'ALTER SEQUENCE apple_purchase_sync.observations_sequence_seq RESTART WITH 9007199254740994'
    );
    await database.query(
      'ALTER SEQUENCE apple_purchase_sync.monitor_changes_sequence_seq RESTART WITH 9007199254740994'
    );
    const late = makeBatch({ terminalId: boundaryTerminal.terminalId });
    late.observations[0].observationId = 'boundary-observation-late';
    late.monitorChanges[0].eventId = 'boundary-monitor-change-late';
    await ingestService.ingestBatch(
      late,
      authenticated,
      boundaryTerminal.token,
      crypto.randomUUID()
    );

    const fixedCases = [
      [queryService.listObservations, 'asc', fixedPages.observationsAsc, sequences],
      [queryService.listObservations, 'desc', fixedPages.observationsDesc, [...sequences].reverse()],
      [queryService.listMonitorChanges, 'asc', fixedPages.monitorChangesAsc, sequences],
      [
        queryService.listMonitorChanges,
        'desc',
        fixedPages.monitorChangesDesc,
        [...sequences].reverse(),
      ],
    ];
    for (const [listPage, direction, firstPage, expected] of fixedCases) {
      const items = await collectPages(listPage, direction, firstPage);
      expect(items.map(item => item.sequence)).toEqual(expected);
      expect(items.some(item => item.sequence === '9007199254740994')).toBe(false);
    }
  });

  test('禁用即时拒绝旧 Token，轮换后仅新 Token 有效并保留历史', async () => {
    await terminalService.updateTerminal(
      terminal.terminalId,
      { enabled: false },
      { id: 1 },
      crypto.randomUUID()
    );
    await expect(ingestService.authenticate(terminal.token)).rejects.toMatchObject({
      statusCode: 401,
      code: 'TERMINAL_DISABLED',
    });
    await terminalService.updateTerminal(
      terminal.terminalId,
      { enabled: true },
      { id: 1 },
      crypto.randomUUID()
    );
    const rotated = await terminalService.rotateToken(
      terminal.terminalId,
      {},
      { id: 1 },
      crypto.randomUUID()
    );
    await expect(ingestService.authenticate(terminal.token)).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
    await expect(ingestService.authenticate(rotated.token)).resolves.toMatchObject({
      id: terminal.terminalId,
    });
    const [history] = await database.query(
      'SELECT count(*)::int AS count FROM apple_purchase_sync.observations',
      { type: QueryTypes.SELECT }
    );
    expect(history.count).toBeGreaterThan(0);
  });
});
