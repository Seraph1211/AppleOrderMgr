/* eslint camelcase: ["error", {"properties": "never"}] */
const { createHash } = require('crypto');
const { gzip, gunzip } = require('zlib');
const { promisify } = require('util');
const { QueryTypes, Transaction } = require('sequelize');
const { sequelize } = require('../models');
const policy = require('./monitorLogPolicy');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const SIGNATURE_BITS = 8192;
const MAX_RAW_BYTES = 4 * 1024 * 1024;
const ROW_FIELDS = [
  'id',
  'loggedAt',
  'sortAt',
  'accountNumber',
  'lineNumber',
  'partIndex',
  'byteOffset',
  'message',
  'rawBase64',
  'parseState',
  'contextAt',
  'createdAt',
  'updatedAt',
];
const fail = error => logger.warn('压缩日志操作失败', { errorCode: error.code || error.name });
const digestBytes = value => createHash('sha256').update(value).digest();
/** 按原时间/UUID/偏移排序。 @param {Object} a 记录 @param {Object} b 记录 @returns {number} 顺序 */
function compare(a, b) {
  const time = new Date(a.sortAt).getTime() - new Date(b.sortAt).getTime();
  if (time) return Math.sign(time);
  if (a.fileId !== b.fileId) return a.fileId < b.fileId ? -1 : 1;
  return BigInt(a.byteOffset) === BigInt(b.byteOffset)
    ? 0
    : BigInt(a.byteOffset) < BigInt(b.byteOffset)
      ? -1
      : 1;
}
/** 同片段Unicode 1/2/3字元无漏检候选；哈希位位置保持v1一致。 @param {string[]} messages 原文 @param {boolean} search 查询 @returns {string} 位集 */
function signature(messages, search = false) {
  const bits = new Uint8Array(SIGNATURE_BITS);
  for (const message of new Set(messages)) {
    const points = Array.from(message, point => point.codePointAt(0));
    const firstSize = search ? Math.min(3, points.length) : 1;
    const lastSize = search ? firstSize : 3;
    for (let size = firstSize; size <= lastSize; size++) {
      if (!size) continue;
      for (let index = 0; index <= points.length - size; index++) {
        let first = 2166136261;
        let second = 5381;
        for (let offset = 0; offset < size; offset++) {
          const value = points[index + offset];
          first = Math.imul(first ^ value, 16777619) >>> 0;
          second = (Math.imul(second, 33) ^ value) >>> 0;
        }
        bits[first % SIGNATURE_BITS] = 1;
        bits[second % SIGNATURE_BITS] = 1;
        bits[(first + second) % SIGNATURE_BITS] = 1;
      }
    }
  }
  return Array.from(bits).join('');
}
/** 读取实例存储模式。 @param {string} deviceId 设备 @param {string} localId 实例 @param {Object} transaction 事务 @returns {Promise<string>} 模式 */
async function mode(deviceId, localId, transaction) {
  try {
    const rows = await sequelize.query(
      'SELECT mode FROM monitor_log_storage_scopes WHERE device_id=:deviceId AND local_id=:localId',
      { replacements: { deviceId, localId }, transaction, type: QueryTypes.SELECT }
    );
    if (rows[0]) return rows[0].mode;
    const defaults = await sequelize.query(
      "SELECT value FROM monitor_log_storage_metrics WHERE name='storage-default'",
      {
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    if (defaults[0]?.value?.mode !== 'blocks') return 'rows';
    const legacy = await sequelize.query(
      'SELECT 1 FROM monitor_log_entries WHERE device_id=:deviceId AND local_id=:localId LIMIT 1',
      {
        replacements: { deviceId, localId },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    if (legacy.length) return 'rows';
    if (transaction)
      await sequelize.query(
        "INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:deviceId,:localId,'blocks') ON CONFLICT DO NOTHING",
        {
          replacements: { deviceId, localId },
          transaction,
        }
      );
    return 'blocks';
  } catch (error) {
    fail(error);
    throw error;
  }
}
/** 日期分区按事务创建。 @param {string} day 日期 @param {Object} transaction 事务 @returns {Promise<void>} 完成 */
async function ensureDay(day, transaction) {
  try {
    policy.date(day);
    const suffix = day.replace(/-/g, '');
    const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
    const present = await sequelize.query('SELECT to_regclass(:name) AS name', {
      replacements: { name: `monitor_log_blocks_${suffix}` },
      transaction,
      type: QueryTypes.SELECT,
    });
    if (present[0].name) return;
    await sequelize.query('SELECT pg_advisory_xact_lock(709100,:day)', {
      replacements: { day: Number(suffix) },
      transaction,
    });
    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS monitor_log_blocks_${suffix}
      PARTITION OF monitor_log_blocks FOR VALUES FROM ('${day}') TO ('${next}');
      CREATE TABLE IF NOT EXISTS monitor_log_block_accounts_${suffix}
      PARTITION OF monitor_log_block_accounts FOR VALUES FROM ('${day}') TO ('${next}');`,
      { transaction }
    );
  } catch (error) {
    fail(error);
    throw error;
  }
}
function normalizeRow(row) {
  const item = row.toJSON ? row.toJSON() : { ...row };
  for (const key of ['loggedAt', 'contextAt', 'sortAt', 'createdAt', 'updatedAt'])
    if (item[key] != null) item[key] = new Date(item[key]).toISOString();
  item.byteOffset = String(item.byteOffset);
  item.lineNumber = String(item.lineNumber);
  if (!item.payloadHash) {
    const fields = [
      'id',
      'localId',
      'fileId',
      'fileName',
      'businessDate',
      'loggedAt',
      'accountNumber',
      'lineNumber',
      'partIndex',
      'byteOffset',
      'message',
      'rawBase64',
      'parseState',
      'contextAt',
    ];
    item.payloadHash = policy.digest(
      policy.entry(
        Object.fromEntries(
          fields.map(key => [
            key,
            ['lineNumber', 'byteOffset'].includes(key) ? Number(item[key]) : item[key],
          ])
        )
      )
    );
  }
  // Match PostgreSQL UTF-8 transport normalization after computing protocol digest.
  item.message = Buffer.from(item.message, 'utf8').toString('utf8');
  item.createdAt ||= new Date().toISOString();
  item.updatedAt ||= item.createdAt;
  return item;
}
/** 事务追加不可变块和全局回执。 @param {Object[]} input 记录 @param {Object} transaction 已锁设备事务 @returns {Promise<Object>} 计数 */
async function append(input, transaction) {
  try {
    if (!transaction) throw new Error('压缩日志必须在事务内持久化');
    const unique = new Map();
    const byId = new Map();
    for (const row of input.map(normalizeRow)) {
      const key = `${row.deviceId}:${row.fileId}:${row.byteOffset}`;
      const prior = [unique.get(key), byId.get(row.id)].filter(Boolean);
      if (
        prior.some(item => item.deviceId !== row.deviceId || item.payloadHash !== row.payloadHash)
      )
        throw new ApiError(409, 'LOG_PAYLOAD_CONFLICT', '日志事件或位置载荷冲突');
      if (prior.length) continue;
      unique.set(key, row);
      byId.set(row.id, row);
    }
    const rows = [...unique.values()];
    if (!rows.length) return { inserted: 0, blocks: 0 };
    const files = new Map();
    for (const row of rows) {
      const key = `${row.deviceId}:${row.fileId}`;
      if (!files.has(key)) {
        const result = await sequelize.query(
          `INSERT INTO monitor_log_files(device_id,file_id)
          VALUES(:deviceId,:fileId) ON CONFLICT(device_id,file_id) DO UPDATE SET file_id=EXCLUDED.file_id RETURNING id`,
          { replacements: row, transaction, type: QueryTypes.SELECT }
        );
        files.set(key, result[0].id);
      }
      row.fileKey = files.get(key);
    }
    const replacements = {};
    const clauses = rows.map((row, index) => {
      replacements[`id${index}`] = row.id;
      replacements[`file${index}`] = row.fileKey;
      replacements[`offset${index}`] = row.byteOffset;
      return `(r.id=:id${index} OR (r.file_key=:file${index} AND r.byte_offset=:offset${index}))`;
    });
    const previous = await sequelize.query(
      `SELECT r.*,f.device_id AS "deviceId" FROM monitor_log_receipts r
      JOIN monitor_log_files f ON f.id=r.file_key WHERE ${clauses.join(' OR ')}`,
      { replacements, transaction, type: QueryTypes.SELECT }
    );
    const existingIds = new Map(previous.map(row => [row.id, row]));
    const existingPositions = new Map(
      previous.map(row => [`${row.file_key}:${row.byte_offset}`, row])
    );
    const groups = new Map();
    for (const row of rows) {
      const found = [
        existingIds.get(row.id),
        existingPositions.get(`${row.fileKey}:${row.byteOffset}`),
      ].filter(Boolean);
      if (
        found.some(
          item =>
            item.deviceId !== row.deviceId || item.payload_hash.toString('hex') !== row.payloadHash
        )
      )
        throw new ApiError(409, 'LOG_PAYLOAD_CONFLICT', '日志事件或位置载荷冲突');
      if (found.length) continue;
      const key = `${row.deviceId}:${row.localId}:${row.businessDate}:${row.fileKey}:${row.fileName}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const targetBytes = Math.min(
      MAX_RAW_BYTES / 2,
      Math.max(32768, Number(process.env.MONITOR_LOG_BLOCK_BYTES) || 262144)
    );
    for (const day of [...new Set([...groups.values()].map(group => group[0].businessDate))].sort())
      await ensureDay(day, transaction);
    let inserted = 0;
    let blocks = 0;
    for (const group of groups.values()) {
      group.sort(compare);
      let chunk = [];
      let bytes = 0;
      for (const row of group) {
        row.encodedPayload = encodeRow(row);
        const size = Buffer.byteLength(row.encodedPayload);
        if (chunk.length && bytes + size > targetBytes) {
          await writeBlock(chunk, transaction);
          blocks++;
          inserted += chunk.length;
          chunk = [];
          bytes = 0;
        }
        chunk.push(row);
        bytes += size;
      }
      if (chunk.length) {
        await writeBlock(chunk, transaction);
        blocks++;
        inserted += chunk.length;
      }
    }
    return { inserted, blocks };
  } catch (error) {
    fail(error);
    if (error.name === 'SequelizeUniqueConstraintError')
      throw new ApiError(409, 'LOG_PAYLOAD_CONFLICT', '日志事件或位置载荷冲突');
    throw error;
  }
}
async function writeBlock(rows, transaction, replaceReceipts = false) {
  try {
    const first = rows[0];
    const last = rows.at(-1);
    const raw = Buffer.from(`[${rows.map(row => row.encodedPayload).join(',')}]`);
    if (raw.length > MAX_RAW_BYTES) throw new Error('日志压实块超过原文上限');
    const payload = await compress(raw, { level: 6 });
    const values = {
      ...first,
      payload,
      checksum: digestBytes(raw),
      rawBytes: raw.length,
      signature: signature(rows.map(row => row.message)),
      count: rows.length,
      minAt: first.sortAt,
      minFile: first.fileId,
      minOffset: first.byteOffset,
      maxAt: last.sortAt,
      maxFile: last.fileId,
      maxOffset: last.byteOffset,
    };
    const blocks = await sequelize.query(
      `INSERT INTO monitor_log_blocks(business_date,device_id,local_id,
      file_key,file_name,codec,payload,payload_hash,signature,entry_count,raw_bytes,
      min_sort_at,min_file_id,min_byte_offset,max_sort_at,max_file_id,max_byte_offset)
      VALUES(:businessDate,:deviceId,:localId,:fileKey,:fileName,'gzip',:payload,:checksum,
      :signature::bit(8192),:count,:rawBytes,:minAt,:minFile,:minOffset,:maxAt,:maxFile,:maxOffset) RETURNING id`,
      { replacements: values, transaction, type: QueryTypes.SELECT }
    );
    const blockId = blocks[0].id;
    const accounts = new Map();
    const receiptValues = rows.map((row, ordinal) => {
      const account = row.accountNumber || '';
      if (!accounts.has(account)) accounts.set(account, []);
      accounts.get(account).push(row);
      const values = [
        row.id,
        row.fileKey,
        row.byteOffset,
        Buffer.from(row.payloadHash, 'hex'),
        row.businessDate,
        blockId,
        ordinal,
      ];
      if (replaceReceipts) values.push(row.sourceBlockId);
      return values.map(value => sequelize.escape(value)).join(',');
    });
    if (replaceReceipts) {
      const changed = await sequelize.query(
        `UPDATE monitor_log_receipts r SET block_id=v.block_id::bigint,ordinal=v.ordinal::integer
        FROM (VALUES ${receiptValues.map(value => `(${value})`).join(',')})
          AS v(id,file_key,byte_offset,payload_hash,business_date,block_id,ordinal,source_block_id)
        WHERE r.id=v.id::uuid AND r.file_key=v.file_key::bigint
          AND r.byte_offset=v.byte_offset::bigint AND r.payload_hash=v.payload_hash::bytea
          AND r.business_date=v.business_date::date AND r.block_id=v.source_block_id::bigint RETURNING r.id`,
        { transaction, type: QueryTypes.SELECT }
      );
      if (changed.length !== rows.length) throw new Error('日志压实回执映射不一致');
    } else {
      await sequelize.query(
        `INSERT INTO monitor_log_receipts(id,file_key,byte_offset,payload_hash,business_date,block_id,ordinal)
        VALUES ${receiptValues.map(value => `(${value})`).join(',')}`,
        { transaction }
      );
    }
    const accountValues = [...accounts.entries()].map(([account, items]) => {
      const start = items[0];
      const end = items.at(-1);
      return [
        first.businessDate,
        blockId,
        first.deviceId,
        first.localId,
        account,
        start.sortAt,
        start.fileId,
        start.byteOffset,
        end.sortAt,
        end.fileId,
        end.byteOffset,
      ]
        .map(value => sequelize.escape(value))
        .join(',');
    });
    await sequelize.query(
      `INSERT INTO monitor_log_block_accounts(business_date,block_id,device_id,local_id,account_number,
      min_sort_at,min_file_id,min_byte_offset,max_sort_at,max_file_id,max_byte_offset)
      VALUES ${accountValues.map(value => `(${value})`).join(',')}`,
      { transaction }
    );
    return {
      id: String(blockId),
      payloadBytes: payload.length,
      rawBytes: raw.length,
      entries: rows.length,
    };
  } catch (error) {
    fail(error);
    throw error;
  }
}
/** 序列化v1原片段字段，不重新计算协议摘要。 @param {Object} row 原片段 @returns {string} 规范数组 */
function encodeRow(row) {
  return JSON.stringify(ROW_FIELDS.map(key => row[key] ?? null));
}
/** 为压实写入不可变块并仅迁移已验证回执位置。 @param {Object[]} rows 原片段 @param {Object} transaction 事务 @returns {Promise<Object>} 块统计 */
async function writeCompactedBlock(rows, transaction) {
  try {
    if (!transaction || !rows.length) throw new Error('日志压实要求非空事务批次');
    for (const row of rows) row.encodedPayload = encodeRow(row);
    return await writeBlock(rows, transaction, true);
  } catch (error) {
    fail(error);
    throw error;
  }
}
/** 版本/长度/摘要一致才还原日志。 @param {Object} block 数据库块 @param {string} keyword 逐片段字面筛选（可选） @returns {Promise<Object[]>} 原记录 */
async function readBlock(block, keyword = '') {
  try {
    if (block.format_version !== 1 || block.codec !== 'gzip' || block.raw_bytes > MAX_RAW_BYTES)
      throw new Error('日志块格式无效');
    const raw = await decompress(block.payload, { maxOutputLength: MAX_RAW_BYTES });
    if (raw.length !== block.raw_bytes || !digestBytes(raw).equals(block.payload_hash))
      throw new Error('日志块完整性无效');
    const entries = JSON.parse(raw.toString('utf8'));
    if (
      !Array.isArray(entries) ||
      entries.length !== block.entry_count ||
      entries.some(
        values =>
          !Array.isArray(values) ||
          values.length !== ROW_FIELDS.length ||
          typeof values[0] !== 'string' ||
          typeof values[7] !== 'string'
      )
    )
      throw new Error('日志块片段结构无效');
    const businessDate =
      typeof block.business_date === 'string'
        ? block.business_date
        : new Date(block.business_date).toISOString().slice(0, 10);
    // All entries are decoded and validated before filtering; no serialized text shortcut.
    const selected = keyword ? entries.filter(values => values[7].includes(keyword)) : entries;
    // Explicit v1 positions avoid 13 temporary key/value arrays per decoded entry.
    return selected.map(values => ({
      id: values[0],
      loggedAt: values[1],
      sortAt: values[2],
      accountNumber: values[3],
      lineNumber: values[4],
      partIndex: values[5],
      byteOffset: values[6],
      message: values[7],
      rawBase64: values[8],
      parseState: values[9],
      contextAt: values[10],
      createdAt: values[11],
      updatedAt: values[12],
      deviceId: block.device_id,
      localId: block.local_id,
      fileId: block.file_id || block.min_file_id,
      fileName: block.file_name,
      businessDate,
    }));
  } catch (error) {
    fail(error);
    throw new ApiError(503, 'FULL_LOG_CORRUPT', '日志存储校验失败，请联系管理员');
  }
}
/** 全局回执定位旧ID。 @param {string} id 事件 @param {Object} transaction 事务 @returns {Promise<Object|null>} 原记录 */
async function findById(id, transaction) {
  try {
    id = id.toLowerCase();
    const rows = await sequelize.query(
      `SELECT b.*,r.ordinal,r.id AS event_id FROM monitor_log_receipts r
      JOIN monitor_log_blocks b ON b.business_date=r.business_date AND b.id=r.block_id WHERE r.id=:id`,
      { replacements: { id }, transaction, type: QueryTypes.SELECT }
    );
    if (!rows.length) return null;
    const entries = await readBlock(rows[0]);
    const row = entries[rows[0].ordinal];
    if (!row || row.id !== id) throw new ApiError(503, 'FULL_LOG_CORRUPT', '日志定位校验失败');
    return row;
  } catch (error) {
    fail(error);
    throw error;
  }
}
function matches(row, query, anchor, direction) {
  if (
    query.account &&
    row.accountNumber !== (query.account === '__unassigned__' ? null : query.account)
  )
    return false;
  if (
    query.fromTime &&
    (!row.loggedAt ||
      Date.parse(row.loggedAt) < Date.parse(`${query.date}T${query.fromTime}+08:00`))
  )
    return false;
  if (
    query.toTime &&
    (!row.loggedAt ||
      Date.parse(row.loggedAt) >= Date.parse(`${query.date}T${query.toTime}+08:00`) + 1000)
  )
    return false;
  if (query.keyword && !row.message.includes(query.keyword)) return false;
  if (anchor && (direction === 'ASC' ? compare(row, anchor) <= 0 : compare(row, anchor) >= 0))
    return false;
  return true;
}
/** 候选块按精确边界归并；重叠候选必须读取。 @param {Object} query 筛选 @param {Object} anchor 锚点 @param {string} direction 顺序 @param {number} limit 数量 @returns {Promise<Object[]>} 片段 */
async function selectSnapshot(query, anchor, direction, limit, transaction) {
  const started = Date.now();
  let decoded = 0;
  try {
    if (
      !['ASC', 'DESC'].includes(direction) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 101
    )
      throw new Error('日志查询内部边界无效');
    if (query.keyword)
      query = { ...query, keyword: Buffer.from(query.keyword, 'utf8').toString('utf8') };
    const prefix = direction === 'ASC' ? 'min' : 'max';
    const op = direction === 'ASC' ? '>' : '<';
    const clauses = ['b.device_id=:deviceId', 'b.local_id=:localId', 'b.business_date=:date'];
    const replacements = { ...query };
    const accountJoin = query.account
      ? `JOIN monitor_log_block_accounts a
      ON a.business_date=b.business_date AND a.block_id=b.id AND a.account_number=:accountValue`
      : '';
    const bound = query.account ? 'a' : 'b';
    if (query.account)
      replacements.accountValue = query.account === '__unassigned__' ? '' : query.account;
    if (query.fromTime) {
      replacements.fromAt = `${query.date}T${query.fromTime}+08:00`;
      clauses.push('b.max_sort_at >= :fromAt::timestamptz');
    }
    if (query.toTime) {
      replacements.toAt = new Date(
        Date.parse(`${query.date}T${query.toTime}+08:00`) + 1000
      ).toISOString();
      clauses.push('b.min_sort_at < :toAt::timestamptz');
    }
    if (query.keyword) {
      replacements.mask = signature([query.keyword], true);
      clauses.push('(b.signature & :mask::bit(8192))=:mask::bit(8192)');
    }
    if (anchor) {
      const other = direction === 'ASC' ? 'max' : 'min';
      clauses.push(`(${bound}.${other}_sort_at,${bound}.${other}_file_id,${bound}.${other}_byte_offset)
        ${op} (:anchorAt::timestamptz,:anchorFile::uuid,:anchorOffset::bigint)`);
      Object.assign(replacements, {
        anchorAt: new Date(anchor.sortAt).toISOString(),
        anchorFile: anchor.fileId,
        anchorOffset: anchor.byteOffset,
      });
    }
    let after = null;
    let result = [];
    let done = false;
    while (!done) {
      const paging = [...clauses];
      if (after) {
        paging.push(`(${bound}.${prefix}_sort_at,${bound}.${prefix}_file_id,${bound}.${prefix}_byte_offset,b.id)
          ${op} (:afterAt::timestamptz,:afterFile::uuid,:afterOffset::bigint,:afterId::bigint)`);
        Object.assign(replacements, after);
      }
      const blocks = await sequelize.query(
        `SELECT b.*,${bound}.${prefix}_sort_at AS boundary_at,
        ${bound}.${prefix}_file_id AS boundary_file,${bound}.${prefix}_byte_offset AS boundary_offset
        FROM monitor_log_blocks b ${accountJoin} WHERE ${paging.join(' AND ')}
        ORDER BY ${bound}.${prefix}_sort_at ${direction},${bound}.${prefix}_file_id ${direction},
        ${bound}.${prefix}_byte_offset ${direction},b.id ${direction} LIMIT 64`,
        { replacements, transaction, type: QueryTypes.SELECT }
      );
      if (!blocks.length) break;
      for (const block of blocks) {
        const boundary = {
          sortAt: block.boundary_at,
          fileId: block.boundary_file,
          byteOffset: block.boundary_offset,
        };
        if (
          result.length >= limit &&
          (direction === 'ASC'
            ? compare(boundary, result.at(-1)) > 0
            : compare(boundary, result.at(-1)) < 0)
        ) {
          done = true;
          break;
        }
        const rows = await readBlock(block, query.keyword);
        decoded++;
        result.push(...rows.filter(row => matches(row, query, anchor, direction)));
        result.sort((a, b) => compare(a, b) * (direction === 'ASC' ? 1 : -1));
        result = result.slice(0, limit);
      }
      if (done || blocks.length < 64) break;
      const last = blocks.at(-1);
      after = {
        afterAt: last.boundary_at,
        afterFile: last.boundary_file,
        afterOffset: last.boundary_offset,
        afterId: last.id,
      };
    }
    logger.info('完整日志查询指标', {
      storage: 'blocks',
      durationMs: Date.now() - started,
      decodedBlocks: decoded,
      returned: result.length,
      keyword: !!query.keyword,
    });
    return result;
  } catch (error) {
    fail(error);
    throw error;
  }
}
/** 多批候选保持只读快照，防止压实移动块后漏查。 @param {Object} query 筛选 @param {Object} anchor 锚点 @param {string} direction 顺序 @param {number} limit 数量 @returns {Promise<Object[]>} 完整片段 */
async function select(query, anchor = null, direction = 'ASC', limit = 50) {
  try {
    return await sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async transaction => {
        try {
          await sequelize.query("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout='5s'", {
            transaction,
          });
          return await selectSnapshot(query, anchor, direction, limit, transaction);
        } catch (error) {
          logger.debug('完整日志快照读取未完成', { errorCode: error.code || error.name });
          throw error;
        }
      }
    );
  } catch (error) {
    fail(error);
    throw error;
  }
}
/** 日目录账号分页。 @param {Object} query 范围 @param {Object} input 账号筛选 @returns {Promise<Object>} 分页 */
async function accounts(query, input) {
  try {
    const clauses = [
      'device_id=:deviceId',
      'local_id=:localId',
      'business_date=:date',
      "account_number<>''",
    ];
    const replacements = { ...query };
    if (input.search) {
      clauses.push("account_number LIKE :pattern ESCAPE '\\'");
      replacements.pattern = policy.literalSearch(input.search);
    }
    if (input.after) {
      clauses.push('account_number > :after');
      replacements.after = input.after;
    }
    const rows = await sequelize.query(
      `SELECT DISTINCT account_number AS account FROM monitor_log_block_accounts
      WHERE ${clauses.join(' AND ')} ORDER BY account_number LIMIT 101`,
      { replacements, type: QueryTypes.SELECT }
    );
    return {
      items: rows.slice(0, 100).map(row => row.account),
      nextCursor: rows.length > 100 ? rows[99].account : null,
    };
  } catch (error) {
    fail(error);
    throw error;
  }
}
/** 有界回执回收；无依赖时删除到期日分区。 @param {string} first 首日 @param {Object} transaction 事务 @param {number} take 预算 @returns {Promise<Object>} 进度 */
async function cleanup(first, transaction, take = 5000) {
  try {
    const removed = await sequelize.query(
      `DELETE FROM monitor_log_receipts WHERE id IN
      (SELECT id FROM monitor_log_receipts WHERE business_date < :first ORDER BY business_date LIMIT :take) RETURNING id`,
      { replacements: { first, take }, transaction, type: QueryTypes.SELECT }
    );
    if (removed.length < take) {
      const days = await sequelize.query(
        'SELECT DISTINCT business_date AS day FROM monitor_log_blocks WHERE business_date < :first LIMIT 40',
        { replacements: { first }, transaction, type: QueryTypes.SELECT }
      );
      for (const item of days) {
        const day =
          typeof item.day === 'string' ? item.day : new Date(item.day).toISOString().slice(0, 10);
        const suffix = policy.date(day).replace(/-/g, '');
        await sequelize.query(
          `DROP TABLE IF EXISTS monitor_log_block_accounts_${suffix};
          ALTER TABLE monitor_log_blocks DETACH PARTITION monitor_log_blocks_${suffix};
          DROP TABLE monitor_log_blocks_${suffix}`,
          { transaction }
        );
      }
    }
    return { deleted: removed.length };
  } catch (error) {
    fail(error);
    throw error;
  }
}
/** 容量治理指标仅读取目录统计，不扫描原文。 @returns {Promise<Object>} 大小与死行估计 */
async function capacity() {
  try {
    const rows = await sequelize.query(
      `SELECT
      coalesce(sum(pg_total_relation_size(c.oid)) FILTER(WHERE c.relname='monitor_log_entries'),0)::text AS legacy_bytes,
      coalesce(sum(pg_total_relation_size(c.oid)) FILTER(WHERE c.relname<>'monitor_log_entries'),0)::text AS compressed_bytes,
      coalesce(sum(pg_indexes_size(c.oid)),0)::text AS index_bytes,
      coalesce(sum(s.n_dead_tup),0)::text AS dead_rows_estimate
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
      WHERE n.nspname='public' AND c.relkind='r' AND
        (c.relname='monitor_log_entries' OR c.relname IN
          ('monitor_log_files','monitor_log_receipts','monitor_log_storage_scopes','monitor_log_storage_metrics')
          OR c.relname LIKE 'monitor_log_blocks_%' OR c.relname LIKE 'monitor_log_block_accounts_%')`,
      { type: QueryTypes.SELECT }
    );
    return rows[0];
  } catch (error) {
    fail(error);
    throw error;
  }
}
module.exports = {
  append,
  mode,
  ensureDay,
  readBlock,
  writeCompactedBlock,
  encodeRow,
  findById,
  select,
  accounts,
  cleanup,
  compare,
  signature,
  capacity,
};
