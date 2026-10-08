const logger = require('../src/utils/logger');
const { randomUUID } = require('crypto');
const {
  parseOptions,
  legacyRow,
  createMigration,
} = require('../scripts/monitorLogStorageMigration');
const policy = require('../src/services/monitorLogPolicy');
const {
  MIGRATION_LOCK,
  migrationProgressName,
  invalidateStorageCertification,
} = require('../src/services/monitorLogStorageCoordination');

const deviceId = randomUUID();
const localId = randomUUID();
const fileId = randomUUID();
const today = policy.retention().today;
const options = command => parseOptions([command, `--device=${deviceId}`, `--instance=${localId}`]);
const row = (offset = 0) => ({
  id: randomUUID(),
  deviceId,
  localId,
  fileId,
  fileName: `Log${today.replace(/-/g, '')}_123.txt`,
  businessDate: today,
  loggedAt: `${today}T01:00:00.000Z`,
  sortAt: `${today}T01:00:00.000Z`,
  accountNumber: '001',
  lineNumber: String(offset + 1),
  partIndex: 0,
  byteOffset: String(offset),
  message: '完整日志\n',
  rawBase64: null,
  parseState: 'parsed',
  payloadHash: 'a'.repeat(64),
  createdAt: `${today}T01:00:01.000Z`,
  updatedAt: `${today}T01:00:01.000Z`,
});
const databaseRow = value =>
  Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
      item,
    ])
  );

function boundsFor(row, prefix) {
  return {
    [`${prefix}_sort_at`]: row.sortAt,
    [`${prefix}_file_id`]: row.fileId,
    [`${prefix}_byte_offset`]: row.byteOffset,
  };
}
function fixture(initial = [], mode = 'shadow') {
  const state = {
    old: initial.map(databaseRow),
    blocks: [],
    accounts: [],
    receipts: [],
    mode,
    generation: 0,
  };
  const connection = {
    query: jest.fn(sql => {
      try {
        return { rows: [{ acquired: true }], sql };
      } catch (error) {
        logger.debug('迁移测试步骤失败', { errorCode: error.name });
        throw error;
      }
    }),
  };
  const transactions = [];
  const sequelize = {
    connectionManager: {
      getConnection: jest.fn(() => {
        try {
          return connection;
        } catch (error) {
          logger.debug('迁移测试步骤失败', { errorCode: error.name });
          throw error;
        }
      }),
      releaseConnection: jest.fn(() => {
        try {
          return undefined;
        } catch (error) {
          logger.debug('迁移测试步骤失败', { errorCode: error.name });
          throw error;
        }
      }),
      destroyConnection: jest.fn(() => {
        try {
          return undefined;
        } catch (error) {
          logger.debug('迁移测试步骤失败', { errorCode: error.name });
          throw error;
        }
      }),
    },
    transaction: jest.fn(async callback => {
      const snapshot = JSON.stringify(state);
      try {
        return await callback({ id: transactions.push({}), LOCK: { UPDATE: 'update' } });
      } catch (error) {
        Object.assign(state, JSON.parse(snapshot));
        throw error;
      }
    }),
    getQueryInterface: () => ({
      bulkInsert: jest.fn((_table, rows) => {
        try {
          state.old.push(...rows);
        } catch (error) {
          logger.debug('迁移测试步骤失败', { errorCode: error.name });
          throw error;
        }
      }),
    }),
    query: jest.fn((sql, { replacements = {} } = {}) => {
      try {
        if (sql.includes('set_config')) return [];
        if (sql.includes('FROM monitor_log_files'))
          return [{ ['device_id']: deviceId, ['file_id']: fileId }];
        if (sql.includes('FROM monitor_log_block_accounts'))
          return state.accounts.filter(item => item.block_id === replacements.blockId);
        if (sql.includes('SELECT value FROM monitor_log_storage_metrics'))
          return [{ value: state.progress }];
        if (sql.includes("VALUES('storage-default'")) {
          state.defaultMode = sql.includes('blocks') ? 'blocks' : 'rows';
          return [];
        }
        if (sql.includes('INSERT INTO monitor_log_storage_metrics')) {
          state.progress = JSON.parse(replacements.value);
          return [];
        }
        if (sql.includes('LEFT JOIN monitor_log_storage_metrics'))
          return state.blocks.some(
            block =>
              !state.progress?.restoredComplete || +state.progress.restoredBlockId < +block.id
          )
            ? [{ present: 1 }]
            : [];
        if (sql.includes('WITH live AS'))
          return state.blocks.some(
            block =>
              state.mode !== 'blocks' ||
              !state.progress?.switchedComplete ||
              state.progress.switchedGeneration !== state.generation ||
              +state.progress.verifiedBlockId < +block.id
          )
            ? [{ present: 1 }]
            : [];
        if (sql.includes('SELECT 1 FROM monitor_log_blocks'))
          return state.blocks.filter(block => +block.id > +replacements.after).slice(0, 1);
        if (sql.includes('SELECT 1 FROM monitor_log_receipts'))
          return state.receipts
            .filter(receipt => !state.old.some(item => item.id === receipt.id))
            .slice(0, 1);
        if (sql.includes('FROM aos_devices')) return [{ id: deviceId }];
        if (sql.includes('LOCK TABLE')) return [];
        if (sql.includes("WHERE mode <> 'rows'"))
          return state.mode !== 'rows' ? [{ present: 1 }] : [];
        if (sql.includes('SELECT 1 FROM monitor_log_entries'))
          return state.old.length ? [{ present: 1 }] : [];
        if (sql.includes('pg_total_relation_size'))
          return [{ bytes: state.truncated ? '8192' : '1048576' }];
        if (sql.includes("VALUES('storage-default'")) {
          state.defaultMode = sql.includes('blocks') ? 'blocks' : 'rows';
          return [];
        }
        if (sql.includes("SET mode='blocks'")) {
          state.mode = 'blocks';
          return [];
        }
        if (sql.includes('TRUNCATE monitor_log_entries')) {
          state.truncated = true;
          return [];
        }
        if (sql.includes('INSERT INTO monitor_log_storage_scopes')) return [];
        if (sql.includes('SELECT mode,generation'))
          return [{ mode: state.mode, generation: state.generation }];
        if (sql.includes('UPDATE monitor_log_storage_scopes')) {
          state.mode = replacements.target;
          state.generation += 1;
          return [];
        }
        if (sql.includes('SELECT e.*'))
          return state.old
            .filter(
              item =>
                replacements.afterOffset === undefined ||
                BigInt(item.byte_offset) > BigInt(replacements.afterOffset)
            )
            .sort((a, b) => Number(a.byte_offset) - Number(b.byte_offset))
            .slice(0, replacements.batchSize);
        if (sql.includes('SELECT b.*'))
          return state.blocks
            .filter(block => +block.id > +replacements.after)
            .slice(0, replacements.blockLimit || 20);
        if (sql.includes('SELECT id,file_key') || sql.includes('SELECT id,encode'))
          return state.receipts.filter(
            receipt => String(receipt.block_id) === String(replacements.blockId)
          );
        if (
          sql.includes('SELECT * FROM monitor_log_entries') ||
          sql.includes('SELECT id FROM monitor_log_entries')
        )
          return state.old.filter(item => replacements.ids.includes(item.id));
        if (sql.includes('LEFT JOIN monitor_log_receipts'))
          return state.old.filter(
            item =>
              !state.receipts.some(
                receipt => receipt.id === item.id && receipt.hash === item.payload_hash
              )
          );
        if (sql.includes('AS receipt_id'))
          return state.receipts
            .filter(receipt => !state.old.some(item => item.id === receipt.id))
            .slice(0, replacements.batchSize)
            .map(receipt => ({
              ...state.blocks.find(block => block.id === receipt.block_id),
              ['receipt_id']: receipt.id,
              ['receipt_hash']: receipt.hash,
              ordinal: receipt.ordinal,
              ['block_id']: receipt.block_id,
            }));
        if (sql.includes('SELECT e.id'))
          return state.old.map(item => ({ id: item.id })).slice(0, replacements.batchSize);
        if (sql.includes('SELECT DISTINCT b.*'))
          return state.blocks.filter(block =>
            state.receipts.some(
              receipt => receipt.block_id === block.id && replacements.ids.includes(receipt.id)
            )
          );
        if (sql.includes('DELETE FROM monitor_log_entries')) {
          state.old = state.old.filter(item => !replacements.ids.includes(item.id));
          return [];
        }
        throw new Error(`未实现的测试SQL:${sql}`);
      } catch (error) {
        logger.debug('迁移测试步骤失败', { errorCode: error.name });
        throw error;
      }
    }),
  };
  const store = {
    compare: (a, b) => Number(a.byteOffset) - Number(b.byteOffset),
    signature: messages => messages.join('|'),
    append: jest.fn(rows => {
      try {
        const sorted = [...rows].sort((a, b) => Number(a.byteOffset) - Number(b.byteOffset));
        const block = {
          ...boundsFor(sorted[0], 'min'),
          ...boundsFor(sorted[sorted.length - 1], 'max'),
          signature: rows.map(item => item.message).join('|'),
          id: String(state.blocks.length + 1),
          ['file_key']: '1',
          ['entry_count']: rows.length,
          ['device_id']: deviceId,
          ['local_id']: localId,
          ['business_date']: today,
          ['payload_hash']: Buffer.alloc(32),
          decoded: rows,
        };
        state.blocks.push(block);
        state.accounts.push({
          ...boundsFor(sorted[0], 'min'),
          ...boundsFor(sorted[sorted.length - 1], 'max'),
          ['device_id']: deviceId,
          ['local_id']: localId,
          ['block_id']: block.id,
          ['account_number']: '001',
        });
        state.receipts.push(
          ...rows.map((item, ordinal) => ({
            id: item.id,
            ['file_key']: '1',
            ['byte_offset']: item.byteOffset,
            hash: item.payloadHash,
            ordinal,
            ['block_id']: block.id,
          }))
        );
      } catch (error) {
        logger.debug('迁移测试步骤失败', { errorCode: error.name });
        throw error;
      }
    }),
    readBlock: jest.fn(block => {
      try {
        return block.decoded.map(item => ({ ...item, payloadHash: undefined }));
      } catch (error) {
        logger.debug('迁移测试步骤失败', { errorCode: error.name });
        throw error;
      }
    }),
  };
  return { state, sequelize, store, connection, migration: createMigration({ sequelize, store }) };
}

describe('日志迁移CLI输入与并发保护', () => {
  test('拒绝未知命令、缺失范围、非法预算和缩小切换窗口', () => {
    expect(() => options('unknown')).toThrow();
    expect(() => parseOptions(['shadow'])).toThrow();
    expect(() =>
      parseOptions(['backfill', `--device=${deviceId}`, `--instance=${localId}`, '--max-batches=0'])
    ).toThrow();
    expect(() =>
      parseOptions([
        'read-switch',
        `--device=${deviceId}`,
        `--instance=${localId}`,
        `--first=${today}`,
      ])
    ).toThrow();
    expect(() => options('retire')).toThrow();
  });
  test('全局finalize需显式确认且旧表非空禁止truncate', async () => {
    expect(() => parseOptions(['finalize'])).toThrow('全局收尾');
    const value = parseOptions(['finalize', '--confirm-finalize=yes', '--all-api-upgraded=yes']);
    const f = fixture([row()]);
    await expect(f.migration.run(value)).rejects.toThrow('旧表仍有片段');
    expect(f.state.truncated).toBeUndefined();
    f.state.old = [];
    const result = await f.migration.run(value);
    expect(result).toMatchObject({ finalized: true, mode: 'blocks', releasedBytes: '1040384' });
    expect(f.state.truncated).toBe(true);
  });
  test('finalize拒绝仍有活跃块的rows/shadow及旧认证代次', async () => {
    const f = fixture([row()]);
    await f.migration.run(options('backfill'));
    f.state.old = [];
    const value = parseOptions(['finalize', '--confirm-finalize=yes', '--all-api-upgraded=yes']);
    await expect(f.migration.run(value)).rejects.toThrow('当前代次认证');
    f.state.mode = 'blocks';
    f.state.progress = { switchedComplete: true, switchedGeneration: 0, verifiedBlockId: '1' };
    f.state.generation = 1;
    await expect(f.migration.run(value)).rejects.toThrow('当前代次认证');
  });
  test('全局默认回退必须证明scope已rows且压缩数据已完整恢复', async () => {
    expect(() => parseOptions(['rollback-default'])).toThrow('默认回退');
    const f = fixture([row()]);
    await f.migration.run(options('backfill'));
    await f.migration.run(options('read-switch'));
    const rollback = parseOptions(['rollback-default', '--confirm-default-rollback=yes']);
    await expect(f.migration.run(rollback)).rejects.toThrow('仍有块');
    f.state.mode = 'rows';
    await expect(f.migration.run(rollback)).rejects.toThrow('完整恢复认证');
    f.state.mode = 'blocks';
    await f.migration.run(options('revert'));
    expect((await f.migration.run(rollback)).defaultRolledBack).toBe(true);
    expect(f.state.defaultMode).toBe('rows');
  });
  test('全局锁竞争失败不执行事务，并释放连接', async () => {
    const f = fixture();
    f.connection.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
    await expect(f.migration.run(options('shadow'))).rejects.toThrow('正在运行');
    expect(f.sequelize.transaction).not.toHaveBeenCalled();
    expect(f.sequelize.connectionManager.releaseConnection).toHaveBeenCalled();
  });
  test('解锁失败销毁会话，不将持锁连接交还池', async () => {
    const f = fixture();
    f.connection.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(new Error('lost'));
    await expect(f.migration.run(options('shadow'))).rejects.toThrow('lost');
    expect(f.sequelize.connectionManager.destroyConnection).toHaveBeenCalled();
    expect(f.sequelize.connectionManager.releaseConnection).not.toHaveBeenCalled();
  });
});

describe('日志迁移有界补齐、对账、切换与恢复', () => {
  test('逐批反连接捕获createdAt更早的迟到提交，可重复运行', async () => {
    const f = fixture([row()]);
    const first = await f.migration.run({ ...options('backfill'), maxBatches: 1 });
    expect(first).toMatchObject({ complete: false, processed: 1 });
    const late = databaseRow({ ...row(1), createdAt: `${today}T00:00:00.000Z` });
    f.state.old.push(late);
    // shadow writer commits its receipt atomically even if new UUID precedes the backfill cursor.
    await f.store.append([legacyRow(late)]);
    const next = await f.migration.run(options('backfill'));
    expect(next.complete).toBe(true);
    expect(
      f.store.append.mock.calls.flatMap(call => call[0]).some(item => item.id === late.id)
    ).toBe(true);
    expect((await f.migration.run(options('backfill'))).processed).toBe(0);
  });
  test('积压超切换预算时保持shadow，整批回滚', async () => {
    const f = fixture([row(), row(1)]);
    await expect(f.migration.run({ ...options('read-switch'), batchSize: 1 })).rejects.toThrow(
      '尚未完成'
    );
    expect(f.state.mode).toBe('shadow');
    expect(f.state.blocks).toHaveLength(0);
  });
  test('载荷一致时完整校验再切blocks，保持稳定事件定位', async () => {
    const f = fixture([row(), row(1)]);
    await f.migration.run(options('backfill'));
    const result = await f.migration.run(options('read-switch'));
    expect(result.mode).toBe('blocks');
    expect(result.verified).toMatchObject({ entries: 2 });
    expect(f.state.generation).toBe(1);
  });
  test('离线校验持久水位，最终尾部超过4块拒绝切读并可续跑', async () => {
    const f = fixture(Array.from({ length: 6 }, (_, index) => row(index)));
    await f.migration.run({ ...options('backfill'), batchSize: 1 });
    expect(
      (await f.migration.run({ ...options('verify'), batchSize: 1, maxBatches: 1 })).complete
    ).toBe(false);
    expect(f.state.progress.verifiedBlockId).toBe('1');
    await expect(f.migration.run(options('read-switch'))).rejects.toThrow('校验积压');
    expect(f.state.mode).toBe('shadow');
    expect(f.state.progress.verifiedBlockId).toBe('1');
    await f.migration.run(options('verify'));
    expect((await f.migration.run(options('read-switch'))).mode).toBe('blocks');
  });
  test.each(['signature', 'min', 'account'])('目录损坏 %s 拒绝认证和切读', async field => {
    const f = fixture([row(), row(1)]);
    await f.migration.run(options('backfill'));
    if (field === 'signature') f.state.blocks[0].signature = 'corrupt';
    if (field === 'min') f.state.blocks[0]['min_byte_offset'] = '999';
    if (field === 'account') f.state.accounts = [];
    await expect(f.migration.run(options('verify'))).rejects.toThrow(/边界|签名|成员/);
    expect(f.state.progress.verifiedBlockId).toBe('0');
  });
  test('reset-verify可发现认证后违规修改旧行的差异', async () => {
    const f = fixture([row()]);
    await f.migration.run(options('backfill'));
    await f.migration.run(options('verify'));
    f.state.old[0].message = 'SQL违规改动';
    await expect(f.migration.run({ ...options('verify'), resetVerify: true })).rejects.toThrow(
      '原始载荷'
    );
  });
  test('回执序号错误时不能宣布verify成功', async () => {
    const f = fixture([row()]);
    await f.migration.run(options('backfill'));
    f.state.receipts[0].ordinal = 2;
    await expect(f.migration.run(options('verify'))).rejects.toThrow('回执定位');
  });
  test('旧行正文与已压缩载荷不一致拒绝切读', async () => {
    const f = fixture([row()]);
    await f.migration.run(options('backfill'));
    f.state.old[0].message = 'changed';
    await expect(f.migration.run(options('read-switch'))).rejects.toThrow('原始载荷');
    expect(f.state.mode).toBe('shadow');
  });
  test('回收后blocks唯一新增，回滚恢复正文和历史摘要', async () => {
    const f = fixture([row()]);
    await f.migration.run(options('backfill'));
    await f.migration.run(options('read-switch'));
    const retire = { ...options('backfill'), command: 'retire' };
    expect((await f.migration.run(retire)).processed).toBe(1);
    await f.store.append([row(2)]);
    expect(f.state.old).toHaveLength(0);
    const result = await f.migration.run(options('revert'));
    expect(result.mode).toBe('rows');
    expect(f.state.old).toHaveLength(2);
    expect(f.state.old.every(item => item.payload_hash === 'a'.repeat(64))).toBe(true);
  });
  test('共享锁与认证失效纯函数保留backfill和maintenance，不改原值', () => {
    const value = {
      backfillComplete: true,
      backfillCursor: { byteOffset: '1' },
      maintenance: { kind: 'revert' },
      verifiedBlockId: '99',
      verifiedEntries: 3,
      verifiedGeneration: 1,
      digest: 'old',
      switchedComplete: true,
      switchedGeneration: 1,
      restoreBlockId: '99',
      restoredEntries: 3,
      restoreDigest: 'x',
      restoredComplete: true,
      restoredBlockId: '99',
      restoredAt: 'old',
    };
    expect(MIGRATION_LOCK).toBe(2026100701);
    expect(migrationProgressName(deviceId, localId)).toBe(`migration:${deviceId}:${localId}`);
    const cleared = invalidateStorageCertification(value);
    expect(cleared).toEqual({
      backfillComplete: true,
      backfillCursor: { byteOffset: '1' },
      maintenance: { kind: 'revert' },
    });
    expect(value.verifiedBlockId).toBe('99');
  });
  test('恢复maintenance跨预算与新执行器持续，禁止认证和旧副本回收，完成后清除', async () => {
    const f = fixture(Array.from({ length: 6 }, (_, index) => row(index)));
    await f.migration.run({ ...options('backfill'), batchSize: 1 });
    await f.migration.run(options('verify'));
    await f.migration.run(options('read-switch'));
    await f.migration.run({ ...options('backfill'), command: 'retire' });
    const result = await f.migration.run({ ...options('revert'), batchSize: 1, maxBatches: 1 });
    expect(result.complete).toBe(false);
    expect(f.state.progress.maintenance.kind).toBe('revert');
    expect(f.state.old).toHaveLength(1);
    const resumed = createMigration({ sequelize: f.sequelize, store: f.store });
    await expect(resumed.run(options('verify'))).rejects.toThrow('维护期间');
    await expect(resumed.run({ ...options('backfill'), command: 'retire' })).rejects.toThrow(
      '维护未结束'
    );
    expect((await resumed.run(options('revert'))).mode).toBe('rows');
    expect(f.state.old).toHaveLength(6);
    expect(f.state.progress.maintenance).toBeUndefined();
  });
  test('abort-maintenance解除恢复标记但保持blocks和已恢复旧行', async () => {
    const f = fixture([row(), row(1)]);
    await f.migration.run({ ...options('backfill'), batchSize: 1 });
    await f.migration.run(options('read-switch'));
    await f.migration.run({ ...options('backfill'), command: 'retire' });
    await f.migration.run({ ...options('revert'), batchSize: 1, maxBatches: 1 });
    const result = await f.migration.run(options('abort-maintenance'));
    expect(result).toMatchObject({
      mode: 'blocks',
      maintenanceAborted: true,
      partialLegacyPreserved: true,
    });
    expect(f.state.progress.maintenance).toBeUndefined();
    expect(f.state.old).toHaveLength(1);
    expect(f.state.progress.restoreBlockId).toBeUndefined();
    expect((await f.migration.run(options('revert'))).mode).toBe('rows');
    expect(f.state.old).toHaveLength(2);
  });
  test('压实后generation变化重新认证无旧行live块，恢复最新block定位保持原回执', async () => {
    const f = fixture([row(), row(1), row(2)]);
    await f.migration.run({ ...options('backfill'), batchSize: 1 });
    await f.migration.run(options('verify'));
    await f.migration.run(options('read-switch'));
    await f.migration.run({ ...options('backfill'), command: 'retire' });
    const rows = f.state.blocks.flatMap(block => block.decoded).sort(f.store.compare);
    const merged = {
      ...f.state.blocks[0],
      id: '100',
      decoded: rows,
      ['entry_count']: rows.length,
      ...boundsFor(rows[0], 'min'),
      ...boundsFor(rows[rows.length - 1], 'max'),
      signature: f.store.signature(rows.map(item => item.message)),
    };
    f.state.blocks = [merged];
    f.state.accounts = [
      {
        ...f.state.accounts[0],
        ['block_id']: '100',
        ...boundsFor(rows[0], 'min'),
        ...boundsFor(rows[rows.length - 1], 'max'),
      },
    ];
    const ids = rows.map(item => item.id);
    f.state.receipts = f.state.receipts.map(receipt => ({
      ...receipt,
      ['block_id']: '100',
      ordinal: ids.indexOf(receipt.id),
    }));
    f.state.generation += 1;
    f.state.progress = invalidateStorageCertification(f.state.progress);
    expect((await f.migration.run(options('verify'))).complete).toBe(true);
    expect(f.state.progress.verifiedBlockId).toBe('100');
    expect(f.state.progress.switchedGeneration).toBe(f.state.generation);
    expect((await f.migration.run(options('revert'))).mode).toBe('rows');
    expect(f.state.old.map(item => item.id).sort()).toEqual(ids.sort());
    expect(f.state.old.every(item => item.payload_hash === 'a'.repeat(64))).toBe(true);
  });
  test('块模式不能abort直接丢弃新独有日志', async () => {
    const f = fixture([], 'blocks');
    await expect(f.migration.run(options('abort'))).rejects.toThrow('revert');
  });
  test('旧snakeCase映射不损失账号前导零和源位置', () => {
    const value = row(42);
    expect(legacyRow(databaseRow(value))).toEqual(value);
  });
});
