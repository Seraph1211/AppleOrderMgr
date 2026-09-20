/** 2026-09-21 用户确认的中国大陆裸机价；历史 Migration 依赖此版本，调价须新增版本。 */
const PRICE_VERSION = 'cn-iphone18-20260921';
const PRICES = Object.freeze({
  pro: Object.freeze({ 256: 9999, 512: 11999, 1024: 15499, 2048: 20499 }),
  proMax: Object.freeze({ 256: 10999, 512: 12999, 1024: 16499, 2048: 21499 }),
});
const CAPACITIES = Object.freeze({
  '256g': 256,
  '256gb': 256,
  '512g': 512,
  '512gb': 512,
  '1t': 1024,
  '1tb': 1024,
  '1024g': 1024,
  '1024gb': 1024,
  '2t': 2048,
  '2tb': 2048,
  '2048g': 2048,
  '2048gb': 2048,
});
const COLORS = new Set([
  '',
  '黑色',
  '银色',
  '冰川蓝色',
  '勃艮第酒红色',
  'black',
  'silver',
  'glacierblue',
  'burgundy',
]);
const MAX_AMOUNT = 9999999999.99;

function identify(value) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  const series = text.match(/^iphone18pro(max)?/);
  if (!series) return null;
  const tail = text.slice(series[0].length);
  const capacities = [...tail.matchAll(/(?:256|512|1024|2048)gb?|[12]tb?/g)];
  if (capacities.length !== 1) return null;
  const capacity = capacities[0][0];
  // 只接受完整裸机名称，防止把手机壳、未知容量或套装按手机定价。
  if (!COLORS.has(tail.replace(capacity, ''))) return null;
  const model = series[1] ? 'proMax' : 'pro';
  return { model, capacity: CAPACITIES[capacity] };
}

/**
 * 识别已确认的裸机单价；不猜测 SKU 或冲突名称。
 * @param {Object} product 商品
 * @returns {number|null} 人民币单价
 */
function getCatalogUnitPrice(product) {
  if (!product || typeof product !== 'object') return null;
  const hasName = typeof product.name === 'string' && product.name.trim();
  const identity = identify(hasName ? product.name : product.model);
  if (!identity) return null;
  const modelIdentity = identify(product.model);
  if (
    modelIdentity &&
    (identity.model !== modelIdentity.model || identity.capacity !== modelIdentity.capacity)
  )
    return null;
  return PRICES[identity.model][identity.capacity] ?? null;
}

/**
 * 按全部商品计算订单金额；任何未知项均不返回部分总额。
 * @param {Array} products 当前有效商品与数量
 * @returns {Object} 金额及固定价格版本
 */
function calculateCatalogAmount(products) {
  const result = { orderAmount: null, orderAmountPriceVersion: PRICE_VERSION };
  if (!Array.isArray(products) || !products.length) return result;
  let total = 0;
  for (const product of products) {
    const price = getCatalogUnitPrice(product);
    const rawQuantity = product?.quantity;
    if (
      typeof rawQuantity !== 'number' &&
      !(typeof rawQuantity === 'string' && /^\d+$/.test(rawQuantity))
    )
      return result;
    const quantity = Number(rawQuantity);
    if (price === null || !Number.isSafeInteger(quantity) || quantity < 0) return result;
    total += price * quantity;
    if (!Number.isSafeInteger(total) || total > MAX_AMOUNT) return result;
  }
  return { ...result, orderAmount: total.toFixed(2) };
}

module.exports = { PRICE_VERSION, getCatalogUnitPrice, calculateCatalogAmount };
