const { createHash } = require('crypto');
const ApiError = require('../utils/ApiError');
const p = require('./monitorPolicy');
const DAY_MS = 86400000;
const ENTRY_FIELDS = [
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
/** 北京时间最近30个自然日边界。 @param {Date} now 当前时间 @returns {Object} 边界 */
function retention(now = new Date()) {
  const today = new Date(+now + 8 * 3600000).toISOString().slice(0, 10);
  return { today, first: new Date(Date.parse(today) - 29 * DAY_MS).toISOString().slice(0, 10) };
}
/** 严格自然日验证。 @param {string} value 日期 @returns {string} 日期 */
function date(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw ApiError.badRequest('日志日期无效');
  return value;
}
/** 固定格式的毫秒时间。 @param {string} value 时间 @returns {string} ISO时间 */
function instant(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3,7}(Z|\+00:00)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw ApiError.badRequest('日志时间无效');
  date(value.slice(0, 10));
  return new Date(value).toISOString();
}
/** 不可变载荷摘要。 @param {*} value 数据 @returns {string} 摘要 */
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** 转义字面LIKE搜索。 @param {string} value 文本 @returns {string} 匹配值 */
function literalSearch(value) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}
/** 验证单片段，不在错误消息中包含原文。 @param {Object} value 输入 @returns {Object} 标准片段 */
function entry(value) {
  p.fields(value, ENTRY_FIELDS);
  const item = {};
  for (const key of ['id', 'localId', 'fileId']) item[key] = p.uuid(value[key]).toLowerCase();
  if (
    typeof value.fileName !== 'string' ||
    !/^Log\d{8}_[A-Za-z0-9_-]+\.txt$/.test(value.fileName) ||
    value.fileName.length > 255
  )
    throw ApiError.badRequest('日志文件名无效');
  item.fileName = value.fileName;
  item.businessDate = date(value.businessDate);
  item.loggedAt = value.loggedAt == null ? null : instant(value.loggedAt);
  if (item.loggedAt && retention(new Date(item.loggedAt)).today !== item.businessDate)
    throw ApiError.badRequest('日志时间与日期不一致');
  if (
    value.accountNumber != null &&
    (typeof value.accountNumber !== 'string' || !/^\d{1,64}$/.test(value.accountNumber))
  )
    throw ApiError.badRequest('日志账号编号无效');
  item.accountNumber = value.accountNumber ?? null;
  for (const key of ['lineNumber', 'partIndex', 'byteOffset'])
    item[key] = p.integer(
      value[key],
      key === 'lineNumber' ? 1 : 0,
      key === 'partIndex' ? 2147483647 : Number.MAX_SAFE_INTEGER
    );
  if (
    typeof value.message !== 'string' ||
    value.message.length > 16000 ||
    value.message.includes('\u0000')
  )
    throw ApiError.badRequest('日志片段正文无效');
  item.message = value.message;
  if (!['parsed', 'continuation', 'unparsed', 'encoding_error'].includes(value.parseState))
    throw ApiError.badRequest('日志解析标记无效');
  item.parseState = value.parseState;
  item.rawBase64 = value.rawBase64 ?? null;
  if (
    item.rawBase64 !== null &&
    (typeof item.rawBase64 !== 'string' ||
      item.rawBase64.length > 22000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.rawBase64))
  )
    throw ApiError.badRequest('日志原始字节无效');
  if ((item.parseState === 'encoding_error') !== (item.rawBase64 !== null))
    throw ApiError.badRequest('日志编码状态不一致');
  if (['unparsed', 'encoding_error'].includes(item.parseState) && item.accountNumber !== null)
    throw ApiError.badRequest('未识别日志不能指定账号');
  item.contextAt = value.contextAt == null ? null : instant(value.contextAt);
  if (item.contextAt && retention(new Date(item.contextAt)).today !== item.businessDate)
    throw ApiError.badRequest('日志排序时间与日期不一致');
  if (item.loggedAt && item.contextAt && item.loggedAt !== item.contextAt)
    throw ApiError.badRequest('有效日志时间与排序时间不一致');
  return item;
}
/** 验证查询；固定实例、业务日和有界分页。 @param {Object} value 输入 @param {Date} now 当前时间 @returns {Object} 标准查询 */
function query(value, now = new Date()) {
  p.fields(value, [
    'deviceId',
    'localId',
    'date',
    'account',
    'fromTime',
    'toTime',
    'keyword',
    'cursor',
    'limit',
  ]);
  const bounds = retention(now);
  const day = date(value.date);
  if (day < bounds.first || day > bounds.today)
    throw ApiError.badRequest('仅可查询最近30个北京时间日期');
  const result = {
    deviceId: p.uuid(value.deviceId).toLowerCase(),
    localId: p.uuid(value.localId).toLowerCase(),
    date: day,
  };
  if (value.account && value.account !== '__unassigned__' && !/^\d{1,64}$/.test(value.account))
    throw ApiError.badRequest('账号编号无效');
  if (value.account != null && typeof value.account !== 'string')
    throw ApiError.badRequest('账号编号无效');
  result.account = value.account || '';
  if (value.limit != null && typeof value.limit !== 'string' && typeof value.limit !== 'number')
    throw ApiError.badRequest('分页数量无效');
  for (const key of ['fromTime', 'toTime']) {
    if (
      value[key] &&
      (typeof value[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value[key]))
    )
      throw ApiError.badRequest('时间段无效');
    result[key] = value[key] || '';
  }
  if (result.fromTime && result.toTime && result.fromTime > result.toTime)
    throw ApiError.badRequest('开始时间不能晚于结束时间');
  result.keyword = value.keyword == null ? '' : p.shortText(value.keyword, 200, true);
  result.limit = p.integer(Number(value.limit ?? 50), 1, 100);
  result.cursor = value.cursor == null ? '' : p.shortText(value.cursor, 2000);
  return result;
}
module.exports = { retention, date, instant, digest, literalSearch, entry, query };
