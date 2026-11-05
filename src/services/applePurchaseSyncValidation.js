const ApiError = require('../utils/ApiError');

const MAX_BODY_BYTES = 1_048_576;
const MAX_BATCH_EVENTS = 500;
const MAX_JSON_DEPTH = 20;
const MAX_MONITOR_EVENT_BYTES = 65_536;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^\d+$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORBIDDEN_JSON_KEY =
  /(authorization|token|password|cookie|credential|id.?card|identity|proxy|account)/i;
const CHANGE_TYPES = Object.freeze([
  'baseline_created',
  'configuration_updated',
  'monitor_started',
  'monitor_stopped',
  'task_demand_updated',
]);
const CHANGE_SOURCES = Object.freeze(['user', 'system', 'task', 'migration']);
const COMPLETENESS = Object.freeze([
  'complete_from_available_from',
  'unknown_before_available_from',
]);

function validationError(path, reason, code = 'VALIDATION_ERROR') {
  return new ApiError(400, code, '请求字段不符合 v1 契约', [{ path, reason }]);
}

function assertPlainObject(value, path, nullable = false) {
  if (nullable && value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(path, nullable ? 'expected_object_or_null' : 'expected_object');
  }
}

function assertExactKeys(value, path, required, optional = []) {
  assertPlainObject(value, path);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw validationError(`${path}.${unknown}`.replace(/^\./, ''), 'unknown_field');
  const missing = required.find(key => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) throw validationError(`${path}.${missing}`.replace(/^\./, ''), 'required');
}

function assertString(value, path, minimum, maximum, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw validationError(path, nullable ? 'invalid_nullable_string' : 'invalid_string');
  }
}

function assertUuid(value, path) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw validationError(path, 'invalid_uuid');
  }
}

function parseUtc(value, path, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UTC_PATTERN.test(value)) {
    throw validationError(path, 'invalid_utc_timestamp');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw validationError(path, 'invalid_utc_timestamp');
  }
  return milliseconds;
}

function assertDecimal(value, path) {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw validationError(path, 'invalid_decimal_string');
  }
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > 9_223_372_036_854_775_807n) throw new Error('range');
  } catch (_error) {
    throw validationError(path, 'decimal_out_of_range');
  }
}

function assertSafeMilliseconds(value, timestamp, path) {
  if (!Number.isSafeInteger(value) || value < 0) throw validationError(path, 'unsafe_integer');
  if (value !== timestamp) throw validationError(path, 'timestamp_mismatch');
}

function assertOptionalRevision(value, path) {
  if (value === null) return;
  if (!Number.isInteger(value) || value < 0)
    throw validationError(path, 'invalid_nonnegative_integer');
}

function validateJson(value, path, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw validationError(path, 'json_too_deep');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw validationError(path, 'invalid_json_number');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJson(item, `${path}[${index}]`, depth + 1));
    return;
  }
  assertPlainObject(value, path);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_JSON_KEY.test(key))
      throw validationError(`${path}.${key}`, 'sensitive_field_forbidden');
    validateJson(child, `${path}.${key}`, depth + 1);
  }
}

function validateSourceBoundary(value, path) {
  assertExactKeys(value, path, ['availableFrom', 'completeness']);
  parseUtc(value.availableFrom, `${path}.availableFrom`, true);
  if (!COMPLETENESS.includes(value.completeness)) {
    throw validationError(`${path}.completeness`, 'invalid_enum');
  }
}

function validateSourceHistory(value) {
  assertExactKeys(value, 'sourceHistory', ['observations', 'monitorChanges']);
  validateSourceBoundary(value.observations, 'sourceHistory.observations');
  validateSourceBoundary(value.monitorChanges, 'sourceHistory.monitorChanges');
}

const OBSERVATION_FIELDS = [
  'observationId',
  'sourceSequence',
  'responseReceivedAt',
  'responseReceivedAtMs',
  'city',
  'storeId',
  'officialStoreId',
  'storeName',
  'partNumber',
  'productId',
  'productName',
  'specification',
  'officialTitle',
  'color',
  'storage',
  'family',
  'availability',
];

function validateObservation(value, index) {
  const path = `observations[${index}]`;
  assertExactKeys(value, path, OBSERVATION_FIELDS);
  assertString(value.observationId, `${path}.observationId`, 1, 128);
  assertDecimal(value.sourceSequence, `${path}.sourceSequence`);
  const timestamp = parseUtc(value.responseReceivedAt, `${path}.responseReceivedAt`);
  assertSafeMilliseconds(value.responseReceivedAtMs, timestamp, `${path}.responseReceivedAtMs`);
  assertString(value.city, `${path}.city`, 0, 128, true);
  assertString(value.storeId, `${path}.storeId`, 1, 128);
  assertString(value.officialStoreId, `${path}.officialStoreId`, 0, 64, true);
  assertString(value.storeName, `${path}.storeName`, 1, 256);
  assertString(value.partNumber, `${path}.partNumber`, 1, 128);
  assertString(value.productId, `${path}.productId`, 0, 128, true);
  assertString(value.productName, `${path}.productName`, 1, 256);
  assertString(value.specification, `${path}.specification`, 1, 512);
  assertString(value.officialTitle, `${path}.officialTitle`, 0, 512, true);
  assertString(value.color, `${path}.color`, 0, 128, true);
  assertString(value.storage, `${path}.storage`, 0, 64, true);
  assertString(value.family, `${path}.family`, 1, 64);
  if (value.availability !== 'available') {
    throw validationError(`${path}.availability`, 'invalid_enum');
  }
}

const MONITOR_FIELDS = [
  'eventId',
  'sourceSequence',
  'monitorId',
  'monitorName',
  'changeType',
  'changedAt',
  'changedAtMs',
  'previousRevision',
  'revision',
  'before',
  'after',
  'changes',
  'source',
  'taskId',
];

function validateMonitorChange(value, index) {
  const path = `monitorChanges[${index}]`;
  assertExactKeys(value, path, MONITOR_FIELDS);
  assertString(value.eventId, `${path}.eventId`, 1, 128);
  assertDecimal(value.sourceSequence, `${path}.sourceSequence`);
  assertString(value.monitorId, `${path}.monitorId`, 1, 128);
  assertString(value.monitorName, `${path}.monitorName`, 1, 256);
  if (!CHANGE_TYPES.includes(value.changeType)) {
    throw validationError(`${path}.changeType`, 'invalid_enum');
  }
  const timestamp = parseUtc(value.changedAt, `${path}.changedAt`);
  assertSafeMilliseconds(value.changedAtMs, timestamp, `${path}.changedAtMs`);
  assertOptionalRevision(value.previousRevision, `${path}.previousRevision`);
  assertOptionalRevision(value.revision, `${path}.revision`);
  assertPlainObject(value.before, `${path}.before`, true);
  assertPlainObject(value.after, `${path}.after`, true);
  validateJson(value.before, `${path}.before`);
  validateJson(value.after, `${path}.after`);
  if (!Array.isArray(value.changes) || value.changes.length > 200) {
    throw validationError(`${path}.changes`, 'invalid_array');
  }
  validateJson(value.changes, `${path}.changes`);
  if (!CHANGE_SOURCES.includes(value.source))
    throw validationError(`${path}.source`, 'invalid_enum');
  assertString(value.taskId, `${path}.taskId`, 0, 128, true);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_MONITOR_EVENT_BYTES) {
    throw validationError(path, 'event_too_large');
  }
}

/** 严格校验冻结 v1 批次，拒绝未知字段和隐式类型转换。 @param {unknown} value 请求 JSON @returns {Object} 已校验对象 */
function validateBatch(value) {
  assertExactKeys(value, '', [
    'contractVersion',
    'batchId',
    'terminalId',
    'sentAt',
    'mode',
    'sourceHistory',
    'observations',
    'monitorChanges',
  ]);
  if (value.contractVersion !== '1') {
    throw validationError('contractVersion', 'unsupported_version', 'UNSUPPORTED_CONTRACT_VERSION');
  }
  assertUuid(value.batchId, 'batchId');
  assertUuid(value.terminalId, 'terminalId');
  parseUtc(value.sentAt, 'sentAt');
  if (!['live', 'backfill'].includes(value.mode)) throw validationError('mode', 'invalid_enum');
  validateSourceHistory(value.sourceHistory);
  if (!Array.isArray(value.observations)) throw validationError('observations', 'expected_array');
  if (!Array.isArray(value.monitorChanges))
    throw validationError('monitorChanges', 'expected_array');
  const total = value.observations.length + value.monitorChanges.length;
  if (total === 0) throw validationError('observations', 'empty_batch');
  if (total > MAX_BATCH_EVENTS) {
    throw new ApiError(413, 'TOO_MANY_EVENTS', '批次事件数量超过 v1 上限');
  }
  value.observations.forEach(validateObservation);
  value.monitorChanges.forEach(validateMonitorChange);
  return value;
}

/** 解析原始 UTF-8 JSON，避免通用 10 MiB 解析器绕过同步上限。 @param {Buffer} raw 原始正文 @returns {Object} 已校验批次 */
function parseBatchBody(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) throw validationError('', 'body_required');
  if (raw.length > MAX_BODY_BYTES) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 v1 上限');
  }
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (_error) {
    throw validationError('', 'invalid_json');
  }
  return validateBatch(value);
}

module.exports = {
  CHANGE_TYPES,
  MAX_BATCH_EVENTS,
  MAX_BODY_BYTES,
  UUID_PATTERN,
  UTC_PATTERN,
  parseBatchBody,
  parseUtc,
  validateBatch,
};
