const cheerio = require('cheerio');

/** 只接受官方购买页 metrics 内明确分类为 iPhone 的精确国行 SKU。 */
function parseProductCatalog(html, allowNewFamilies = false) {
  const $ = cheerio.load(html);
  const data = JSON.parse($('#metrics').text()).data;
  if (
    !(allowNewFamilies ? /^iphone_[a-z0-9_]+$/ : /^iphone_(?:18_pro|air|17|17e|16)$/).test(
      data?.category || ''
    )
  )
    throw new Error('UNVERIFIED_PRODUCT_FAMILY');
  const products = new Map();
  for (const item of data.products || []) {
    if (item.category !== 'iphone') continue;
    if (!/^[A-Z0-9]{5,12}CH\/A$/.test(item.partNumber) || !/^iPhone\b/.test(item.name || ''))
      throw new Error('INVALID_PRODUCT_IDENTITY');
    const row = {
      sku: item.partNumber,
      title: item.name.replace(/\s+/g, ' ').trim(),
      family: data.category,
    };
    if (products.has(row.sku) && JSON.stringify(products.get(row.sku)) !== JSON.stringify(row))
      throw new Error('CONFLICTING_PRODUCT');
    products.set(row.sku, row);
  }
  if (!products.size) throw new Error('EMPTY_PRODUCT_CATALOG');
  return [...products.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

/** 门店全集取自大陆页可见列表，地址字段仅由同页结构化数据按门店代码匹配。 */
function parseStoreCatalog(html) {
  const $ = cheerio.load(html);
  const visible = new Map();
  $('[data-store-number]').each((_index, element) => {
    const code = $(element).attr('data-store-number');
    const name = $(element).text().trim();
    if (!/^R\d{3,5}$/.test(code || '') || !name) throw new Error('INVALID_STORE_IDENTITY');
    visible.set(code, name);
  });
  if (!visible.size) throw new Error('EMPTY_STORE_CATALOG');
  const data = JSON.parse($('#__NEXT_DATA__').text());
  const stores = new Map();
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (visible.has(value.id) && value.address) {
      const address = value.address;
      if (
        visible.get(value.id) !== value.name?.trim() ||
        !/^\d{6}$/.test(address.postalCode) ||
        !address.city
      )
        throw new Error('CONFLICTING_STORE_IDENTITY');
      const row = {
        storeCode: value.id,
        storeName: value.name.trim(),
        city: address.city,
        location: address.postalCode,
      };
      if (
        stores.has(row.storeCode) &&
        JSON.stringify(stores.get(row.storeCode)) !== JSON.stringify(row)
      )
        throw new Error('CONFLICTING_STORE_ADDRESS');
      stores.set(row.storeCode, row);
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(data);
  if (stores.size !== visible.size) throw new Error('INCOMPLETE_STORE_CATALOG');
  return [...stores.values()].sort((a, b) => a.storeCode.localeCompare(b.storeCode));
}

module.exports = { parseProductCatalog, parseStoreCatalog };

/** 安全读取内联属性后的 JSON 对象，不执行页面脚本。 @param {string} html 页面 @returns {Object} 商品选择数据 */
function selectionData(html) {
  const marker = html.indexOf('productSelectionData:');
  if (marker < 0) throw new Error('PRODUCT_SELECTION_MISSING');
  const start = html.indexOf('{', marker);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('INVALID_PRODUCT_SELECTION');
}
/** 正式目录用选择器按精确 SKU 核对 Pro/Max、容量和本地化颜色。 @param {string} html 页面 @returns {Array} 已核对配置 */
function parseDetailedProductCatalog(html) {
  const catalog = parseProductCatalog(html, true);
  const selection = selectionData(html);
  const selected = new Map((selection.products || []).map(p => [p.partNumber, p]));
  const clean = value => {
    const $ = cheerio.load(value || '');
    $('.form-label-small, as-footnote').remove();
    return $.root().text().replace(/\s+/g, ' ').trim();
  };
  return catalog
    .filter(product => {
      const variant = selected.get(product.sku);
      if (!variant) throw new Error('PRODUCT_SELECTION_SKU_MISSING');
      return !variant.comingSoon && !variant.getReady;
    })
    .map(product => {
      const variant = selected.get(product.sku);
      if (!variant || variant.comingSoon || variant.getReady)
        throw new Error('PRODUCT_NOT_ON_SALE');
      const capacity = variant.dimensionCapacity?.toUpperCase();
      const color = clean(selection.displayValues?.dimensionColor?.[variant.dimensionColor]?.value);
      const model =
        clean(selection.displayValues?.dimensionScreensize?.[variant.dimensionScreensize]?.value) ||
        product.title.match(/^(iPhone .+?)\s+\d+\s*(?:GB|TB)\b/)?.[1];
      if (!/^(?:\d+)(?:GB|TB)$/.test(capacity || '') || !color || !/^iPhone\b/.test(model || ''))
        throw new Error('INCOMPLETE_PRODUCT_SPEC');
      return { ...product, title: `${model} ${capacity} ${color}`, model, capacity, color };
    });
}
module.exports.parseDetailedProductCatalog = parseDetailedProductCatalog;

/** 从官方 iPhone 购买总页发现系列购买页，限制同源和固定路径。 @param {string} html 页面 @returns {Array} 路径 */
function discoverProductPaths(html) {
  const $ = cheerio.load(html);
  const paths = new Set();
  $('a[href]').each((_index, element) => {
    try {
      const url = new URL($(element).attr('href'), 'https://www.apple.com.cn');
      if (
        url.origin === 'https://www.apple.com.cn' &&
        /^\/shop\/buy-iphone\/[a-z0-9-]+$/.test(url.pathname)
      )
        paths.add(url.pathname);
    } catch (_error) {
      /* 忽略非链接文本。 */
    }
  });
  if (!paths.size) throw new Error('EMPTY_PRODUCT_FAMILIES');
  return [...paths].sort();
}
module.exports.discoverProductPaths = discoverProductPaths;
