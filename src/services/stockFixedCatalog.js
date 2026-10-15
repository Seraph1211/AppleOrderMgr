const logger = require('../utils/logger');
// 现行目录组合冻结版本；历史迁移仍直接引用各自冻结数据。
const products = require('../data/stockCatalogV20260921.json');
const duo = require('../data/stockCatalogV20261015.json');
const { PRICE_VERSION, getCatalogUnitPrice } = require('../utils/orderCatalogPricingV1');
const ApiError = require('../utils/ApiError');
const CATALOG = products
  .filter(item => item.model === 'iPhone 18 Pro Max')
  .map(item => ({
    skuCode: item.sku,
    modelName: item.model,
    storageGb: item.capacity.includes('TB')
      ? Number(item.capacity.replace('TB', '')) * 1024
      : Number(item.capacity.replace('GB', '')),
    colorName: item.color,
    amount: getCatalogUnitPrice({ name: item.title }).toFixed(2),
    priceVersion: PRICE_VERSION,
  }))
  .concat(
    duo.map(item => ({
      skuCode: item.sku,
      modelName: item.model,
      colorName: item.color,
      storageGb: item.capacity.includes('TB')
        ? Number(item.capacity.replace('TB', '')) * 1024
        : Number(item.capacity.replace('GB', '')),
      amount: item.amount,
      priceVersion: item.priceVersion,
    }))
  );
/**
 * 按完整型号、容量、颜色及可选 SKU 精确匹配现行固定目录。
 * @param {Object} product 库存商品 modelName/storageGb/colorName/skuCode
 * @returns {Object|null} 冻结规格、金额及其自身 priceVersion；未知或冲突返回 null
 */
function specification(product) {
  return (
    CATALOG.find(
      item =>
        item.modelName === product.modelName &&
        item.storageGb === product.storageGb &&
        item.colorName === product.colorName &&
        (!product.skuCode || item.skuCode === product.skuCode)
    ) || null
  );
}
/**
 * 为新业务读取规格自身的启用固定价格；调用方负责保留已有确认成本。
 * @param {Object} db Sequelize 模型集合
 * @param {Object} product 带 id 的完整库存商品
 * @param {Object} transaction 当前业务事务
 * @returns {Promise<Object>} 固定成本快照；未知规格返回空对象，版本缺失或改价抛冲突
 */
async function fixedCost(db, product, transaction) {
  try {
    const spec = specification(product);
    if (!spec) return {};
    const price = await db.StockOfficialPrice.findOne({
      where: { productId: product.id, sourceVersion: spec.priceVersion, isActive: true },
      transaction,
    });
    if (!price || price.amount !== spec.amount)
      throw ApiError.conflict(
        '预置价格不可用，请由管理员核对',
        undefined,
        'FIXED_PRICE_UNAVAILABLE'
      );
    return {
      officialCostAmount: price.amount,
      priceId: price.id,
      costSource: 'fixed_catalog',
      costStatus: 'confirmed',
    };
  } catch (error) {
    logger.debug('库存盒标处理未完成', { code: error.code || error.name });
    throw error;
  }
}
module.exports = { CATALOG, PRICE_VERSION, specification, fixedCost };
