#!/usr/bin/env node
const { createHash } = require('crypto');
const { QueryTypes } = require('sequelize');
const policy = require('../src/services/monitorLogPolicy');
const p = require('../src/services/monitorPolicy');
const logger = require('../src/utils/logger');
const {
  MIGRATION_LOCK,
  migrationProgressName,
  invalidateStorageCertification,
} = require('../src/services/monitorLogStorageCoordination');

const COMMANDS = [
  'status',
  'shadow',
  'backfill',
  'verify',
  'read-switch',
  'abort',
  'revert',
  'retire',
  'finalize',
  'rollback-default',
  'abort-maintenance',
];
const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 5000;
const DEFAULT_MAX_BATCHES = 20;
const DEFAULT_BUDGET_MS = 30000;
const MAX_BUDGET_MS = 300000;
const JSON_INDENT = 2;
const OPTIONS = [
  'device',
  'instance',
  'batch-size',
  'max-batches',
  'budget-ms',
  'first',
  'last',
  'confirm-retire',
  'reset-verify',
  'confirm-finalize',
  'all-api-upgraded',
  'confirm-default-rollback',
];

/** 验证命令和范围；只允许显式指定一个设备实例。 @param {string[]} argv 参数 @returns {Object} 输入 */
function parseOptions(argv) {
  const command = argv[0] || 'status';
  if (!COMMANDS.includes(command)) throw new Error('不支持的迁移命令');
  const values = {};
  for (const arg of argv.slice(1)) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || !OPTIONS.includes(match[1]) || values[match[1]] !== undefined)
      throw new Error('迁移参数无效或重复');
    values[match[1]] = match[2];
  }
  const bounds = policy.retention();
  const first = values.first ? policy.date(values.first) : bounds.first;
  const last = values.last ? policy.date(values.last) : bounds.today;
  if (first > last) throw new Error('日期范围无效');
  if (
    ['shadow', 'backfill', 'verify', 'read-switch', 'revert'].includes(command) &&
    (values.first || values.last)
  )
    throw new Error('迁移和切换必须覆盖整个保留窗口，只有 retire 支持限定日期');
  if (command === 'retire' && (!values.first || !values.last || values['confirm-retire'] !== 'yes'))
    throw new Error('回收旧副本必须明确日期范围和 --confirm-retire=yes');
  if (command !== 'retire' && values['confirm-retire'])
    throw new Error('回收确认参数仅适用于 retire');
  if (values['reset-verify'] && (command !== 'verify' || values['reset-verify'] !== 'yes'))
    throw new Error('完整重校验参数仅支持 verify --reset-verify=yes');
  if (
    command === 'finalize' &&
    (values['confirm-finalize'] !== 'yes' || values['all-api-upgraded'] !== 'yes')
  )
    throw new Error('全局收尾要求 --confirm-finalize=yes --all-api-upgraded=yes');
  if (command !== 'finalize' && (values['confirm-finalize'] || values['all-api-upgraded']))
    throw new Error('收尾确认参数仅适用于 finalize');
  if (command === 'rollback-default' && values['confirm-default-rollback'] !== 'yes')
    throw new Error('全局默认回退要求 --confirm-default-rollback=yes');
  if (command !== 'rollback-default' && values['confirm-default-rollback'])
    throw new Error('默认回退确认参数仅适用于 rollback-default');
  if (
    ['finalize', 'rollback-default'].includes(command) &&
    (values.device || values.instance || values.first || values.last)
  )
    throw new Error('全局收尾与默认回退不能指定实例或日期范围');
  return {
    command,
    resetVerify: values['reset-verify'] === 'yes',
    deviceId: ['finalize', 'rollback-default'].includes(command)
      ? undefined
      : p.uuid(values.device).toLowerCase(),
    localId: ['finalize', 'rollback-default'].includes(command)
      ? undefined
      : p.uuid(values.instance).toLowerCase(),
    first,
    last,
    batchSize: integerOption(values['batch-size'], DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
    maxBatches: integerOption(values['max-batches'], DEFAULT_MAX_BATCHES, MAX_BATCH_SIZE),
    budgetMs: integerOption(values['budget-ms'], DEFAULT_BUDGET_MS, MAX_BUDGET_MS),
  };
}
function integerOption(value, fallback, max) {
  if (value !== undefined && !/^\d+$/.test(value)) throw new Error('预算参数必须是正整数');
  return p.integer(value === undefined ? fallback : Number(value), 1, max);
}

/** 将旧表原始列转换为不可变块载荷，保留历史摘要与时间。 @param {Object} row 原始行 @returns {Object} 行 */
function legacyRow(row) {
  const mappings = {
    deviceId: 'device_id',
    localId: 'local_id',
    fileId: 'file_id',
    fileName: 'file_name',
    businessDate: 'business_date',
    loggedAt: 'logged_at',
    sortAt: 'sort_at',
    accountNumber: 'account_number',
    lineNumber: 'line_number',
    partIndex: 'part_index',
    byteOffset: 'byte_offset',
    rawBase64: 'raw_base64',
    parseState: 'parse_state',
    payloadHash: 'payload_hash',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  };
  const result = { id: row.id, message: row.message };
  for (const [key, column] of Object.entries(mappings))
    result[key] = row[key] ?? row[column] ?? null;
  return result;
}

function canonical(row) {
  const value = legacyRow(row);
  for (const key of ['loggedAt', 'sortAt', 'createdAt', 'updatedAt'])
    if (value[key]) value[key] = new Date(value[key]).toISOString();
  for (const key of ['lineNumber', 'partIndex', 'byteOffset']) value[key] = String(value[key]);
  return JSON.stringify(value);
}
function databaseRow(row) {
  const value = legacyRow(row);
  const result = {};
  for (const [key, item] of Object.entries(value))
    result[key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)] = item;
  return result;
}

/** 创建有界、可重启迁移执行器。 @param {Object} dependencies 数据库与块存储 @returns {Object} 执行器 */
function createMigration({ sequelize, store }) {
  const scopeSql = alias => `${alias}.device_id = :deviceId AND ${alias}.local_id = :localId
    AND ${alias}.business_date BETWEEN :first::date AND :last::date`;
  async function query(sql, options, transaction) {
    try {
      return await sequelize.query(sql, {
        replacements: options,
        transaction,
        type: QueryTypes.SELECT,
      });
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  async function lockDevice(options, transaction) {
    try {
      const devices = await query(
        'SELECT id FROM aos_devices WHERE id = :deviceId FOR UPDATE',
        options,
        transaction
      );
      if (!devices.length) throw new Error('迁移设备不存在');
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  async function mode(options, transaction, locked = false) {
    try {
      if (locked)
        await sequelize.query(
          `INSERT INTO monitor_log_storage_scopes(device_id,local_id)
        VALUES(:deviceId,:localId) ON CONFLICT DO NOTHING`,
          { replacements: options, transaction }
        );
      const states = await query(
        `SELECT mode,generation FROM monitor_log_storage_scopes
        WHERE device_id=:deviceId AND local_id=:localId ${locked ? 'FOR UPDATE' : ''}`,
        options,
        transaction
      );
      return states[0] || { mode: 'rows', generation: 0 };
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  async function setMode(options, target, transaction) {
    try {
      return await sequelize.query(
        `UPDATE monitor_log_storage_scopes SET mode=:target,
        generation=generation+1,updated_at=now(),verified_at=CASE WHEN :target = 'blocks' THEN now() ELSE verified_at END
        WHERE device_id=:deviceId AND local_id=:localId`,
        { replacements: { ...options, target }, transaction }
      );
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  function progressName(options) {
    return migrationProgressName(options.deviceId, options.localId);
  }
  async function progress(options, transaction) {
    try {
      const rows = await query(
        'SELECT value FROM monitor_log_storage_metrics WHERE name=:name',
        { name: progressName(options) },
        transaction
      );
      const saved = rows[0]?.value || {};
      if (typeof saved.backfillCursor === 'string') {
        saved.backfillCursor = null;
        saved.backfillComplete = false;
      }
      return {
        backfillCursor: null,
        backfillComplete: false,
        verifiedBlockId: '0',
        verifiedEntries: 0,
        digest: '',
        ...saved,
      };
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  async function saveProgress(options, value, transaction) {
    try {
      await sequelize.query(
        `INSERT INTO monitor_log_storage_metrics(name,value) VALUES(:name,:value::jsonb)
        ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=now()`,
        {
          replacements: { name: progressName(options), value: JSON.stringify(value) },
          transaction,
        }
      );
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  async function copyBatch(options, transaction) {
    try {
      const current = await progress(options, transaction);
      if (current.backfillComplete) return 0;
      const anchor = current.backfillCursor;
      let afterClause = '';
      if (anchor)
        afterClause =
          'AND (e.business_date,e.sort_at,e.file_id,e.byte_offset) > ' +
          '(:afterDate::date,:afterAt::timestamptz,:afterFile::uuid,:afterOffset::bigint)';
      const rows = await query(
        `SELECT e.* FROM monitor_log_entries e WHERE ${scopeSql('e')}
        ${afterClause}
        ORDER BY e.business_date,e.sort_at,e.file_id,e.byte_offset LIMIT :batchSize`,
        {
          ...options,
          afterDate: anchor?.businessDate,
          afterAt: anchor?.sortAt,
          afterFile: anchor?.fileId,
          afterOffset: anchor?.byteOffset,
        },
        transaction
      );
      if (rows.length) await store.append(rows.map(legacyRow), transaction);
      let nextCursor = current.backfillCursor;
      if (rows.length) {
        const last = rows[rows.length - 1];
        nextCursor = {
          businessDate: last.business_date,
          sortAt: new Date(last.sort_at).toISOString(),
          fileId: last.file_id,
          byteOffset: String(last.byte_offset),
        };
      }
      await saveProgress(
        options,
        { ...current, backfillCursor: nextCursor, backfillComplete: rows.length === 0 },
        transaction
      );
      return rows.length;
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  async function restoreBatch(options, transaction) {
    try {
      const current = await progress(options, transaction);
      const candidates = await query(
        `SELECT b.* FROM monitor_log_blocks b WHERE ${scopeSql('b')}
        AND b.id > :after::bigint ORDER BY b.id LIMIT :blockLimit`,
        {
          ...options,
          after: current.restoreBlockId || '0',
          blockLimit: options.blockLimit || Math.min(options.batchSize, 10),
        },
        transaction
      );
      let restored = 0;
      let digest = current.restoreDigest || '';
      for (const block of candidates) {
        await compareBlock(block, options, transaction, false);
        const decoded = await store.readBlock(block);
        const old = await query(
          'SELECT id FROM monitor_log_entries WHERE id IN (:ids)',
          { ids: decoded.map(row => row.id) },
          transaction
        );
        const existing = new Set(old.map(row => row.id));
        const receipts = await query(
          `SELECT id,encode(payload_hash,'hex') AS hash FROM monitor_log_receipts
          WHERE business_date=:date::date AND block_id=:blockId`,
          { date: block.business_date, blockId: block.id },
          transaction
        );
        const hashes = new Map(receipts.map(row => [row.id, row.hash]));
        const rows = decoded
          .filter(row => !existing.has(row.id))
          .map(row => ({ ...row, payloadHash: hashes.get(row.id) }));
        if (rows.length)
          await query(
            "SELECT set_config('apple.monitor_log_restore', 'verified', true)",
            {},
            transaction
          );
        if (rows.length)
          await sequelize
            .getQueryInterface()
            .bulkInsert('monitor_log_entries', rows.map(databaseRow), { transaction });
        restored += rows.length;
        digest = createHash('sha256')
          .update(
            `${digest}:${block.id}:${block.payload_hash.toString('hex')}:${block.entry_count}`
          )
          .digest('hex');
      }
      if (candidates.length)
        await saveProgress(
          options,
          {
            ...current,
            restoreBlockId: String(candidates[candidates.length - 1].id),
            restoreDigest: digest,
            restoredEntries: (current.restoredEntries || 0) + restored,
          },
          transaction
        );
      return candidates.length;
    } catch (error) {
      logger.debug('日志恢复步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  function boundMatches(directory, prefix, row) {
    return (
      new Date(directory[`${prefix}_sort_at`]).getTime() === new Date(row.sortAt).getTime() &&
      directory[`${prefix}_file_id`] === row.fileId &&
      String(directory[`${prefix}_byte_offset`]) === String(row.byteOffset)
    );
  }
  async function verifyDirectory(block, decoded, transaction) {
    try {
      const sorted = [...decoded].sort(store.compare);
      if (
        !sorted.length ||
        !boundMatches(block, 'min', sorted[0]) ||
        !boundMatches(block, 'max', sorted[sorted.length - 1])
      )
        throw new Error('日志块排序边界不一致');
      if (block.signature !== store.signature(decoded.map(row => row.message)))
        throw new Error('日志块关键词签名不一致');
      const files = await query(
        'SELECT device_id,file_id FROM monitor_log_files WHERE id=:fileKey',
        { fileKey: block.file_key },
        transaction
      );
      if (
        files.length !== 1 ||
        files[0].device_id !== block.device_id ||
        sorted.some(row => row.fileId !== files[0].file_id)
      )
        throw new Error('日志文件目录不一致');
      const accounts = await query(
        `SELECT * FROM monitor_log_block_accounts
        WHERE business_date=:date::date AND block_id=:blockId`,
        { date: block.business_date, blockId: block.id },
        transaction
      );
      const members = new Map();
      for (const row of sorted) {
        const account = row.accountNumber || '';
        if (!members.has(account)) members.set(account, []);
        members.get(account).push(row);
      }
      const byAccount = new Map(accounts.map(row => [row.account_number, row]));
      if (accounts.length !== members.size || byAccount.size !== members.size)
        throw new Error('日志账号目录成员不一致');
      for (const [account, rows] of members) {
        const directory = byAccount.get(account);
        if (
          !directory ||
          directory.device_id !== block.device_id ||
          directory.local_id !== block.local_id ||
          !boundMatches(directory, 'min', rows[0]) ||
          !boundMatches(directory, 'max', rows[rows.length - 1])
        )
          throw new Error('日志账号目录排序边界不一致');
      }
    } catch (error) {
      logger.debug('日志目录校验失败', { errorCode: error.name });
      throw error;
    }
  }
  async function compareBlock(block, options, transaction, requireOldComplete) {
    try {
      const decoded = await store.readBlock(block);
      await verifyDirectory(block, decoded, transaction);
      const receipts = await query(
        `SELECT id,file_key,byte_offset,encode(payload_hash,'hex') AS hash,ordinal
        FROM monitor_log_receipts WHERE business_date=:date::date AND block_id=:blockId`,
        { date: block.business_date, blockId: block.id },
        transaction
      );
      if (receipts.length !== decoded.length || decoded.length !== block.entry_count)
        throw new Error('日志块片段数或回执数量不一致');
      const byOrdinal = new Map(receipts.map(row => [row.ordinal, row]));
      if (byOrdinal.size !== decoded.length) throw new Error('日志块回执序号重复');
      let old = [];
      if (decoded.length)
        old = await query(
          'SELECT * FROM monitor_log_entries WHERE id IN (:ids)',
          { ids: decoded.map(row => row.id) },
          transaction
        );
      const byId = new Map(old.map(row => [row.id, legacyRow(row)]));
      for (let ordinal = 0; ordinal < decoded.length; ordinal += 1) {
        const row = decoded[ordinal];
        const receipt = byOrdinal.get(ordinal);
        if (
          !receipt ||
          receipt.id !== row.id ||
          String(receipt.file_key) !== String(block.file_key) ||
          String(receipt.byte_offset) !== String(row.byteOffset) ||
          row.deviceId !== options.deviceId ||
          row.localId !== options.localId ||
          row.businessDate !== block.business_date
        )
          throw new Error('日志回执定位或载荷摘要不一致');
        const previous = byId.get(row.id);
        if (requireOldComplete && !previous) throw new Error('旧表片段缺失');
        if (previous && canonical(previous) !== canonical({ ...row, payloadHash: receipt.hash }))
          throw new Error('压缩副本与旧表原始载荷不一致');
      }
      return decoded.length;
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  async function verifyBatch(options, transaction, complete = true) {
    try {
      const started = Date.now();
      const current = await progress(options, transaction);
      const candidates = await query(
        `SELECT b.* FROM monitor_log_blocks b WHERE ${scopeSql('b')}
        AND b.id > :after::bigint ORDER BY b.id LIMIT :blockLimit`,
        {
          ...options,
          after: current.verifiedBlockId,
          blockLimit: options.blockLimit || Math.min(options.batchSize, 20),
        },
        transaction
      );
      let entries = 0;
      let digest = current.digest;
      for (const block of candidates) {
        if (Date.now() - started >= options.budgetMs) throw new Error('校验超过预算');
        entries += await compareBlock(block, options, transaction, complete);
        digest = createHash('sha256')
          .update(
            `${digest}:${block.id}:${block.payload_hash.toString('hex')}:${block.entry_count}`
          )
          .digest('hex');
      }
      if (candidates.length)
        await saveProgress(
          options,
          {
            ...current,
            verifiedBlockId: String(candidates[candidates.length - 1].id),
            verifiedEntries: current.verifiedEntries + entries,
            digest,
          },
          transaction
        );
      return {
        blocks: candidates.length,
        entries,
        complete: candidates.length === 0,
        verifiedBlockId: candidates.length
          ? String(candidates[candidates.length - 1].id)
          : current.verifiedBlockId,
        digest,
      };
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  async function transactionBatch(options, action) {
    try {
      return await sequelize.transaction(async transaction => {
        try {
          await query(
            "SELECT set_config('statement_timeout', :statementTimeout, true), set_config('lock_timeout', '5000', true)",
            { ...options, statementTimeout: String(options.budgetMs) },
            transaction
          );
          await lockDevice(options, transaction);
          const state = await mode(options, transaction, true);
          if (
            !['revert', 'abort-maintenance'].includes(options.command) &&
            (await progress(options, transaction)).maintenance
          )
            throw new Error('恢复维护未结束，仅可继续 revert 或 abort-maintenance');
          return await action(transaction, state);
        } catch (error) {
          logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  async function runBounded(options, action) {
    try {
      const started = Date.now();
      let processed = 0;
      let batches = 0;
      let complete = false;
      while (batches < options.maxBatches && Date.now() - started < options.budgetMs) {
        const count = await action();
        batches += 1;
        processed += count;
        if (count === 0) {
          complete = true;
          break;
        }
      }
      return { processed, batches, complete, elapsedMs: Date.now() - started };
    } catch (error) {
      logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
      throw error;
    }
  }
  async function finalize(_options) {
    try {
      return await sequelize.transaction(async transaction => {
        try {
          await query(
            "SELECT set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true)",
            {},
            transaction
          );
          await query('SELECT id FROM aos_devices ORDER BY id FOR UPDATE', {}, transaction);
          await sequelize.query('LOCK TABLE monitor_log_entries IN ACCESS EXCLUSIVE MODE', {
            transaction,
          });
          if ((await query('SELECT 1 FROM monitor_log_entries LIMIT 1', {}, transaction)).length)
            throw new Error('旧表仍有片段，禁止全局收尾和 TRUNCATE');
          const unverified = await query(
            `WITH live AS (
            SELECT device_id,local_id,max(id) AS tip FROM monitor_log_blocks
            WHERE business_date >= :first::date GROUP BY device_id,local_id)
            SELECT 1 FROM live b LEFT JOIN monitor_log_storage_scopes s
              ON s.device_id=b.device_id AND s.local_id=b.local_id
            LEFT JOIN monitor_log_storage_metrics m ON m.name='migration:'||b.device_id::text||':'||b.local_id::text
            WHERE s.mode IS DISTINCT FROM 'blocks'
              OR m.value->>'switchedComplete' IS DISTINCT FROM 'true'
              OR coalesce((m.value->>'switchedGeneration')::integer,-1) <> s.generation
              OR coalesce((m.value->>'verifiedBlockId')::bigint,0) < b.tip LIMIT 1`,
            { first: policy.retention().first },
            transaction
          );
          if (unverified.length) throw new Error('活跃压缩范围未完成当前代次认证，禁止全局收尾');
          const [before] = await query(
            "SELECT pg_total_relation_size('monitor_log_entries')::text AS bytes",
            {},
            transaction
          );
          await sequelize.query(
            `INSERT INTO monitor_log_storage_metrics(name,value)
            VALUES('storage-default','{"mode":"blocks"}'::jsonb)
            ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=now()`,
            { transaction }
          );
          await sequelize.query(
            `UPDATE monitor_log_storage_scopes SET mode='blocks',
            generation=generation+1,updated_at=now() WHERE mode<>'blocks'`,
            { transaction }
          );
          await sequelize.query('TRUNCATE monitor_log_entries', { transaction });
          const [after] = await query(
            "SELECT pg_total_relation_size('monitor_log_entries')::text AS bytes",
            {},
            transaction
          );
          return {
            mode: 'blocks',
            finalized: true,
            oldBytesBefore: before.bytes,
            oldBytesAfter: after.bytes,
            releasedBytes: String(BigInt(before.bytes) - BigInt(after.bytes)),
          };
        } catch (error) {
          logger.warn('日志存储全局收尾失败', { errorCode: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.debug('日志收尾事务失败', { errorCode: error.name });
      throw error;
    }
  }
  async function rollbackDefault() {
    try {
      return await sequelize.transaction(async transaction => {
        try {
          await query(
            "SELECT set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true)",
            {},
            transaction
          );
          await query('SELECT id FROM aos_devices ORDER BY id FOR UPDATE', {}, transaction);
          await sequelize.query('LOCK TABLE monitor_log_entries IN ACCESS EXCLUSIVE MODE', {
            transaction,
          });
          const invalid = await query(
            "SELECT 1 FROM monitor_log_storage_scopes WHERE mode <> 'rows' LIMIT 1",
            {},
            transaction
          );
          if (invalid.length) throw new Error('仍有块或影子实例，禁止回退默认模式');
          const uncertified = await query(
            `SELECT 1 FROM monitor_log_blocks b
            LEFT JOIN monitor_log_storage_scopes s ON s.device_id=b.device_id AND s.local_id=b.local_id
            LEFT JOIN monitor_log_storage_metrics m ON m.name='migration:'||b.device_id::text||':'||b.local_id::text
            WHERE b.business_date >= :first::date AND (s.mode IS DISTINCT FROM 'rows' OR m.value->>'restoredComplete' IS DISTINCT FROM 'true'
              OR coalesce((m.value->>'restoredBlockId')::bigint,0) < b.id) LIMIT 1`,
            { first: policy.retention().first },
            transaction
          );
          if (uncertified.length) throw new Error('压缩日志尚无完整恢复认证，禁止回退默认模式');
          await sequelize.query(
            `INSERT INTO monitor_log_storage_metrics(name,value)
            VALUES('storage-default','{"mode":"rows"}'::jsonb)
            ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=now()`,
            { transaction }
          );
          return { mode: 'rows', defaultRolledBack: true };
        } catch (error) {
          logger.warn('日志默认模式回退失败', { errorCode: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.debug('日志默认回退事务失败', { errorCode: error.name });
      throw error;
    }
  }
  async function execute(options) {
    try {
      if (options.command === 'finalize') return await finalize(options);
      if (options.command === 'rollback-default') return await rollbackDefault();
      if (options.command === 'status') {
        const state = await mode(options);
        const [counts] = await query(
          `SELECT
          (SELECT count(*) FROM monitor_log_entries e WHERE ${scopeSql('e')}) AS old_count,
          (SELECT coalesce(sum(entry_count),0) FROM monitor_log_blocks b WHERE ${scopeSql('b')}) AS block_count,
          (SELECT count(*) FROM monitor_log_entries e WHERE ${scopeSql('e')}
            AND NOT EXISTS(SELECT 1 FROM monitor_log_receipts r WHERE r.id=e.id)) AS pending`,
          options
        );
        return { ...state, counts, progress: await progress(options) };
      }
      if (options.command === 'verify') {
        if (options.resetVerify)
          await sequelize.transaction(async transaction => {
            try {
              const current = await progress(options, transaction);
              if (current.maintenance) throw new Error('恢复维护期间禁止重新认证或回收旧副本');
              await saveProgress(
                options,
                { ...current, verifiedBlockId: '0', verifiedEntries: 0, digest: '' },
                transaction
              );
            } catch (error) {
              logger.debug('完整重校验初始化失败', { errorCode: error.name });
              throw error;
            }
          });
        return await runBounded(options, () =>
          sequelize.transaction(async transaction => {
            try {
              const state = await mode(options, transaction);
              const current = await progress(options, transaction);
              if (current.maintenance) throw new Error('恢复维护期间禁止重新认证或回收旧副本');
              if (current.verifiedGeneration !== state.generation)
                await saveProgress(
                  options,
                  {
                    ...invalidateStorageCertification(current),
                    verifiedGeneration: state.generation,
                  },
                  transaction
                );
              const result = await verifyBatch(options, transaction, state.mode !== 'blocks');
              if (state.mode === 'blocks' && result.complete) {
                const certified = await progress(options, transaction);
                await saveProgress(
                  options,
                  {
                    ...certified,
                    verifiedGeneration: state.generation,
                    switchedComplete: true,
                    switchedGeneration: state.generation,
                  },
                  transaction
                );
              }
              return result.blocks;
            } catch (error) {
              logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
              throw error;
            }
          })
        );
      }
      if (options.command === 'abort-maintenance') {
        return await transactionBatch(options, async (transaction, state) => {
          try {
            if (state.mode !== 'blocks') throw new Error('终止恢复维护仅适用于 blocks 模式');
            const current = await progress(options, transaction);
            if (current.maintenance?.kind && current.maintenance.kind !== 'revert')
              throw new Error('不支持的维护类型');
            const cleared = invalidateStorageCertification(current);
            delete cleared.maintenance;
            await saveProgress(options, cleared, transaction);
            return { mode: 'blocks', maintenanceAborted: true, partialLegacyPreserved: true };
          } catch (error) {
            logger.debug('恢复维护终止失败', { errorCode: error.name });
            throw error;
          }
        });
      }
      if (['shadow', 'abort'].includes(options.command)) {
        return await transactionBatch(options, async (transaction, state) => {
          try {
            if (state.mode === 'blocks') throw new Error('块读取模式必须使用 revert 恢复旧写入');
            const target = options.command === 'shadow' ? 'shadow' : 'rows';
            await setMode(options, target, transaction);
            if (state.mode !== target) await saveProgress(options, {}, transaction);
            return { mode: target };
          } catch (error) {
            logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
            throw error;
          }
        });
      }
      if (options.command === 'backfill') {
        return await runBounded(options, () =>
          transactionBatch(options, async (transaction, state) => {
            try {
              if (state.mode !== 'shadow') throw new Error('历史补齐要求 shadow 模式');
              return await copyBatch(options, transaction);
            } catch (error) {
              logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
              throw error;
            }
          })
        );
      }
      if (options.command === 'read-switch') {
        const finalOptions = {
          ...options,
          budgetMs: Math.min(options.budgetMs, 5000),
          blockLimit: 4,
        };
        return await transactionBatch(finalOptions, async (transaction, state) => {
          try {
            if (state.mode === 'blocks') return { mode: 'blocks', alreadySwitched: true };
            if (state.mode !== 'shadow') throw new Error('切读要求 shadow 模式');
            const current = await progress(options, transaction);
            if (!current.backfillComplete) throw new Error('历史遍历尚未完成，请继续 backfill');
            const verified = await verifyBatch(finalOptions, transaction, true);
            const tail = await query(
              `SELECT 1 FROM monitor_log_blocks b WHERE ${scopeSql('b')}
              AND b.id > :after::bigint LIMIT 1`,
              { ...options, after: verified.verifiedBlockId },
              transaction
            );
            if (tail.length) throw new Error('校验积压超过切换预算，请继续 verify');
            await setMode(options, 'blocks', transaction);
            const certified = await progress(options, transaction);
            await saveProgress(
              options,
              {
                ...certified,
                switchedComplete: true,
                switchedGeneration: state.generation + 1,
                verifiedGeneration: state.generation + 1,
              },
              transaction
            );
            return { mode: 'blocks', verified };
          } catch (error) {
            logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
            throw error;
          }
        });
      }
      if (options.command === 'revert') {
        await transactionBatch(options, async (transaction, state) => {
          try {
            if (state.mode !== 'blocks') throw new Error('revert 仅适用于 blocks 模式');
            const current = await progress(options, transaction);
            if (current.maintenance) {
              if (
                current.maintenance.kind !== 'revert' ||
                current.maintenance.generation !== state.generation
              )
                throw new Error('恢复维护类型或存储代次变化，停止恢复');
              return;
            }
            await saveProgress(
              options,
              {
                ...invalidateStorageCertification(current),
                maintenance: {
                  kind: 'revert',
                  generation: state.generation,
                  startedAt: new Date().toISOString(),
                },
              },
              transaction
            );
          } catch (error) {
            logger.debug('恢复维护登记失败', { errorCode: error.name });
            throw error;
          }
        });
        const restoreProgress = await runBounded(options, () =>
          transactionBatch(options, async (transaction, state) => {
            try {
              if (state.mode !== 'blocks') throw new Error('revert 仅适用于 blocks 模式');
              return await restoreBatch(options, transaction);
            } catch (error) {
              logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
              throw error;
            }
          })
        );
        if (!restoreProgress.complete) return { mode: 'blocks', ...restoreProgress };
        return await transactionBatch(
          { ...options, budgetMs: Math.min(options.budgetMs, 5000) },
          async (transaction, state) => {
            try {
              if (state.mode !== 'blocks') throw new Error('回滚期间存储模式改变');
              const restored = await restoreBatch({ ...options, blockLimit: 4 }, transaction);
              const current = await progress(options, transaction);
              const outstanding = await query(
                `SELECT 1 FROM monitor_log_blocks b WHERE ${scopeSql('b')}
              AND b.id > :after::bigint LIMIT 1`,
                { ...options, after: current.restoreBlockId || '0' },
                transaction
              );
              if (outstanding.length) throw new Error('新增日志回滚积压超过最后切换预算');
              const verified = { restored: true, restoredEntries: current.restoredEntries || 0 };
              await setMode(options, 'rows', transaction);
              await saveProgress(
                options,
                {
                  restoredComplete: true,
                  restoredBlockId: current.restoreBlockId || '0',
                  restoredEntries: current.restoredEntries || 0,
                  restoreDigest: current.restoreDigest || '',
                  restoredAt: new Date().toISOString(),
                },
                transaction
              );
              return { mode: 'rows', ...restoreProgress, finalRestored: restored, verified };
            } catch (error) {
              logger.debug('日志迁移步骤未完成', { errorCode: error.code || error.name });
              throw error;
            }
          }
        );
      }
      if (options.command === 'retire') {
        let deleted = 0;
        const retired = await runBounded(options, () =>
          transactionBatch(options, async (transaction, state) => {
            try {
              if (state.mode !== 'blocks') throw new Error('回收旧副本要求 blocks 模式');
              const current = await progress(options, transaction);
              const after =
                current.retireFirst === options.first && current.retireLast === options.last
                  ? current.retireBlockId || '0'
                  : '0';
              const candidates = await query(
                `SELECT b.* FROM monitor_log_blocks b WHERE ${scopeSql('b')}
              AND b.id > :after::bigint ORDER BY b.id LIMIT :blockLimit`,
                { ...options, after, blockLimit: Math.min(options.batchSize, 10) },
                transaction
              );
              let removed = 0;
              for (const block of candidates) {
                await compareBlock(block, options, transaction, false);
                const ids = (await store.readBlock(block)).map(row => row.id);
                const old = await query(
                  'SELECT id FROM monitor_log_entries WHERE id IN (:ids)',
                  { ids },
                  transaction
                );
                if (old.length)
                  await sequelize.query('DELETE FROM monitor_log_entries WHERE id IN (:ids)', {
                    replacements: { ids: old.map(row => row.id) },
                    transaction,
                  });
                removed += old.length;
              }
              if (candidates.length)
                await saveProgress(
                  options,
                  {
                    ...current,
                    retireFirst: options.first,
                    retireLast: options.last,
                    retireBlockId: String(candidates[candidates.length - 1].id),
                  },
                  transaction
                );
              deleted += removed;
              return candidates.length;
            } catch (error) {
              logger.debug('旧副本回收未完成', { errorCode: error.code || error.name });
              throw error;
            }
          })
        );
        return { ...retired, blocks: retired.processed, processed: deleted };
      }
      throw new Error('不支持的迁移命令');
    } catch (error) {
      logger.warn('日志迁移操作失败', {
        command: options.command,
        errorCode: error.code || error.name,
      });
      throw error;
    }
  }
  async function releaseSession(connection, acquired) {
    try {
      if (acquired) await connection.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
      await sequelize.connectionManager.releaseConnection(connection);
    } catch (error) {
      await sequelize.connectionManager.destroyConnection(connection);
      throw error;
    }
  }
  /** 持有独立数据库会话锁，防止多个CLI并行切换。 @param {Object} options 范围 @returns {Promise<Object>} 结果 */
  async function run(options) {
    let connection;
    let acquired = false;
    try {
      connection = await sequelize.connectionManager.getConnection({ type: 'WRITE' });
      const result = await connection.query('SELECT pg_try_advisory_lock($1) AS acquired', [
        MIGRATION_LOCK,
      ]);
      acquired = result.rows[0].acquired;
      if (!acquired) throw new Error('另一日志迁移任务正在运行');
      return await execute(options);
    } finally {
      if (connection) await releaseSession(connection, acquired);
    }
  }
  return { run };
}

async function main() {
  let sequelize;
  try {
    const options = parseOptions(process.argv.slice(2));
    ({ sequelize } = require('../src/models'));
    const store = require('../src/services/monitorLogBlockStore');
    await sequelize.authenticate();
    const result = await createMigration({ sequelize, store }).run(options);
    process.stdout.write(
      `${JSON.stringify({ command: options.command, ...result }, null, JSON_INDENT)}\n`
    );
  } catch (error) {
    const message =
      /^Sequelize/.test(error.name) || /^[0-9A-Z]{5}$/.test(error.code || '')
        ? '数据库操作失败，迁移未完成，请查看脱敏错误码并重试'
        : error.message;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    if (sequelize) await sequelize.close();
  }
}
if (require.main === module) main();
module.exports = { parseOptions, legacyRow, createMigration };
