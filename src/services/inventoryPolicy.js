const ApiError = require('../utils/ApiError');

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  intervalSeconds: 300,
  hourlyRequests: 1200,
  dailyRequests: 25000,
  dailyBytes: 536870912,
  dailyProxyExtractions: 400,
  notificationsEnabled: false,
  groupName: '',
  silentStart: '',
  silentEnd: '',
  notificationFilters: {},
  notificationTtlSeconds: 120,
  samplesDays: 7,
  eventsDays: 90,
  hourlyDays: 365,
});
const FILTER_FIELDS = {
  cities: 'city',
  stores: 'storeCode',
  models: 'model',
  capacities: 'capacity',
  colors: 'color',
  skus: 'sku',
};
const COLORS = {
  'Space Black': '深空黑色',
  'Cloud White': '云白色',
  'Light Gold': '浅金色',
  'Sky Blue': '天蓝色',
  Black: '黑色',
  White: '白色',
  Lavender: '薰衣草紫色',
  Sage: '鼠尾草绿色',
  'Mist Blue': '雾蓝色',
  Silver: '银色',
  'Cosmic Orange': '星宇橙色',
  'Deep Blue': '深蓝色',
  'Soft Pink': '浅粉色',
  Pink: '粉色',
  Teal: '深青色',
  Ultramarine: '群青色',
};

/** 从官方目录标题分离配置，不按型号猜测 SKU。 @param {Object} item 目录项 @returns {Object} 配置 */
function productDetails(item) {
  const match = item.title?.match(/^(iPhone .+?)\s+(\d+\s*(?:GB|TB))\s+(.+)$/i);
  if (!match) throw new Error('INVALID_PRODUCT_SPEC');
  return {
    ...item,
    model: match[1],
    capacity: match[2].replace(/\s/g, '').toUpperCase(),
    color: COLORS[match[3]] || match[3],
  };
}
/** 校验通用多选过滤器。 @param {Object} input 输入 @returns {Object} 规范过滤器 */
function parseFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw ApiError.badRequest('筛选条件必须为对象');
  const filters = {};
  for (const [key, field] of Object.entries(FILTER_FIELDS)) {
    if (input[key] === undefined || input[key] === '') continue;
    const values = Array.isArray(input[key])
      ? input[key]
      : typeof input[key] === 'string'
        ? input[key].split(',')
        : null;
    if (
      !values ||
      values.length > 200 ||
      values.some(x => typeof x !== 'string' || !x.trim() || x.length > 100)
    )
      throw ApiError.badRequest('筛选值无效');
    filters[field] = [...new Set(values.map(x => x.trim()))];
  }
  return filters;
}
/** 判断快照是否匹配过滤器。 @param {Object} row 数据 @param {Object} filters 过滤器 @returns {boolean} 匹配 */
function matches(row, filters) {
  return Object.entries(filters).every(([key, values]) => values.includes(row[key]));
}
/** 严格校验配置白名单。 @param {Object} value 配置 @returns {Object} 配置 */
function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw ApiError.badRequest('配置无效');
  for (const key of Object.keys(value))
    if (!(key in DEFAULT_CONFIG)) throw ApiError.badRequest(`未知设置：${key}`);
  const config = { ...DEFAULT_CONFIG, ...value };
  for (const key of ['enabled', 'notificationsEnabled'])
    if (typeof config[key] !== 'boolean') throw ApiError.badRequest('开关必须为布尔值');
  const ranges = {
    intervalSeconds: [60, 3600],
    hourlyRequests: [1, 3600],
    dailyRequests: [1, 86400],
    dailyBytes: [1048576, 10737418240],
    dailyProxyExtractions: [1, 1000],
    notificationTtlSeconds: [30, 300],
    samplesDays: [1, 30],
    eventsDays: [7, 180],
    hourlyDays: [90, 730],
  };
  for (const [key, [min, max]] of Object.entries(ranges))
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max)
      throw ApiError.badRequest(`${key} 范围为 ${min}–${max}`);
  if (typeof config.groupName !== 'string' || config.groupName.length > 80)
    throw ApiError.badRequest('群名称过长');
  for (const key of ['silentStart', 'silentEnd'])
    if (
      typeof config[key] !== 'string' ||
      (config[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(config[key]))
    )
      throw ApiError.badRequest('静默时间格式应为 HH:mm');
  if (Boolean(config.silentStart) !== Boolean(config.silentEnd))
    throw ApiError.badRequest('请同时设置静默起止时间');
  if (Object.keys(config.notificationFilters || {}).some(key => !(key in FILTER_FIELDS)))
    throw ApiError.badRequest('通知筛选字段无效');
  parseFilters(config.notificationFilters);
  return config;
}
/** 计算当前状态，旧结果不会覆盖失败或暂停。 @param {Object} row 快照 @param {Object} context 范围状态 @param {number} now 毫秒 @returns {string} 状态 */
function displayStatus(row, context, now) {
  if (!context.enabled) return 'disabled';
  if (context.supported === false) return 'unsupported';
  if (context.paused) return 'paused';
  if (row?.error) return 'error';
  if (!row?.observedAt) return 'unknown';
  if (row.expiresAt <= now) return 'stale';
  return row.status;
}
/** 生成去重后的有效状态转换；保留中断语义。 @param {Object|null} previous 旧快照 @param {Object} row 有效结果 @param {number} now 时间 @param {number} interval 周期秒 @returns {Object} 快照与事件 */
function transition(previous, row, now, interval) {
  if (!['in_stock', 'out_of_stock'].includes(row.status)) throw new Error('INVALID_STOCK_STATE');
  let kind = null;
  if (row.status === 'in_stock') {
    if (!previous?.observedAt) kind = 'first';
    else if (
      previous.status === 'out_of_stock' &&
      previous.expiresAt > now &&
      !previous.interrupted &&
      !previous.error
    )
      kind = 'arrival';
    else if (previous.expiresAt <= now || previous.interrupted || previous.error) {
      // 短暂失败后原有货恢复只更新快照，不重复刷屏；长空窗另记恢复观察。
      if (previous.status !== 'in_stock' || previous.expiresAt <= now || previous.hardInterrupted)
        kind = 'recovery';
    }
  }
  return {
    snapshot: {
      ...row,
      observedAt: now,
      expiresAt: now + interval * 2000,
      lastAttemptAt: now,
      error: null,
      interrupted: false,
      hardInterrupted: false,
    },
    kind,
  };
}
/** 北京时间静默窗口，支持跨午夜。 @param {Object} config 配置 @param {number} now 时间 @returns {boolean} 静默 */
function isSilent(config, now) {
  if (!config.silentStart || !config.silentEnd) return false;
  const time = new Date(now + 8 * 3600000).toISOString().slice(11, 16);
  return config.silentStart <= config.silentEnd
    ? time >= config.silentStart && time < config.silentEnd
    : time >= config.silentStart || time < config.silentEnd;
}
/** 构建固定全国任务，门店缺失不会缩小轮次分母。 @param {Array} products 商品 @param {Array} stores 门店 @returns {Array} 任务 */
function buildTasks(products, stores) {
  const tasks = [];
  // 已有小样本证明六个区域可联合覆盖大陆目录，缺失项仍进入覆盖失败。
  const locations = ['100000', '200062', '510623', '400010', '430022', '110042'];
  for (let i = 0; i < products.length; i += 5)
    for (const location of locations)
      tasks.push({
        skus: products.slice(i, i + 5).map(x => x.sku),
        location,
        status: 'pending',
        attempts: 0,
      });
  if (!stores.length) return [];
  return tasks;
}
/** 校验标题配置一致性（官网中文与目录英文颜色已标准化）。 @param {Object} row 返回项 @param {Object} product 目录 @returns {boolean} 一致 */
function validProductRow(row, product) {
  if (!product || row.sku !== product.sku) return false;
  try {
    const details = productDetails({ title: row.title });
    return (
      details.model.toLowerCase() === product.model.toLowerCase() &&
      details.capacity === product.capacity &&
      details.color === product.color
    );
  } catch (_error) {
    return false;
  }
}
module.exports = {
  DEFAULT_CONFIG,
  FILTER_FIELDS,
  productDetails,
  parseFilters,
  matches,
  validateConfig,
  displayStatus,
  transition,
  isSilent,
  buildTasks,
  validProductRow,
};
