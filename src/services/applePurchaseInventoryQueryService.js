const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const ApiError = require('../utils/ApiError');
const { getReadDatabase } = require('./applePurchaseSyncDatabase');
const { digest } = require('./applePurchaseSyncDigest');
const { CHANGE_TYPES, UTC_PATTERN, UUID_PATTERN } = require('./applePurchaseSyncValidation');

const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const COMMON_KEYS = Object.freeze([
  'limit',
  'direction',
  'cursor',
  'afterSequence',
  'from',
  'to',
  'terminalId',
]);

function cursorSecret() {
  const explicit = process.env.APPLE_PURCHASE_SYNC_CURSOR_SECRET;
  if (explicit && explicit.length >= 32) return explicit;
  if (process.env.NODE_ENV === 'production') throw new Error('缺少 ApplePurchase 查询游标签名密钥');
  return crypto
    .createHash('sha256')
    .update(`apple-purchase-sync-cursor:${process.env.JWT_SECRET || 'test-only'}`)
    .digest('hex');
}

function sign(encoded) {
  return crypto.createHmac('sha256', cursorSecret()).update(encoded).digest('base64url');
}

function encodeCursor(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

function decodeCursor(cursor) {
  try {
    const [encoded, signature, extra] = String(cursor).split('.');
    if (!encoded || !signature || extra) throw new Error('format');
    const actual = Buffer.from(signature);
    const expected = Buffer.from(sign(encoded));
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new Error('signature');
    }
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!value || value.expiresAt < Date.now()) throw new Error('expired');
    return value;
  } catch (_error) {
    throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效或已过期');
  }
}

function scalar(query, key) {
  const value = query[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value) || typeof value === 'object') {
    throw ApiError.badRequest(`${key} 必须是单值参数`);
  }
  return String(value);
}

function decimal(value, key) {
  if (!/^\d+$/.test(value || '')) throw ApiError.badRequest(`${key} 必须是非负十进制字符串`);
  try {
    if (BigInt(value) > 9_223_372_036_854_775_807n) throw new Error('range');
  } catch (_error) {
    throw ApiError.badRequest(`${key} 超出 bigint 范围`);
  }
  return value;
}

function list(query, key, validator = () => true) {
  const value = scalar(query, key);
  if (value === undefined) return [];
  const values = value.split(',');
  if (!values.length || values.length > 50 || values.some(item => !item || !validator(item))) {
    throw ApiError.badRequest(`${key} 查询值无效`);
  }
  return [...new Set(values)];
}

function parseQuery(query, endpoint, additionalKeys) {
  const allowed = new Set([...COMMON_KEYS, ...additionalKeys]);
  const unknown = Object.keys(query).find(key => !allowed.has(key));
  if (unknown) throw ApiError.badRequest(`不支持查询参数 ${unknown}`);
  const limitValue = scalar(query, 'limit');
  const limit = limitValue === undefined ? 100 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw ApiError.badRequest('limit 必须是 1–500 的整数');
  }
  const direction = scalar(query, 'direction') || 'desc';
  if (!['asc', 'desc'].includes(direction))
    throw ApiError.badRequest('direction 仅支持 asc 或 desc');
  const from = scalar(query, 'from');
  const to = scalar(query, 'to');
  if (from && (!UTC_PATTERN.test(from) || Number.isNaN(Date.parse(from)))) {
    throw ApiError.badRequest('from 必须是三位毫秒 UTC 时间');
  }
  if (to && (!UTC_PATTERN.test(to) || Number.isNaN(Date.parse(to)))) {
    throw ApiError.badRequest('to 必须是三位毫秒 UTC 时间');
  }
  if (from && new Date(Date.parse(from)).toISOString() !== from) {
    throw ApiError.badRequest('from 必须是有效的三位毫秒 UTC 时间');
  }
  if (to && new Date(Date.parse(to)).toISOString() !== to) {
    throw ApiError.badRequest('to 必须是有效的三位毫秒 UTC 时间');
  }
  if (from && to && Date.parse(from) > Date.parse(to))
    throw ApiError.badRequest('from 不能晚于 to');
  const terminalId = scalar(query, 'terminalId');
  if (terminalId && !UUID_PATTERN.test(terminalId))
    throw ApiError.badRequest('terminalId 格式无效');
  const cursor = scalar(query, 'cursor');
  const afterSequenceValue = scalar(query, 'afterSequence');
  if (cursor && afterSequenceValue)
    throw ApiError.badRequest('cursor 与 afterSequence 不能同时使用');
  if (afterSequenceValue && direction !== 'asc') {
    throw ApiError.badRequest('afterSequence 仅可与 direction=asc 一起使用');
  }
  const afterSequence = afterSequenceValue ? decimal(afterSequenceValue, 'afterSequence') : null;
  return { endpoint, limit, direction, from, to, terminalId, cursor, afterSequence };
}

function dateIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function buildWhere(filters, sequenceColumn, timeColumn, replacements) {
  const where = [`${sequenceColumn} <= CAST(:highWater AS bigint)`];
  if (filters.lastSequence) {
    where.push(
      `${sequenceColumn} ${filters.direction === 'asc' ? '>' : '<'} CAST(:lastSequence AS bigint)`
    );
    replacements.lastSequence = filters.lastSequence;
  }
  if (filters.from) {
    where.push(`${timeColumn} >= :from`);
    replacements.from = filters.from;
  }
  if (filters.to) {
    where.push(`${timeColumn} <= :to`);
    replacements.to = filters.to;
  }
  if (filters.terminalId) {
    where.push('terminal_id = :terminalId');
    replacements.terminalId = filters.terminalId;
  }
  return where;
}

function addArrayFilter(where, replacements, column, key, values) {
  if (!values.length) return;
  where.push(`${column} IN (:${key})`);
  replacements[key] = values;
}

async function preparePage(database, filters, filterPayload) {
  const filterDigest = digest(filterPayload);
  let highWater;
  let lastSequence = filters.afterSequence;
  if (filters.cursor) {
    const cursor = decodeCursor(filters.cursor);
    if (
      cursor.endpoint !== filters.endpoint ||
      cursor.direction !== filters.direction ||
      cursor.filterDigest !== filterDigest
    ) {
      throw new ApiError(400, 'INVALID_CURSOR', '分页游标与当前筛选不匹配');
    }
    highWater = decimal(cursor.highWater, 'cursor.highWater');
    lastSequence = decimal(cursor.lastSequence, 'cursor.lastSequence');
  } else {
    const table = filters.endpoint === 'observations' ? 'observations' : 'monitor_changes';
    const [row] = await database.query(
      `SELECT COALESCE(MAX(sequence), 0)::text AS "highWater" FROM apple_purchase_sync.${table}`,
      { type: QueryTypes.SELECT }
    );
    highWater = row.highWater;
  }
  return { ...filters, filterDigest, highWater, lastSequence };
}

function pagePayload(filters, items, hasMore) {
  const lastSequence = items.at(-1)?.sequence;
  return {
    limit: filters.limit,
    direction: filters.direction,
    hasMore,
    nextCursor:
      hasMore && lastSequence
        ? encodeCursor({
          endpoint: filters.endpoint,
          direction: filters.direction,
          filterDigest: filters.filterDigest,
          highWater: filters.highWater,
          lastSequence,
          expiresAt: Date.now() + CURSOR_TTL_MS,
        })
        : null,
    highWaterSequence: String(filters.highWater),
  };
}

/** 查询有货观察，固定首次高水位并输出字符串序号。 @returns {Promise<Object>} 页面 */
async function listObservations(query) {
  const database = getReadDatabase();
  try {
    const filters = parseQuery(query, 'observations', ['city', 'storeId', 'partNumber']);
    Object.assign(filters, {
      cities: list(query, 'city'),
      storeIds: list(query, 'storeId'),
      partNumbers: list(query, 'partNumber'),
    });
    const filterPayload = {
      ...filters,
      cursor: undefined,
      afterSequence: undefined,
      limit: undefined,
    };
    const page = await preparePage(database, filters, filterPayload);
    const replacements = { highWater: page.highWater, limit: page.limit + 1 };
    const where = buildWhere(
      page,
      'observation.sequence',
      'observation.response_received_at',
      replacements
    );
    addArrayFilter(where, replacements, 'observation.city', 'cities', page.cities);
    addArrayFilter(where, replacements, 'observation.store_id', 'storeIds', page.storeIds);
    addArrayFilter(where, replacements, 'observation.part_number', 'partNumbers', page.partNumbers);
    const rows = await database.query(
      `SELECT observation.sequence::text AS sequence, observation.terminal_id AS "terminalId",
        observation.observation_id AS "observationId",
        observation.source_sequence::text AS "sourceSequence",
        observation.response_received_at AS "responseReceivedAt",
        observation.ingested_at AS "ingestedAt", observation.city,
        observation.store_id AS "storeId", observation.official_store_id AS "officialStoreId",
        observation.store_name AS "storeName", observation.part_number AS "partNumber",
        observation.product_id AS "productId", observation.product_name AS "productName",
        observation.specification, observation.official_title AS "officialTitle",
        observation.color, observation.storage, observation.family, observation.availability
       FROM apple_purchase_sync.observations AS observation
       WHERE ${where.join(' AND ')}
       ORDER BY observation.sequence ${page.direction === 'asc' ? 'ASC' : 'DESC'}
       LIMIT :limit`,
      { replacements, type: QueryTypes.SELECT }
    );
    const hasMore = rows.length > page.limit;
    const items = rows.slice(0, page.limit).map(row => ({
      ...row,
      sequence: String(row.sequence),
      sourceSequence: String(row.sourceSequence),
      responseReceivedAt: dateIso(row.responseReceivedAt),
      ingestedAt: dateIso(row.ingestedAt),
    }));
    return { apiVersion: '1', items, page: pagePayload(page, items, hasMore) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '有货记录查询暂不可用');
  }
}

/** 查询独立监控变更历史。 @returns {Promise<Object>} 页面 */
async function listMonitorChanges(query) {
  const database = getReadDatabase();
  try {
    const filters = parseQuery(query, 'monitor-changes', ['monitorId', 'changeType', 'taskId']);
    Object.assign(filters, {
      monitorIds: list(query, 'monitorId'),
      changeTypes: list(query, 'changeType', value => CHANGE_TYPES.includes(value)),
      taskIds: list(query, 'taskId'),
    });
    const filterPayload = {
      ...filters,
      cursor: undefined,
      afterSequence: undefined,
      limit: undefined,
    };
    const page = await preparePage(database, filters, filterPayload);
    const replacements = { highWater: page.highWater, limit: page.limit + 1 };
    const where = buildWhere(
      page,
      'monitor_change.sequence',
      'monitor_change.changed_at',
      replacements
    );
    addArrayFilter(where, replacements, 'monitor_change.monitor_id', 'monitorIds', page.monitorIds);
    addArrayFilter(
      where,
      replacements,
      'monitor_change.change_type',
      'changeTypes',
      page.changeTypes
    );
    addArrayFilter(where, replacements, 'monitor_change.task_id', 'taskIds', page.taskIds);
    const rows = await database.query(
      `SELECT monitor_change.sequence::text AS sequence,
        monitor_change.terminal_id AS "terminalId", monitor_change.event_id AS "eventId",
        monitor_change.source_sequence::text AS "sourceSequence",
        monitor_change.monitor_id AS "monitorId", monitor_change.monitor_name AS "monitorName",
        monitor_change.change_type AS "changeType", monitor_change.changed_at AS "changedAt",
        monitor_change.changed_at_ms AS "changedAtMs",
        monitor_change.previous_revision AS "previousRevision", monitor_change.revision,
        monitor_change.before_json AS before, monitor_change.after_json AS after,
        monitor_change.changes_json AS changes, monitor_change.source,
        monitor_change.task_id AS "taskId", monitor_change.ingested_at AS "ingestedAt"
       FROM apple_purchase_sync.monitor_changes AS monitor_change
       WHERE ${where.join(' AND ')}
       ORDER BY monitor_change.sequence ${page.direction === 'asc' ? 'ASC' : 'DESC'}
       LIMIT :limit`,
      { replacements, type: QueryTypes.SELECT }
    );
    const hasMore = rows.length > page.limit;
    const items = rows.slice(0, page.limit).map(row => ({
      ...row,
      sequence: String(row.sequence),
      sourceSequence: String(row.sourceSequence),
      changedAt: dateIso(row.changedAt),
      ingestedAt: dateIso(row.ingestedAt),
    }));
    return { apiVersion: '1', items, page: pagePayload(page, items, hasMore) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '监控变更查询暂不可用');
  }
}

/** 返回当前用户模块权限范围内的终端状态。 @returns {Promise<Object>} 状态 */
async function status() {
  const database = getReadDatabase();
  try {
    const rows = await database.query(
      `SELECT id AS "terminalId", name, enabled, last_seen_at AS "lastSeenAt",
        last_success_at AS "lastSuccessAt", observation_high_water::text AS observations,
        monitor_change_high_water::text AS "monitorChanges", source_history AS "sourceHistory"
       FROM apple_purchase_sync.terminals ORDER BY created_at ASC`,
      { type: QueryTypes.SELECT }
    );
    return {
      apiVersion: '1',
      items: rows.map(row => ({
        terminalId: row.terminalId,
        name: row.name,
        enabled: row.enabled,
        lastSeenAt: row.lastSeenAt ? dateIso(row.lastSeenAt) : null,
        lastSuccessAt: row.lastSuccessAt ? dateIso(row.lastSuccessAt) : null,
        highWater: {
          observations: String(row.observations),
          monitorChanges: String(row.monitorChanges),
        },
        sourceHistory: row.sourceHistory,
      })),
      serverTime: new Date().toISOString(),
    };
  } catch (error) {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '同步状态查询暂不可用');
  }
}

/** 查询全局版本高水位，供 SSE 首帧和断线补齐。 @returns {Promise<Object>} 高水位 */
async function highWater() {
  const database = getReadDatabase();
  try {
    const [row] = await database.query(
      `SELECT
        COALESCE((SELECT MAX(sequence) FROM apple_purchase_sync.observations), 0)::text AS observations,
        COALESCE((SELECT MAX(sequence) FROM apple_purchase_sync.monitor_changes), 0)::text AS "monitorChanges"`,
      { type: QueryTypes.SELECT }
    );
    return { observations: String(row.observations), monitorChanges: String(row.monitorChanges) };
  } catch (error) {
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '库存版本查询暂不可用');
  }
}

const AVAILABILITY_FILTER_COLUMNS = {
  city: 'city',
  storeId: 'store_id',
  family: 'family',
  color: 'color',
  storage: 'storage',
  terminalId: 'terminal_id',
};
const AVAILABILITY_PAGE_SIZES = [20, 50, 100, 200];
const DAY_MS = 86_400_000;
const AVAILABILITY_MAX_FILTER_VALUES = 100;
const AVAILABILITY_MAX_FILTER_LENGTH = 128;
const AVAILABILITY_TREND_DAYS = { hour: 31, day: 366 };

function readAvailabilityFilters(query, extra) {
  const dimensions = Object.keys(AVAILABILITY_FILTER_COLUMNS);
  const allowed = new Set(['snapshot', 'from', 'to', ...dimensions, ...extra]);
  if (Object.keys(query).some(key => !allowed.has(key))) {
    throw ApiError.badRequest('存在不支持的有货查询参数');
  }
  const filters = {
    snapshot: decimal(scalar(query, 'snapshot'), 'snapshot'),
    from: scalar(query, 'from'),
    to: scalar(query, 'to'),
  };
  for (const key of ['from', 'to']) {
    const value = filters[key];
    if (
      value !== undefined &&
      (!UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value)) || dateIso(value) !== value)
    ) {
      throw ApiError.badRequest(`${key} 必须是有效的三位毫秒 UTC 时间`);
    }
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    throw ApiError.badRequest('from 不能晚于 to');
  }
  for (const key of dimensions) {
    const raw = query[key];
    const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    if (
      values.length > AVAILABILITY_MAX_FILTER_VALUES ||
      values.some(
        value =>
          typeof value !== 'string' ||
          !value.trim() ||
          value.length > AVAILABILITY_MAX_FILTER_LENGTH ||
          (key === 'terminalId' && !UUID_PATTERN.test(value))
      )
    ) {
      throw ApiError.badRequest(`${key} 查询值无效`);
    }
    filters[key] = [...new Set(values)].sort();
  }
  return filters;
}

function availabilityWhere(filters, replacements) {
  const conditions = ['o.sequence <= CAST(:snapshot AS bigint)'];
  replacements.snapshot = filters.snapshot;
  for (const [key, operator] of [
    ['from', '>='],
    ['to', '<='],
  ]) {
    if (!filters[key]) continue;
    conditions.push(`o.response_received_at ${operator} :${key}`);
    replacements[key] = filters[key];
  }
  for (const [key, column] of Object.entries(AVAILABILITY_FILTER_COLUMNS)) {
    addArrayFilter(conditions, replacements, `o.${column}`, key, filters[key]);
  }
  return conditions.join(' AND ');
}

function availabilityError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(503, 'DATABASE_UNAVAILABLE', '有货记录查询暂不可用');
}

/** 返回同步记录中的候选值、可查询时间范围与快照版本。 @returns {Promise<Object>} 查询选项 */
async function availabilityOptions() {
  try {
    const database = getReadDatabase();
    const [result] = await database.query(
      `WITH stores AS (
         SELECT DISTINCT city, store_id AS id, store_name AS name
         FROM apple_purchase_sync.observations
       )
       SELECT
         COALESCE(MAX(o.sequence), 0)::text AS snapshot,
         MIN(o.response_received_at) AS "firstDetectedAt",
         MAX(o.response_received_at) AS "lastDetectedAt",
         ARRAY_AGG(DISTINCT o.city ORDER BY o.city) FILTER (WHERE o.city <> '') AS cities,
         ARRAY_AGG(DISTINCT o.family ORDER BY o.family) AS families,
         ARRAY_AGG(DISTINCT o.color ORDER BY o.color) FILTER (WHERE o.color <> '') AS colors,
         ARRAY_AGG(DISTINCT o.storage ORDER BY o.storage) FILTER (WHERE o.storage <> '') AS capacities,
         (SELECT jsonb_agg(stores ORDER BY city, name, id) FROM stores) AS stores,
         (SELECT MAX(last_success_at) FROM apple_purchase_sync.terminals) AS "lastSyncAt",
         (SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name, id)
            FROM apple_purchase_sync.terminals) AS terminals
       FROM apple_purchase_sync.observations o`,
      { type: QueryTypes.SELECT }
    );
    return {
      ...result,
      firstDetectedAt: result.firstDetectedAt ? dateIso(result.firstDetectedAt) : null,
      lastDetectedAt: result.lastDetectedAt ? dateIso(result.lastDetectedAt) : null,
      lastSyncAt: result.lastSyncAt ? dateIso(result.lastSyncAt) : null,
      cities: result.cities || [],
      families: result.families || [],
      colors: result.colors || [],
      capacities: result.capacities || [],
      stores: result.stores || [],
      terminals: result.terminals || [],
    };
  } catch (error) {
    throw availabilityError(error);
  }
}

/** 以检测时间及入库序号查询独立页面，固定快照并返回匹配总数。 @param {Object} query 筛选 @returns {Promise<Object>} 明细 */
async function availabilityRecords(query) {
  try {
    const filters = readAvailabilityFilters(query, ['limit', 'cursor']);
    const limit = Number(scalar(query, 'limit') ?? AVAILABILITY_PAGE_SIZES[0]);
    if (!AVAILABILITY_PAGE_SIZES.includes(limit)) {
      throw ApiError.badRequest('每页条数须为 20、50、100 或 200');
    }
    const filterDigest = digest({ endpoint: 'availability-records', ...filters, limit });
    const encodedCursor = scalar(query, 'cursor');
    const replacements = { limit: limit + 1 };
    const where = availabilityWhere(filters, replacements);
    let after = '';
    if (encodedCursor !== undefined) {
      const cursor = decodeCursor(encodedCursor);
      if (cursor.filterDigest !== filterDigest || !cursor.detectedAt) {
        throw new ApiError(400, 'INVALID_CURSOR', '分页游标与当前筛选不匹配');
      }
      replacements.lastSequence = decimal(cursor.sequence, 'sequence');
      replacements.lastDetectedAt = cursor.detectedAt;
      after =
        'AND (o.response_received_at, o.sequence) < (:lastDetectedAt, CAST(:lastSequence AS bigint))';
    }
    const [result] = await getReadDatabase().query(
      `SELECT
         (SELECT COUNT(*)::text FROM apple_purchase_sync.observations o WHERE ${where}) AS total,
         COALESCE((SELECT jsonb_agg(item ORDER BY item."detectedAt" DESC, item.sort_key DESC)
           FROM (
             SELECT o.sequence AS sort_key, o.sequence::text AS sequence,
               o.response_received_at AS "detectedAt", o.ingested_at AS "ingestedAt",
               o.observation_id AS id, o.terminal_id AS "terminalId",
               o.city, o.store_id AS "storeId", o.store_name AS store,
               o.family, o.color, o.storage, o.product_name AS "productName",
               o.part_number AS "partNumber"
             FROM apple_purchase_sync.observations o
             WHERE ${where} ${after}
             ORDER BY o.response_received_at DESC, o.sequence DESC
             LIMIT :limit
           ) item), '[]'::jsonb) AS items`,
      { replacements, type: QueryTypes.SELECT }
    );
    const hasMore = result.items.length > limit;
    const items = result.items.slice(0, limit).map(({ sort_key: _sortKey, ...item }) => ({
      ...item,
      detectedAt: dateIso(item.detectedAt),
      ingestedAt: dateIso(item.ingestedAt),
    }));
    let nextCursor = null;
    if (hasMore) {
      const last = items.at(-1);
      nextCursor = encodeCursor({
        filterDigest,
        sequence: last.sequence,
        detectedAt: last.detectedAt,
        expiresAt: Date.now() + CURSOR_TTL_MS,
      });
    }
    return { items, total: Number(result.total), nextCursor };
  } catch (error) {
    throw availabilityError(error);
  }
}

/** 按北京时间整点或自然日统计匹配的有货观察。 @param {Object} query 筛选 @returns {Promise<Object>} 统计时间桶 */
async function availabilityTrend(query) {
  try {
    const filters = readAvailabilityFilters(query, ['interval']);
    const interval = scalar(query, 'interval');
    if (!['hour', 'day'].includes(interval) || !filters.from || !filters.to) {
      throw ApiError.badRequest('统计需要开始、结束时间及 hour 或 day 粒度');
    }
    const maxDays = AVAILABILITY_TREND_DAYS[interval];
    if (Date.parse(filters.to) - Date.parse(filters.from) >= maxDays * DAY_MS) {
      throw new ApiError(400, 'TREND_RANGE_TOO_WIDE', `当前粒度最多统计 ${maxDays} 天`);
    }
    const replacements = { interval };
    const where = availabilityWhere(filters, replacements);
    const rows = await getReadDatabase().query(
      `SELECT date_trunc(:interval, o.response_received_at AT TIME ZONE 'Asia/Shanghai')
           AT TIME ZONE 'Asia/Shanghai' AS time,
         o.family, COUNT(*)::text AS count
       FROM apple_purchase_sync.observations o
       WHERE ${where}
       GROUP BY 1, 2 ORDER BY 1, 2`,
      { replacements, type: QueryTypes.SELECT }
    );
    return {
      points: rows.map(row => ({ ...row, time: dateIso(row.time), count: Number(row.count) })),
    };
  } catch (error) {
    throw availabilityError(error);
  }
}

module.exports = {
  highWater,
  listMonitorChanges,
  listObservations,
  status,
  availabilityOptions,
  availabilityRecords,
  availabilityTrend,
};
