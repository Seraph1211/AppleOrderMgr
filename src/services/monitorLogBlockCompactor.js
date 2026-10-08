/* eslint camelcase: ["error", {"properties": "never"}] */
const { QueryTypes } = require('sequelize');
const { isDeepStrictEqual } = require('util');
const { sequelize } = require('../models');
const store = require('./monitorLogBlockStore');
const repeatFilter = require('./monitorLogRepeatFilter');
const policy = require('./monitorLogPolicy');
const logger = require('../utils/logger');
const {
  MIGRATION_LOCK,
  migrationProgressName,
  invalidateStorageCertification,
} = require('./monitorLogStorageCoordination');
const MAX_RAW_BYTES = 4 * 1024 * 1024;

function bounds(value, fallback, maximum) {
  return Math.max(1, Math.min(maximum, Number(value) || fallback));
}
function boundaryMatches(directory, prefix, row) {
  return (
    new Date(directory[`${prefix}_sort_at`]).getTime() === new Date(row.sortAt).getTime() &&
    directory[`${prefix}_file_id`] === row.fileId &&
    String(directory[`${prefix}_byte_offset`]) === String(row.byteOffset)
  );
}
async function query(sql, replacements, transaction) {
  try {
    return await sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
  } catch (error) {
    logger.debug('日志压实步骤未完成', {
      errorCode: error.original?.code || error.code || error.name,
    });
    throw error;
  }
}
async function candidate(options) {
  try {
    return await sequelize.transaction(async transaction => {
      try {
        await query('SET TRANSACTION READ ONLY', {}, transaction);
        await query(
          "SELECT set_config('statement_timeout', :timeout, true)",
          { timeout: String(options.candidateBudgetMs || 1000) },
          transaction
        );
        const groups = await query(
          `SELECT b.device_id AS "deviceId",b.local_id AS "localId",b.business_date AS day,
            b.file_key AS "fileKey",b.file_name AS "fileName",count(*)::text AS "groupBlocks",
            sum(count(*)) OVER()::text AS "eligibleBlocks"
           FROM monitor_log_blocks b JOIN monitor_log_storage_scopes s
             ON s.device_id=b.device_id AND s.local_id=b.local_id AND s.mode='blocks'
           LEFT JOIN monitor_log_storage_metrics m
             ON m.name='migration:'||b.device_id::text||':'||b.local_id::text
           WHERE b.business_date>=:first::date AND b.business_date <= :today::date
             AND b.raw_bytes < :smallBytes AND b.entry_count<=:maxSourceEntries
             AND m.value->'maintenance' IS NULL
           GROUP BY b.device_id,b.local_id,b.business_date,b.file_key,b.file_name
           HAVING count(*)>1 ORDER BY b.business_date DESC,count(*) DESC LIMIT 1`,
          options,
          transaction
        );
        return groups[0] || null;
      } catch (error) {
        logger.debug('日志压实候选扫描未完成', {
          errorCode: error.original?.code || error.code || error.name,
        });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('日志压实候选事务未完成', {
      errorCode: error.original?.code || error.code || error.name,
    });
    throw error;
  }
}
async function validateSources(blocks, transaction, deadline) {
  try {
    const receipts = await query(
      `SELECT * FROM monitor_log_receipts WHERE business_date=:day::date
         AND block_id IN (:ids) FOR UPDATE`,
      { day: blocks[0].business_date, ids: blocks.map(block => block.id) },
      transaction
    );
    const bySlot = new Map();
    const directories = await query(
      'SELECT * FROM monitor_log_block_accounts WHERE business_date=:day::date AND block_id IN (:ids)',
      { day: blocks[0].business_date, ids: blocks.map(block => block.id) },
      transaction
    );
    const directoriesByBlock = new Map();
    for (const item of directories) {
      if (!directoriesByBlock.has(String(item.block_id)))
        directoriesByBlock.set(String(item.block_id), []);
      directoriesByBlock.get(String(item.block_id)).push(item);
    }
    for (const receipt of receipts) {
      const slot = `${receipt.block_id}:${receipt.ordinal}`;
      if (bySlot.has(slot)) throw new Error('日志压实重复回执序号');
      bySlot.set(slot, receipt);
    }
    const rows = [];
    for (const block of blocks) {
      if (Date.now() >= deadline) throw new Error('日志压实校验超过预算');
      if (block.file_device_id !== block.device_id) throw new Error('日志压实文件目录不一致');
      const decoded = await store.readBlock(block);
      if (block.repeat_type != null && block.repeat_type !== 'object')
        throw new Error('日志压实来源周期证据类型无效');
      if (
        block.repeat_limits != null &&
        !isDeepStrictEqual(
          block.repeat_limits,
          repeatFilter.repeatLimits(decoded.map(row => row.message))
        )
      )
        throw new Error('日志压实来源周期证据不一致');
      const sorted = [...decoded].sort(store.compare);
      if (
        !boundaryMatches(block, 'min', sorted[0]) ||
        !boundaryMatches(block, 'max', sorted.at(-1)) ||
        store.signature(decoded.map(row => row.message)) !== block.signature
      )
        throw new Error('日志压实来源块边界不一致');
      const accounts = new Map();
      for (let ordinal = 0; ordinal < decoded.length; ordinal++) {
        const row = decoded[ordinal];
        const receipt = bySlot.get(`${block.id}:${ordinal}`);
        if (
          !receipt ||
          receipt.id !== row.id ||
          String(receipt.file_key) !== String(block.file_key) ||
          String(receipt.byte_offset) !== String(row.byteOffset) ||
          !Buffer.isBuffer(receipt.payload_hash) ||
          receipt.payload_hash.length !== 32
        )
          throw new Error('日志压实来源回执不一致');
        // Protocol digest may predate UTF-8 normalization or omitted legacy contextAt.
        row.payloadHash = receipt.payload_hash.toString('hex');
        row.fileKey = block.file_key;
        row.sourceBlockId = block.id;
        const account = row.accountNumber || '';
        if (!accounts.has(account)) accounts.set(account, []);
        accounts.get(account).push(row);
        rows.push(row);
      }
      const directory = directoriesByBlock.get(String(block.id)) || [];
      if (directory.length !== accounts.size) throw new Error('日志压实账号目录数量不一致');
      for (const item of directory) {
        const members = accounts.get(item.account_number)?.sort(store.compare);
        if (
          !members ||
          item.device_id !== block.device_id ||
          item.local_id !== block.local_id ||
          !boundaryMatches(item, 'min', members[0]) ||
          !boundaryMatches(item, 'max', members.at(-1))
        )
          throw new Error('日志压实账号目录边界不一致');
      }
    }
    if (rows.length !== receipts.length || new Set(rows.map(row => row.id)).size !== rows.length)
      throw new Error('日志压实来源片段数量不一致');
    return rows.sort(store.compare);
  } catch (error) {
    logger.debug('日志压实步骤未完成', {
      errorCode: error.original?.code || error.code || error.name,
    });
    throw error;
  }
}

async function compactBatch(group, options) {
  try {
    return await sequelize.transaction(async transaction => {
      try {
        await query(
          "SET LOCAL lock_timeout='250ms'; SET LOCAL statement_timeout='1s'",
          {},
          transaction
        );
        const deadline = Date.now() + options.batchBudgetMs;
        const devices = await query(
          'SELECT id FROM aos_devices WHERE id=:deviceId FOR UPDATE',
          group,
          transaction
        );
        if (!devices.length) return null;
        const scopes = await query(
          `SELECT s.generation,m.value AS progress FROM monitor_log_storage_scopes s
           LEFT JOIN monitor_log_storage_metrics m ON m.name=:progressName
           WHERE s.device_id=:deviceId AND s.local_id=:localId AND s.mode='blocks'
             AND EXISTS(SELECT 1 FROM monitor_log_storage_metrics
               WHERE name='storage-default' AND value->>'mode'='blocks') FOR UPDATE OF s`,
          { ...group, progressName: migrationProgressName(group.deviceId, group.localId) },
          transaction
        );
        const scope = scopes[0];
        if (!scope || scope.progress?.maintenance) return null;
        const candidates = await query(
          `SELECT b.*,jsonb_typeof(b.repeat_limits) AS repeat_type,f.file_id,f.device_id AS file_device_id FROM monitor_log_blocks b
           JOIN monitor_log_files f ON f.id=b.file_key
           WHERE b.device_id=:deviceId AND b.local_id=:localId AND b.business_date=:day::date
             AND b.file_key=:fileKey AND b.file_name=:fileName AND b.raw_bytes < :smallBytes
             AND b.entry_count<=:maxSourceEntries ORDER BY b.id LIMIT :maxSourceBlocks FOR UPDATE OF b`,
          { ...options, ...group },
          transaction
        );
        const selected = [];
        let entries = 0;
        let rawBytes = 0;
        for (const block of candidates) {
          if (
            entries + block.entry_count > options.maxRows ||
            rawBytes + block.raw_bytes > MAX_RAW_BYTES
          )
            break;
          selected.push(block);
          entries += block.entry_count;
          rawBytes += block.raw_bytes;
        }
        if (selected.length < 2) return null;
        const rows = await validateSources(selected, transaction, deadline);
        const chunks = [];
        let chunk = [];
        let bytes = 2;
        for (const row of rows) {
          const size = Buffer.byteLength(store.encodeRow(row)) + 1;
          if (size + 2 > MAX_RAW_BYTES) throw new Error('日志压实单片段超过上限');
          if (chunk.length && bytes + size > options.targetBytes) {
            chunks.push(chunk);
            chunk = [];
            bytes = 2;
          }
          chunk.push(row);
          bytes += size;
        }
        if (chunk.length) chunks.push(chunk);
        // Every successful batch strictly reduces block count, so small reselected blocks converge.
        if (chunks.length >= selected.length) return null;
        const outputs = [];
        for (const members of chunks) {
          if (Date.now() >= deadline) throw new Error('日志压实写入超过预算');
          outputs.push(await store.writeCompactedBlock(members, transaction));
        }
        const left = await query(
          'SELECT 1 FROM monitor_log_receipts WHERE business_date=:day::date AND block_id IN (:ids) LIMIT 1',
          { ...group, ids: selected.map(block => block.id) },
          transaction
        );
        if (left.length) throw new Error('日志压实来源仍有回执');
        const removed = await query(
          'DELETE FROM monitor_log_blocks WHERE business_date=:day::date AND id IN (:ids) RETURNING id',
          { ...group, ids: selected.map(block => block.id) },
          transaction
        );
        if (removed.length !== selected.length) throw new Error('日志压实旧块数量不一致');
        await query(
          `UPDATE monitor_log_storage_scopes SET generation=generation+1,verified_at=NULL,updated_at=now()
           WHERE device_id=:deviceId AND local_id=:localId`,
          group,
          transaction
        );
        await query(
          `INSERT INTO monitor_log_storage_metrics(name,value) VALUES(:name,:value::jsonb)
           ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=now()`,
          {
            name: migrationProgressName(group.deviceId, group.localId),
            value: JSON.stringify(invalidateStorageCertification(scope.progress || {})),
          },
          transaction
        );
        if (Date.now() >= deadline) throw new Error('日志压实提交超过预算');
        return {
          entries,
          sourceBlocks: selected.length,
          targetBlocks: outputs.length,
          targetSmallBlocks: outputs.filter(block => block.rawBytes < options.smallBytes).length,
          payloadBytesBefore: selected.reduce((sum, block) => sum + block.payload.length, 0),
          payloadBytesAfter: outputs.reduce((sum, block) => sum + block.payloadBytes, 0),
        };
      } catch (error) {
        logger.debug('日志压实事务未完成', {
          errorCode: error.original?.code || error.code || error.name,
        });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('日志压实步骤未完成', {
      errorCode: error.original?.code || error.code || error.name,
    });
    throw error;
  }
}

/** 有界当前日及结束日压实；即时上传保持独立可靠提交。 @param {Object} input 内部预算/测试日期 @returns {Promise<Object>} 持久指标 */
async function compact(input = {}) {
  const started = Date.now();
  const result = {
    entries: 0,
    sourceBlocks: 0,
    targetBlocks: 0,
    payloadBytesBefore: 0,
    payloadBytesAfter: 0,
    failedBatches: 0,
    batches: 0,
  };
  let connection;
  let locked = false;
  try {
    const retention = policy.retention();
    const targetBytes = bounds(process.env.MONITOR_LOG_BLOCK_BYTES, 262144, MAX_RAW_BYTES / 2);
    const options = {
      first: policy.date(input.first || retention.first),
      today: policy.date(input.today || retention.today),
      maxRows: Math.max(2, bounds(input.maxRows, 1000, 2000)),
      maxSourceEntries: Math.floor(Math.max(2, bounds(input.maxRows, 1000, 2000)) / 2),
      maxSourceBlocks: bounds(input.maxSourceBlocks, 64, 64),
      maxBatches: bounds(input.maxBatches, 100, 100),
      budgetMs: bounds(input.budgetMs, 5000, 15000),
      batchBudgetMs: bounds(input.batchBudgetMs, 1000, 1000),
      targetBytes: Math.max(32768, targetBytes),
      smallBytes: Math.max(16384, targetBytes / 2),
    };
    const defaults = await query(
      "SELECT 1 FROM monitor_log_storage_metrics WHERE name='storage-default' AND value->>'mode'='blocks'",
      {}
    );
    if (!defaults.length) return { ...result, skipped: true, reason: 'not-finalized' };
    connection = await sequelize.connectionManager.getConnection({ type: 'WRITE' });
    const lock = await connection.query('SELECT pg_try_advisory_lock($1) AS locked', [
      MIGRATION_LOCK,
    ]);
    locked = lock.rows[0].locked;
    if (!locked) return { ...result, skipped: true, reason: 'migration-busy' };
    for (
      let batch = 0;
      batch < options.maxBatches && Date.now() - started < options.budgetMs;
      batch++
    ) {
      if (options.budgetMs - (Date.now() - started) < 250) break;
      const group = await candidate({
        ...options,
        candidateBudgetMs: Math.min(1000, Math.max(1, options.budgetMs - (Date.now() - started))),
      });
      result.eligibleBlocksAtLastCandidate = Number(group?.eligibleBlocks || 0);
      result.remainingEligibleBlocksEstimate = result.eligibleBlocksAtLastCandidate;
      if (!group) break;
      const progress = await compactBatch(group, {
        ...options,
        batchBudgetMs: Math.min(
          options.batchBudgetMs,
          Math.max(1, options.budgetMs - (Date.now() - started))
        ),
      });
      if (!progress) break;
      for (const key of [
        'entries',
        'sourceBlocks',
        'targetBlocks',
        'payloadBytesBefore',
        'payloadBytesAfter',
      ])
        result[key] += progress[key];
      result.batches++;
      const remainingGroup =
        Number(group.groupBlocks) - progress.sourceBlocks + progress.targetSmallBlocks;
      result.remainingEligibleBlocksEstimate = Math.max(
        0,
        Number(group.eligibleBlocks) -
          Number(group.groupBlocks) +
          (remainingGroup > 1 ? remainingGroup : 0)
      );
    }
    result.durationMs = Date.now() - started;
    result.budgetExhausted = result.durationMs + 250 >= options.budgetMs;
  } catch (error) {
    result.failedBatches++;
    result.errorCode = error.original?.code || error.code || error.name;
    result.durationMs = Date.now() - started;
    logger.warn('完整日志压实失败，当前批次已回滚', {
      errorCode: result.errorCode,
      batches: result.batches,
    });
  } finally {
    if (connection) {
      let destroyed = false;
      try {
        if (locked) await connection.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
      } catch (error) {
        logger.warn('日志压实维护锁释放失败，销毁连接', { errorCode: error.code || error.name });
        await sequelize.connectionManager.destroyConnection(connection);
        destroyed = true;
      }
      if (!destroyed) await sequelize.connectionManager.releaseConnection(connection);
    }
  }
  try {
    const fields = [
      'entries',
      'sourceBlocks',
      'targetBlocks',
      'payloadBytesBefore',
      'payloadBytesAfter',
      'failedBatches',
    ];
    const cumulative = Object.fromEntries(fields.map(key => [key, result[key]]));
    const sums = fields
      .map(
        key =>
          `'${key}',coalesce((monitor_log_storage_metrics.value#>>'{cumulative,${key}}')::bigint,0)+coalesce((excluded.value#>>'{cumulative,${key}}')::bigint,0)`
      )
      .join(',');
    await query(
      `INSERT INTO monitor_log_storage_metrics(name,value) VALUES('compaction',:value::jsonb)
       ON CONFLICT(name) DO UPDATE SET value=excluded.value||jsonb_build_object('cumulative',jsonb_build_object(${sums})),updated_at=now()`,
      {
        value: JSON.stringify({
          cumulative,
          last: result,
          observedAt: new Date().toISOString(),
          space: 'deleted pages reusable after vacuum; physical relation not shrunk',
        }),
      }
    );
    logger.info('完整日志压实指标', result);
    return result;
  } catch (error) {
    logger.warn('日志压实指标保存失败', { errorCode: error.code || error.name });
    return { ...result, metricsSaved: false };
  }
}

module.exports = { compact };
