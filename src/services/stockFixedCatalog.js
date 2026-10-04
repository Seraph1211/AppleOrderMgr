const logger = require('../utils/logger');
// 冻结的 16 种规格；历史迁移依赖此版本，新增规格须新增版本。
const products = require('../data/stockCatalogV20260921.json');
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
  }));
/** 查找严格一致的固定规格，未知或冲突料号不模糊匹配。 */
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
/** 新录入固定目录成本；只读取受信价格版本，不覆盖已确认事实。 */
async function fixedCost(db, product, transaction) {
  try {
    const spec = specification(product);
    if (!spec) return {};
    const price = await db.StockOfficialPrice.findOne({
      where: { productId: product.id, sourceVersion: PRICE_VERSION, isActive: true },
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
