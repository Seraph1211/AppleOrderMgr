const { createHash } = require('crypto');
const { createProductKey, formatStorage } = require('./quotePricingCore');
const ApiError = require('../utils/ApiError');

const STORAGE_ORDER = Object.freeze([256, 512, 1024, 2048]);
const COLOR_ORDER = Object.freeze(['星光白色', '夜空色']);
const DEFAULT_MARKUP = 50;
const MAX_MARKUP_CENTS = 10000000;
const MAX_PRICE_CENTS = 9999999999;
const PREMIUM_UNIT_CENTS = 1000;

/** 构造受控来源错误。 @returns {ApiError} 错误 */
function sourceUnavailable() {
  return new ApiError(503, 'QUOTE_SOURCE_UNAVAILABLE', '报价数据暂不可用');
}

/** 严格解析金额到整数分，不接受隐式类型转换。 @param {unknown} value 金额 @returns {number} 分 */
function moneyToCents(value) {
  if (
    !['number', 'string'].includes(typeof value) ||
    !/^-?\d+(?:\.\d{1,2})?$/.test(String(value))
  ) {
    throw ApiError.badRequest('金额必须为最多两位小数的有效数字');
  }
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents)) throw ApiError.badRequest('金额超出允许范围');
  return cents;
}

function normalizeSourcePrice(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return null;
  }
  try {
    const cents = moneyToCents(value);
    if (cents < 0 || cents > MAX_PRICE_CENTS) throw sourceUnavailable();
    return cents === 0 ? null : cents / 100;
  } catch (_error) {
    throw sourceUnavailable();
  }
}

/** 严格验证全国8款并保留仅后台需要的来源价格。 @param {Object} batch 来源 @returns {Object[]} 商品 */
function normalizeDuoSource(batch) {
  if (!batch || !Array.isArray(batch.items) || batch.items.length !== 8) throw sourceUnavailable();
  const sourceTime = new Date(batch.sourceUpdatedAt).getTime();
  if (!batch.sourceUpdatedAt || !Number.isFinite(sourceTime) || sourceTime > Date.now() + 60000) {
    throw sourceUnavailable();
  }
  const seen = new Set();
  return batch.items
    .map(row => {
      if (
        row.productModel !== 'Duo' ||
        !STORAGE_ORDER.includes(row.storageGb) ||
        !COLOR_ORDER.includes(row.color) ||
        !row.sourceUpdatedAt ||
        new Date(row.sourceUpdatedAt).getTime() !== sourceTime
      )
        throw sourceUnavailable();
      const productKey = createProductKey(row);
      if (seen.has(productKey)) throw sourceUnavailable();
      seen.add(productKey);
      return {
        productKey,
        productName: `iPhone Duo ${row.color} ${formatStorage(row.storageGb)}`,
        productModel: 'Duo',
        storageGb: row.storageGb,
        color: row.color,
        wholesalePrice: normalizeSourcePrice(row.wholesalePrice),
        officialPrice: normalizeSourcePrice(row.officialPrice),
      };
    })
    .sort(
      (left, right) =>
        left.storageGb - right.storageGb ||
        COLOR_ORDER.indexOf(left.color) - COLOR_ORDER.indexOf(right.color)
    );
}

/** 生成覆盖来源身份、全部价格和报价时间的稳定指纹。 @param {Object} batch 来源 @param {Object[]} items 商品 @returns {string} 指纹 */
function createSourceVersion(batch, items) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sourceUpdatedAt: new Date(batch.sourceUpdatedAt).toISOString(),
        items: items.map(item => [item.productKey, item.wholesalePrice, item.officialPrice]),
      })
    )
    .digest('hex');
}

/** 校验加价（含负值）并返回规范元值。 @param {unknown} value 金额 @returns {number} 元 */
function validateMarkup(value) {
  const cents = moneyToCents(value);
  if (Math.abs(cents) > MAX_MARKUP_CENTS) throw ApiError.badRequest('加价额须在-100000至100000元');
  return cents / 100;
}

/** 按分精度计算零售价，缺基价保持null。 @param {number|null} base 批发价 @param {number} markup 加价 @returns {number|null} 元 */
function calculateRetailPrice(base, markup) {
  const markupCents = moneyToCents(validateMarkup(markup));
  if (base === null) return null;
  const cents = moneyToCents(base) + markupCents;
  if (cents < 0 || cents > MAX_PRICE_CENTS) throw ApiError.badRequest('调整后的零售价超出允许范围');
  return cents / 100;
}

/** 将来源与规则合并为后台报价，确保金额不发生浮点累加。 @param {Object[]} items 来源 @param {Object[]} adjustments 规则 @returns {Object[]} 后台商品 */
function mergeDuoItems(items, adjustments = [], options = {}) {
  const byKey = new Map(adjustments.map(row => [row.productKey, row]));
  return items.map(item => {
    const markup = validateMarkup(byKey.get(item.productKey)?.markup ?? DEFAULT_MARKUP);
    let retailPrice;
    let pricingError;
    try {
      retailPrice = calculateRetailPrice(item.wholesalePrice, markup);
    } catch (error) {
      if (!options.allowInvalid) throw error;
      retailPrice = null;
      pricingError = 'DUO_RETAIL_PRICE_INVALID';
    }
    const premiumAmount =
      retailPrice === null || item.officialPrice === null
        ? null
        : Math.floor(
          (moneyToCents(retailPrice) - moneyToCents(item.officialPrice)) / PREMIUM_UNIT_CENTS
        ) * 10;
    return {
      ...item,
      markup,
      retailPrice,
      premiumAmount,
      ...(pricingError ? { pricingError } : {}),
    };
  });
}

/** 只返回公开字段，不能通过对象展开泄露后台数据。 @param {Object} item 后台商品 @returns {Object} 公开商品 */
function publicDuoItem(item) {
  return {
    productKey: item.productKey,
    productName: item.productName,
    productModel: item.productModel,
    storageGb: item.storageGb,
    color: item.color,
    retailPrice: item.retailPrice,
    officialPrice: item.officialPrice,
    premiumAmount: item.premiumAmount,
  };
}

/** 来源新鲜度仅基于采集有效检查，人工编辑不参与。 @param {Object} batch 来源 @returns {Object} 元数据 */
function sourceFreshness(batch) {
  const checkedTime = batch.lastCheckedAt ? new Date(batch.lastCheckedAt).getTime() : NaN;
  const staleMinutes = Math.max(
    1,
    Number.parseInt(process.env.QUOTE_SOURCE_STALE_MINUTES || '5', 10) || 5
  );
  return {
    lastCheckedAt: Number.isFinite(checkedTime) ? batch.lastCheckedAt : null,
    stale:
      !Number.isFinite(checkedTime) ||
      checkedTime > Date.now() + 60000 ||
      Date.now() - checkedTime > staleMinutes * 60000,
  };
}

module.exports = {
  DEFAULT_MARKUP,
  MAX_PRICE_CENTS,
  moneyToCents,
  normalizeDuoSource,
  createSourceVersion,
  validateMarkup,
  calculateRetailPrice,
  mergeDuoItems,
  publicDuoItem,
  sourceFreshness,
  sourceUnavailable,
};
