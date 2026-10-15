const legacy = require('./orderCatalogPricingV1');
const duo = require('../data/stockCatalogV20261015.json');
const PRICE_VERSION = 'cn-iphone-duo-20261015';
const MAX_AMOUNT = 9999999999.99;
const normalize = value =>
  typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase() : '';

function identifyDuo(value) {
  const text = normalize(value);
  if (!text.startsWith('iphoneduo')) return null;
  const tail = text.slice('iphoneduo'.length);
  const capacities = [...tail.matchAll(/(?:256|512|1024|2048)gb?|[12]tb?/g)];
  if (capacities.length !== 1) return null;
  const raw = capacities[0][0];
  const remaining = tail.replace(raw, '');
  if (!['', '星光白色', '夜空色', 'starwhite', 'nightsky'].includes(remaining)) return null;
  const capacity = /t/.test(raw) ? parseInt(raw, 10) * 1024 : parseInt(raw, 10);
  const color = { starwhite: '星光白色', nightsky: '夜空色' }[remaining] || remaining;
  return { capacity, color };
}
const SKU_CATALOG = new Map(
  duo.map(item => [
    item.sku,
    {
      ...item,
      storageGb: item.capacity.includes('TB')
        ? parseInt(item.capacity, 10) * 1024
        : parseInt(item.capacity, 10),
    },
  ])
);
const CAPACITY_PRICES = new Map(
  [...SKU_CATALOG.values()].map(item => [item.storageGb, Number(item.amount)])
);
const normalizeSku = value => (typeof value === 'string' ? value.trim().toUpperCase() : '');
function productSkus(product) {
  return [
    product?.skuCode,
    product?.sku,
    product?.partNumber,
    /^[A-Z0-9]{5}[A-Z]{1,3}\/A$/.test(normalizeSku(product?.model)) ? product.model : null,
  ]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(value => normalizeSku(value) || 'INVALID_SKU');
}
function hasDuoEvidence(product) {
  return (
    [product?.name, product?.model].some(value => normalize(value).startsWith('iphoneduo')) ||
    productSkus(product).some(sku => SKU_CATALOG.has(sku))
  );
}
/**
 * 现行裸机价格分派；name 优先，model 中的明确规格与全部 SKU 字段须一致。
 * @param {Object} product 商品；name/model 为完整裸机规格，model 亦可为 SKU
 * @returns {number|null} 已确认人民币单价；未知或冲突返回 null，不按 SKU 猜规格
 */
function getCatalogUnitPrice(product) {
  if (!product || typeof product !== 'object') return null;
  const name =
    typeof product.name === 'string' && product.name.trim() ? product.name : product.model;
  if (!normalize(name).startsWith('iphoneduo')) {
    if (hasDuoEvidence(product)) return null;
    return legacy.getCatalogUnitPrice(product);
  }
  const identity = identifyDuo(name);
  if (!identity) return null;
  if (
    product.model &&
    !/^[A-Z0-9]{5}[A-Z]{1,3}\/A$/.test(normalizeSku(product.model)) &&
    normalize(product.model) !== 'iphoneduo' &&
    normalize(product.model) !== normalize(name)
  ) {
    const other = identifyDuo(product.model);
    if (
      !other ||
      other.capacity !== identity.capacity ||
      (other.color && identity.color && other.color !== identity.color)
    )
      return null;
    if (!identity.color && other.color) identity.color = other.color;
  }
  const skus = productSkus(product);
  if (new Set(skus).size > 1) return null;
  const sku = skus[0];
  if (sku) {
    const item = SKU_CATALOG.get(sku);
    if (
      !item ||
      item.storageGb !== identity.capacity ||
      (identity.color && item.color !== identity.color)
    )
      return null;
  }
  return CAPACITY_PRICES.get(identity.capacity) ?? null;
}
/**
 * 计算新业务整单金额；任意未知项使整单待补，旧 V1 价格与规则保持冻结。
 * @param {Array<Object>} products 商品与非负整数 quantity，允许混合已支持机型
 * @returns {{orderAmount: string|null, orderAmountPriceVersion: string}} 含 Duo 身份采用新版本，其余沿用 V1
 */
function calculateCatalogAmount(products) {
  if (!Array.isArray(products) || !products.some(hasDuoEvidence))
    return legacy.calculateCatalogAmount(products);
  const result = { orderAmount: null, orderAmountPriceVersion: PRICE_VERSION };
  let total = 0;
  for (const product of products) {
    const price = getCatalogUnitPrice(product);
    const raw = product?.quantity;
    if (typeof raw !== 'number' && !(typeof raw === 'string' && /^\d+$/.test(raw))) return result;
    const quantity = Number(raw);
    if (price === null || !Number.isSafeInteger(quantity) || quantity < 0) return result;
    total += price * quantity;
    if (!Number.isSafeInteger(total) || total > MAX_AMOUNT) return result;
  }
  return { ...result, orderAmount: total.toFixed(2) };
}
module.exports = { PRICE_VERSION, getCatalogUnitPrice, calculateCatalogAmount };
