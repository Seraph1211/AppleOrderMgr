const { QueryTypes, Transaction } = require('sequelize');
const { createHash } = require('crypto');
const policy = require('./aosAccountConfigPolicy');
const monitorPolicy = require('./monitorPolicy');
const blockStore = require('./monitorLogBlockStore');
const MAX_CANDIDATES = 100;
const MAX_BLOCK_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const VERSION = 'numeric211-four-fields-v1';
const FACT_FIELDS = [
  'id',
  'deviceId',
  'localId',
  'accountNumber',
  'fileId',
  'byteOffset',
  'lineIndex',
  'loggedAt',
  'kind',
  'body',
];
const COLUMNS = `id,device_id AS "deviceId",local_id AS "localId",account_number AS "accountNumber",
  file_id AS "fileId",byte_offset AS "byteOffset",line_index AS "lineIndex",logged_at AS "loggedAt",
  kind,body,payload_hash AS "payloadHash",created_at AS "createdAt",updated_at AS "updatedAt"`;
const sha = text => createHash('sha256').update(text).digest('hex');
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])])
    );
  return value;
}
const digestOf = value => policy.digest(canonical(value));
const factOf = row => Object.fromEntries(FACT_FIELDS.map(field => [field, row[field]]));

function scopeOf(scope) {
  try {
    return {
      deviceId: monitorPolicy.uuid(scope.deviceId).toLowerCase(),
      localId: monitorPolicy.uuid(scope.localId).toLowerCase(),
    };
  } catch (error) {
    throw new Error('REPAIR_SCOPE_INVALID', { cause: error });
  }
}
function rangeOf(now) {
  const lastDate = new Date(+new Date(now) + 8 * 3600000).toISOString().slice(0, 10);
  const firstDate = new Date(Date.parse(lastDate) - 2 * 86400000).toISOString().slice(0, 10);
  return { firstDate, lastDate };
}
function parameters(scope, range) {
  return {
    ...scope,
    ...range,
    from: `${range.firstDate}T00:00:00+08:00`,
    until: new Date(Date.parse(`${range.lastDate}T00:00:00+08:00`) + 86400000).toISOString(),
  };
}
function queryFor(models, transaction) {
  const started = Date.now();
  return async (sql, replacements) => {
    try {
      const remaining = 2000 - (Date.now() - started);
      if (remaining <= 0) throw new Error('REPAIR_TRANSACTION_BUDGET');
      await models.sequelize.query("SELECT set_config('statement_timeout',:timeout,true)", {
        replacements: { timeout: `${Math.min(1500, remaining)}ms` },
        transaction,
      });
      return await models.sequelize.query(sql, {
        replacements,
        transaction,
        type: QueryTypes.SELECT,
      });
    } catch (error) {
      throw new Error('REPAIR_QUERY_FAILED', { cause: error });
    }
  };
}
async function readOnly(models, work) {
  try {
    return await models.sequelize.transaction(
      { readOnly: true, isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async transaction => {
        try {
          return await work(queryFor(models, transaction));
        } catch (error) {
          throw new Error('REPAIR_READ_FAILED', { cause: error });
        }
      }
    );
  } catch (error) {
    throw new Error('REPAIR_READ_FAILED', { cause: error });
  }
}
async function copyRaw(query, before, scope, range, budget) {
  try {
    const rowId = before.id.split(':')[0];
    monitorPolicy.uuid(rowId);
    const args = {
      ...parameters(scope, range),
      rowId,
      fileId: before.fileId,
      offset: String(before.byteOffset),
    };
    const [legacy] = await query(
      `SELECT id,device_id AS "deviceId",local_id AS "localId",file_id AS "fileId",
        byte_offset AS "byteOffset",business_date AS "businessDate",logged_at AS "loggedAt",
        sort_at AS "contextAt",account_number AS "accountNumber",parse_state AS "parseState",
        part_index AS "partIndex",octet_length(message) AS bytes FROM monitor_log_entries
        WHERE id = :rowId AND device_id = :deviceId AND local_id = :localId AND file_id = :fileId
        AND byte_offset = :offset::bigint AND business_date BETWEEN :firstDate AND :lastDate`,
      args
    );
    if (legacy) {
      if (legacy.bytes > MAX_BLOCK_BYTES) throw new Error('REPAIR_RAW_BLOCK_BUDGET');
      if (budget.bytes + legacy.bytes > MAX_BATCH_BYTES) return { budget: true };
      const [text] = await query('SELECT message FROM monitor_log_entries WHERE id = :rowId', args);
      if (!text) throw new Error('REPAIR_RAW_CHANGED');
      budget.bytes += legacy.bytes;
      return { row: { ...legacy, message: text.message } };
    }
    const [metadata] = await query(
      `SELECT b.id,b.business_date AS day,b.raw_bytes AS bytes,r.ordinal
      FROM monitor_log_receipts r JOIN monitor_log_files f ON f.id=r.file_key
      JOIN monitor_log_blocks b ON b.business_date=r.business_date AND b.id=r.block_id
      WHERE r.id = :rowId AND f.device_id = :deviceId AND f.file_id = :fileId
      AND r.byte_offset = :offset::bigint AND b.device_id = :deviceId AND b.local_id = :localId
      AND b.business_date BETWEEN :firstDate AND :lastDate`,
      args
    );
    if (!metadata) return { missing: true };
    if (metadata.bytes > MAX_BLOCK_BYTES) throw new Error('REPAIR_RAW_BLOCK_BUDGET');
    if (budget.bytes + metadata.bytes > MAX_BATCH_BYTES) return { budget: true };
    const [block] = await query(
      'SELECT * FROM monitor_log_blocks WHERE business_date = :day AND id = :id',
      { day: metadata.day, id: metadata.id }
    );
    if (!block) throw new Error('REPAIR_RAW_CHANGED');
    budget.bytes += metadata.bytes;
    return { block, ordinal: metadata.ordinal, rowId };
  } catch (error) {
    throw new Error('REPAIR_RAW_COPY_FAILED', { cause: error });
  }
}
async function evidence(models, before, scope, range, budget, query) {
  try {
    const copied = query
      ? await copyRaw(query, before, scope, range, budget)
      : await readOnly(models, read => copyRaw(read, before, scope, range, budget));
    if (copied.budget || copied.missing) return copied;
    let row = copied.row;
    if (copied.block) {
      const rows = await blockStore.readBlock(copied.block);
      row = rows[copied.ordinal];
      if (!row || row.id !== copied.rowId) throw new Error('REPAIR_RAW_ID_MISMATCH');
    }
    const fact = policy.parse([row]).ignoredCity.find(item => item.id === before.id);
    if (!fact || fact.payloadHash !== before.payloadHash) return { verified: false };
    if (digestOf(factOf(fact)) !== digestOf(factOf(before))) return { verified: false };
    const line = row.message.split(/\r?\n/)[before.lineIndex];
    if (typeof line !== 'string') throw new Error('REPAIR_RAW_LINE_MISMATCH');
    return { verified: true, lineSha256: sha(line) };
  } catch (error) {
    throw new Error('REPAIR_EVIDENCE_FAILED', { cause: error });
  }
}

/** 有界预览当前三日严格数值状态误索引，只返回旧派生事实备份及行摘要。 @param {Object} models 模型 @param {Object} scope 明确设备实例 @param {Object} options 游标及限制 @returns {Promise<Object>} 只读manifest */
async function preview(models, scope, options = {}) {
  try {
    scope = scopeOf(scope);
    const range = rangeOf(options.now || new Date());
    const limit = options.limit ?? MAX_CANDIDATES;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANDIDATES)
      throw new Error('REPAIR_LIMIT_INVALID');
    const afterId = options.afterId || '';
    if (typeof afterId !== 'string' || afterId.length > 200)
      throw new Error('REPAIR_CURSOR_INVALID');
    const candidates = await readOnly(models, query =>
      query(
        `SELECT ${COLUMNS} FROM aos_account_config_events WHERE device_id = :deviceId AND local_id = :localId
        AND kind='city' AND body->>'unknown'='true' AND logged_at >= :from::timestamptz
        AND logged_at < :until::timestamptz AND id > :afterId ORDER BY id LIMIT :limit`,
        { ...parameters(scope, range), afterId, limit }
      )
    );
    const entries = [];
    const budget = { bytes: 0 };
    let nextCursor = afterId;
    let scanned = 0;
    for (const before of candidates) {
      const proof = await evidence(models, before, scope, range, budget);
      if (proof.budget) break;
      scanned++;
      nextCursor = before.id;
      if (proof.verified) entries.push({ before, lineSha256: proof.lineSha256 });
    }
    const manifest = {
      version: VERSION,
      scope,
      range,
      createdAt: new Date(options.now || Date.now()).toISOString(),
      afterId,
      nextCursor,
      scanned,
      retained: scanned - entries.length,
      rawBytes: budget.bytes,
      complete: scanned === candidates.length && candidates.length < limit,
      entries,
    };
    return { ...manifest, digest: digestOf(manifest) };
  } catch (error) {
    throw new Error('REPAIR_PREVIEW_FAILED', { cause: error });
  }
}

/** 复验原片段和完整旧hash，先备份审计再事务CAS删除严格噪声city；不改任何其他事实。 @param {Object} models 模型 @param {Object} manifest 审核预览 @param {string} expectedDigest 审核摘要 @param {Object} options 显式scope、now及必需beforeDelete备份回调 @returns {Promise<Object>} 幂等结果 */
async function apply(models, manifest, expectedDigest, options = {}) {
  try {
    const { digest, ...unsigned } = manifest;
    if (manifest.version !== VERSION || digest !== expectedDigest || digest !== digestOf(unsigned))
      throw new Error('REPAIR_MANIFEST_INVALID');
    const scope = scopeOf(options.scope || {});
    if (digestOf(scope) !== digestOf(manifest.scope)) throw new Error('REPAIR_SCOPE_MISMATCH');
    const now = options.now || new Date();
    const range = rangeOf(now);
    if (
      !Number.isFinite(+new Date(manifest.createdAt)) ||
      +new Date(manifest.createdAt) > +new Date(now)
    )
      throw new Error('REPAIR_MANIFEST_FUTURE');
    if (digestOf(range) !== digestOf(manifest.range)) throw new Error('REPAIR_RANGE_CHANGED');
    if (!Array.isArray(manifest.entries) || manifest.entries.length > MAX_CANDIDATES)
      throw new Error('REPAIR_LIMIT_INVALID');
    if (typeof options.beforeDelete !== 'function') throw new Error('REPAIR_BACKUP_REQUIRED');
    const ids = manifest.entries.map(entry => entry.before.id);
    if (new Set(ids).size !== ids.length) throw new Error('REPAIR_DUPLICATE_ID');
    return await models.sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async transaction => {
        try {
          const query = queryFor(models, transaction);
          let current = [];
          if (ids.length)
            current = await query(
              `SELECT ${COLUMNS} FROM aos_account_config_events WHERE id IN (:ids) ORDER BY id FOR UPDATE`,
              { ids }
            );
          const byId = new Map(current.map(row => [row.id, row]));
          const budget = { bytes: 0 };
          for (const entry of manifest.entries) {
            const before = entry.before;
            if (
              before.deviceId !== scope.deviceId ||
              before.localId !== scope.localId ||
              before.kind !== 'city' ||
              !Number.isFinite(+new Date(before.loggedAt)) ||
              +new Date(before.loggedAt) < Date.parse(parameters(scope, range).from) ||
              +new Date(before.loggedAt) >= Date.parse(parameters(scope, range).until)
            )
              throw new Error('REPAIR_SCOPE_MISMATCH');
            const row = byId.get(before.id);
            if (
              row &&
              (row.payloadHash !== before.payloadHash || digestOf(row) !== digestOf(before))
            )
              throw new Error('REPAIR_STALE_FACT');
            const proof = await evidence(models, before, scope, range, budget, query);
            if (!proof.verified || proof.lineSha256 !== entry.lineSha256)
              throw new Error('REPAIR_RAW_PROOF_CHANGED');
          }
          const audit = {
            digest,
            scope,
            range,
            before: current,
            absentIds: ids.filter(id => !byId.has(id)),
          };
          await options.beforeDelete(audit);
          let deleted = [];
          if (current.length) {
            const replacements = parameters(scope, range);
            const guards = current.map((row, index) => {
              replacements[`id${index}`] = row.id;
              replacements[`hash${index}`] = row.payloadHash;
              return `(id = :id${index} AND payload_hash = :hash${index})`;
            });
            deleted = await query(
              `DELETE FROM aos_account_config_events WHERE device_id = :deviceId AND local_id = :localId AND logged_at >= :from::timestamptz AND logged_at < :until::timestamptz AND kind='city' AND (${guards.join(' OR ')}) RETURNING id`,
              replacements
            );
            if (deleted.length !== current.length) throw new Error('REPAIR_CAS_FAILED');
          }
          return {
            digest,
            deleted: deleted.length,
            absent: ids.length - deleted.length,
            rawBytes: budget.bytes,
          };
        } catch (error) {
          throw new Error('REPAIR_APPLY_FAILED', { cause: error });
        }
      }
    );
  } catch (error) {
    throw new Error('REPAIR_APPLY_FAILED', { cause: error });
  }
}
module.exports = { preview, apply, MAX_CANDIDATES, MAX_BATCH_BYTES, VERSION };
