const { createHash } = require('crypto');
const ApiError = require('../utils/ApiError');

const PRODUCT_MODELS = Object.freeze(['18 Pro', '18 Pro Max']);
const COLOR_ORDER = Object.freeze(['黑色', '银色', '冰川蓝色', '勃艮第酒红色']);
const MIN_PERCENTAGE = -100;
const MAX_PERCENTAGE = 1000;
const MIN_FIXED_AMOUNT = -100000;
const MAX_FIXED_AMOUNT = 100000;

/**
 * 按业务指定顺序比较颜色，未知颜色稳定排在末尾。
 * @param {string} left 左值
 * @param {string} right 右值
 * @returns {number} 排序值
 */
function compareQuoteColors(left, right) {
  const leftIndex = COLOR_ORDER.indexOf(left);
  const rightIndex = COLOR_ORDER.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  return left.localeCompare(right, 'zh-CN');
}

/**
 * 按型号、容量和业务颜色顺序排列报价商品。
 * @param {Object} left 左商品
 * @param {Object} right 右商品
 * @returns {number} 排序值
 */
function compareQuoteItems(left, right) {
  const modelDifference =
    PRODUCT_MODELS.indexOf(left.productModel) - PRODUCT_MODELS.indexOf(right.productModel);
  if (modelDifference !== 0) return modelDifference;
  if (left.storageGb !== right.storageGb) return left.storageGb - right.storageGb;
  return compareQuoteColors(left.color, right.color);
}

/**
 * 按后台保存的商品键顺序排列，未配置或新出现的商品稳定追加到末尾。
 * @param {Object[]} items 默认顺序商品
 * @param {unknown} displayOrder 已保存的商品键数组
 * @returns {Object[]} 展示顺序商品
 */
function applyDisplayOrder(items, displayOrder) {
  if (!Array.isArray(displayOrder) || displayOrder.length === 0) return [...items];
  const positions = new Map();
  displayOrder.forEach((productKey, index) => {
    if (typeof productKey === 'string' && !positions.has(productKey)) {
      positions.set(productKey, index);
    }
  });
  const fallbackPosition = displayOrder.length;
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftPosition = positions.get(left.item.productKey) ?? fallbackPosition;
      const rightPosition = positions.get(right.item.productKey) ?? fallbackPosition;
      return leftPosition - rightPosition || left.index - right.index;
    })
    .map(entry => entry.item);
}

/** 生成不包含来源价格的稳定商品键。 @param {Object} item 商品 @returns {string} 商品键 */
function createProductKey(item) {
  const identity = `${item.productModel}\u0000${item.storageGb}\u0000${item.color}`;
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 40);
}

/** 格式化容量。 @param {number} storageGb GB容量 @returns {string} 展示容量 */
function formatStorage(storageGb) {
  return storageGb >= 1024 && storageGb % 1024 === 0 ? `${storageGb / 1024}TB` : `${storageGb}GB`;
}

/** 生成完整商品名。 @param {Object} item 商品 @returns {string} 商品名 */
function productName(item) {
  return `iPhone ${item.productModel} ${formatStorage(item.storageGb)} ${item.color}`;
}

/**
 * 按确认规则计算公开报价：先百分比、后固定金额、最后四舍五入到整数元。
 * @param {number|string} basePrice 明威原价
 * @param {number|string} percentage 百分比
 * @param {number|string} fixedAmount 固定金额
 * @returns {number} 最终报价
 */
function calculateQuotePrice(basePrice, percentage = 0, fixedAmount = 0) {
  const base = Number(basePrice);
  const percent = Number(percentage);
  const fixed = Number(fixedAmount);
  if (![base, percent, fixed].every(Number.isFinite) || base < 0) {
    throw ApiError.badRequest('报价计算参数无效');
  }
  const result = Math.round(base * (1 + percent / 100) + fixed);
  if (result < 0) throw ApiError.badRequest('调整后的报价不能为负数');
  return result;
}

/** 校验并规范化来源行。 @param {Object[]} rows 来源数据 @returns {Object[]} 商品 */
function normalizeSourceItems(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ApiError(503, 'QUOTE_SOURCE_UNAVAILABLE', '报价数据暂不可用');
  }
  const seen = new Set();
  const models = new Set();
  const items = rows.map(row => {
    const item = {
      productModel: String(row.productModel || '').trim(),
      storageGb: Number(row.storageGb),
      color: String(row.color || '').trim(),
      specCode: row.specCode ? String(row.specCode) : null,
      basePrice: Number(row.basePrice),
      officialPrice: row.officialPrice === null ? null : Number(row.officialPrice),
      sourceUpdatedAt: row.sourceUpdatedAt,
      crawledAt: row.crawledAt,
    };
    if (
      !PRODUCT_MODELS.includes(item.productModel) ||
      !Number.isSafeInteger(item.storageGb) ||
      item.storageGb <= 0 ||
      !item.color ||
      row.basePrice === null ||
      row.basePrice === undefined ||
      !Number.isFinite(item.basePrice) ||
      item.basePrice < 0 ||
      row.officialPrice === null ||
      row.officialPrice === undefined ||
      !Number.isFinite(item.officialPrice) ||
      item.officialPrice < 0
    ) {
      throw new ApiError(503, 'QUOTE_SOURCE_UNAVAILABLE', '报价数据暂不可用');
    }
    item.productKey = createProductKey(item);
    item.productName = productName(item);
    if (seen.has(item.productKey)) {
      throw new ApiError(503, 'QUOTE_SOURCE_UNAVAILABLE', '报价数据暂不可用');
    }
    seen.add(item.productKey);
    models.add(item.productModel);
    return item;
  });
  if (models.size !== PRODUCT_MODELS.length) {
    throw new ApiError(503, 'QUOTE_SOURCE_UNAVAILABLE', '报价数据暂不可用');
  }
  const colorsByModelAndStorage = new Map();
  items.forEach(item => {
    const modelGroups = colorsByModelAndStorage.get(item.productModel) || new Map();
    const colors = modelGroups.get(item.storageGb) || new Set();
    colors.add(item.color);
    modelGroups.set(item.storageGb, colors);
    colorsByModelAndStorage.set(item.productModel, modelGroups);
  });
  colorsByModelAndStorage.forEach(modelGroups => {
    const expectedColors = new Set();
    modelGroups.forEach(colors => colors.forEach(color => expectedColors.add(color)));
    modelGroups.forEach(colors => {
      if (
        colors.size !== expectedColors.size ||
        [...expectedColors].some(color => !colors.has(color))
      ) {
        throw new ApiError(503, 'QUOTE_SOURCE_UNAVAILABLE', '报价数据暂不可用');
      }
    });
  });
  return items.sort(compareQuoteItems);
}

/** 校验调价值。 @param {unknown} percentage 百分比 @param {unknown} fixedAmount 固定金额 */
function validateAdjustment(percentage, fixedAmount) {
  const percent = Number(percentage);
  const fixed = Number(fixedAmount);
  if (
    !Number.isFinite(percent) ||
    percent < MIN_PERCENTAGE ||
    percent > MAX_PERCENTAGE ||
    !Number.isFinite(fixed) ||
    fixed < MIN_FIXED_AMOUNT ||
    fixed > MAX_FIXED_AMOUNT
  ) {
    throw ApiError.badRequest('百分比或固定调整金额超出允许范围');
  }
  return { percentage: percent, fixedAmount: fixed };
}

module.exports = {
  PRODUCT_MODELS,
  COLOR_ORDER,
  compareQuoteColors,
  compareQuoteItems,
  applyDisplayOrder,
  createProductKey,
  formatStorage,
  productName,
  calculateQuotePrice,
  normalizeSourceItems,
  validateAdjustment,
};
