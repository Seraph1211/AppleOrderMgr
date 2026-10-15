/** 商品名称规范的单一来源；浏览器版本由 scripts/generateProductNaming.js 生成。 */
const PRODUCT_NAME_RULE_VERSION = '20261015-v1';
const PRODUCT_CATALOG = require('../data/productNamingV20261015.json');
const SKU_CATALOG = Object.fromEntries(PRODUCT_CATALOG.map(item => [item.sku, item]));
const MODEL_NAMES = [...new Set(PRODUCT_CATALOG.map(item => item.modelName))].sort(
  (a, b) => b.length - a.length
);
const clean = value =>
  typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
const normalizeModel = value => {
  const text = clean(value)
    .replace(/^iPhone\s*/i, '')
    .replace(/\s/g, '')
    .toLowerCase();
  return (
    MODEL_NAMES.find(
      model =>
        model
          .replace(/^iPhone\s*/i, '')
          .replace(/\s/g, '')
          .toLowerCase() === text
    ) || clean(value)
  );
};
const normalizeColor = (value, modelName) =>
  modelName === 'iPhone 18 Pro Max' && clean(value) === '酒红色' ? '勃艮第酒红色' : clean(value);

/** 将明确容量换算为展示单位；未知输入保留原文。 @param {number|string} value 容量 @returns {string} 展示文字 */
function formatProductCapacity(value) {
  const raw = typeof value === 'number' ? String(value) : clean(value);
  const match = raw.match(/^(128|256|512|1024|2048|1|2)\s*(G|GB|T|TB)?$/i);
  if (!match) return raw;
  const number = Number(match[1]);
  const unit = (match[2] || 'G').toUpperCase();
  const gb = number * (unit.startsWith('T') ? 1024 : 1);
  return { 128: '128G', 256: '256G', 512: '512G', 1024: '1T', 2048: '2T' }[gb] || raw;
}

/** 只映射可唯一确认的商品，不补写 SKU 或关联。 @param {Object|string} input 商品 @returns {Object} 名称、身份及核对状态 */
function resolveProductName(input) {
  const product = typeof input === 'string' ? { name: input } : input || {};
  const original =
    product.name || product.title || product.productName || product.product_name || '';
  let rawName = clean(original);
  const modelValue = clean(product.model || product.productModel);
  if (!rawName && /\s(?:256|512|1024|2048|1|2)\s*(?:G|GB|T|TB)\b/i.test(modelValue))
    rawName = modelValue;
  const skuValues = [
    product.sku,
    product.skuCode,
    product.partNumber,
    product.product_sku,
    /^[A-Z0-9]{5,12}\/[A-Z0-9]{1,3}$/i.test(modelValue) ? modelValue : '',
  ]
    .map(clean)
    .filter(Boolean)
    .map(value => value.toUpperCase());
  const sku = skuValues[0] || '';
  const catalog = SKU_CATALOG[sku];
  const fail = reason => ({
    name: typeof original === 'string' && original ? original : clean(product.displayName) || modelValue || sku,
    matched: false,
    needsReview: true,
    reason,
    identity: null,
    ruleVersion: PRODUCT_NAME_RULE_VERSION,
  });
  if (product.nameNeedsReview === true)
    return fail(typeof product.nameReviewReason === 'string' && product.nameReviewReason ? product.nameReviewReason : 'source_needs_review');
  if (sku && !catalog) return fail('unknown_sku');
  if (new Set(skuValues).size > 1) return fail('sku_conflict');
  const modelFields = [
    product.modelName,
    product.model_name,
    clean(product.productModel) === rawName ? '' : product.productModel,
    sku === modelValue.toUpperCase() || rawName === modelValue ? '' : modelValue,
  ]
    .map(normalizeModel)
    .filter(Boolean);
  const nameModel = MODEL_NAMES.map(model => {
    const pattern = model.split(/\s+/).join('\\s*');
    return rawName.match(new RegExp(`^(${pattern})(?=\\s|$)`, 'i'));
  }).find(Boolean);
  if (nameModel) modelFields.push(normalizeModel(nameModel[1]));
  const modelName = catalog?.modelName || modelFields[0] || '';
  if (modelFields.some(value => value !== modelName)) return fail('model_conflict');
  if (!modelName) return fail('unknown_model');
  let remaining = nameModel ? rawName.slice(nameModel[0].length).trim() : rawName;
  const capacities = [product.storageGb, product.storage_gb, product.capacity, product.storage]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(formatProductCapacity);
  remaining = remaining
    .replace(/\b(\d+(?:\.\d+)?)\s*(GB|TB|G|T)\b/gi, match => {
      capacities.push(formatProductCapacity(match));
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  const colors = [product.colorName, product.color_name, product.color]
    .map(value => normalizeColor(value, modelName))
    .filter(Boolean);
  if (remaining) colors.push(normalizeColor(remaining, modelName));
  const capacity = catalog?.capacity || capacities[0] || '';
  const color = catalog?.color || colors[0] || '';
  if (capacities.some(value => value !== capacity)) return fail('capacity_conflict');
  if (colors.some(value => value !== color)) return fail('color_conflict');
  if (!['128G', '256G', '512G', '1T', '2T'].includes(capacity) || !color)
    return fail('incomplete_specification');
  const knownColors = PRODUCT_CATALOG.filter(item => item.modelName === modelName).map(
    item => item.color
  );
  if (knownColors.length && !knownColors.includes(color)) return fail('unknown_color');
  if (
    !knownColors.length &&
    (rawName || !modelFields.length || !colors.length || !capacities.length)
  )
    return fail('unknown_name');
  if (rawName && !nameModel) return fail('unrecognized_name');
  const name = `${modelName} ${color} ${capacity}`;
  const confirmed = PRODUCT_CATALOG.filter(item => item.name === name);
  if (knownColors.length && confirmed.length !== 1) return fail('unknown_specification');
  const names = [product.name, product.title, product.productName, product.product_name].filter(
    value => typeof value === 'string' && value.trim()
  );
  if (names.length > 1) {
    for (const value of names) {
      const check = { ...product, name: value };
      delete check.title;
      delete check.productName;
      delete check.product_name;
      const resolution = resolveProductName(check);
      if (!resolution.matched || resolution.name !== name) return fail('name_conflict');
    }
  }
  return {
    name,
    modelName,
    color,
    capacity,
    matched: true,
    needsReview: false,
    reason: null,
    identity: JSON.stringify([
      sku || PRODUCT_CATALOG.find(item => item.name === name)?.sku || null,
      modelName,
      color,
      capacity,
    ]),
    ruleVersion: PRODUCT_NAME_RULE_VERSION,
  };
}

/** 返回业务展示名称，原始证据调用方仍保留原字段。 @param {Object|string} product 商品 @returns {string} 名称 */
function getProductDisplayName(product) {
  return resolveProductName(product).name;
}

/** 将旧名称查询扩展为可确认的现行名称，保留未知原值。 @param {Array<string>} names 查询值 @returns {Array<string>} 别名集合 */
function expandProductNameAliases(names) {
  return [
    ...new Set(
      names.flatMap(value => {
        const resolved = resolveProductName(value);
        if (!resolved.matched) {
          const capacity = clean(value).match(/^(128|256|512|1024|2048|1|2)\s*(GB|TB|G|T)$/i);
          if (capacity) {
            const canonical = formatProductCapacity(value);
            const catalogItem = PRODUCT_CATALOG.find(item => item.capacity === canonical);
            return catalogItem ? [value, ...catalogItem.capacityAliases] : [value];
          }
          return [value];
        }
        const catalog = PRODUCT_CATALOG.find(item => item.name === resolved.name);
        return [
          value,
          resolved.name,
          ...(catalog
            ? catalog.capacityAliases.flatMap(capacity =>
              catalog.colorAliases.flatMap(color => [
                `${catalog.modelName} ${color} ${capacity}`,
                `${catalog.modelName} ${capacity} ${color}`,
              ])
            )
            : []),
        ];
      })
    ),
  ];
}

module.exports = {
  PRODUCT_NAME_RULE_VERSION,
  SKU_CATALOG,
  expandProductNameAliases,
  formatProductCapacity,
  resolveProductName,
  getProductDisplayName,
};
