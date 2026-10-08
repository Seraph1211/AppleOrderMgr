const logger = require('../src/utils/logger');
// 历史迁移只依赖冻结数据与价格模块，不依赖现行业务服务。
const products = require('../src/data/stockCatalogV20260921.json');
const { PRICE_VERSION, getCatalogUnitPrice } = require('../src/utils/orderCatalogPricingV1');
const CATALOG = products.map(item => ({
  skuCode: item.sku,
  modelName: item.model,
  colorName: item.color,
  storageGb: item.capacity.includes('TB')
    ? Number(item.capacity.replace('TB', '')) * 1024
    : Number(item.capacity.replace('GB', '')),
  amount: getCatalogUnitPrice({ name: item.title }).toFixed(2),
}));

module.exports = {
  /** 初始化固定目录；任何身份歧义均回滚，不改写历史成本或停用状态。 */
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          const query = (sql, replacements = {}) =>
            queryInterface.sequelize.query(sql, { transaction, replacements });
          await query(
            'LOCK TABLE stock_products, stock_official_prices IN SHARE ROW EXCLUSIVE MODE'
          );
          for (const item of CATALOG) {
            const [matches] = await query(
              `SELECT * FROM stock_products WHERE upper(sku_code)=:skuCode OR
              (lower(regexp_replace(model_name,'\\s','','g'))='iphone18promax' AND storage_gb=:storageGb AND
              lower(regexp_replace(color_name,'\\s','','g')) IN (:aliases))`,
              {
                ...item,
                aliases: {
                  黑色: ['黑色', 'black'],
                  银色: ['银色', 'silver'],
                  冰川蓝色: ['冰川蓝色', '冰川蓝', 'glacier', 'glacierblue'],
                  勃艮第酒红色: ['勃艮第酒红色', '勃艮第酒红', 'burgundy'],
                }[item.colorName],
              }
            );
            if (
              matches.length > 1 ||
              matches.some(
                row =>
                  row.model_name !== item.modelName ||
                  row.storage_gb !== item.storageGb ||
                  row.color_name !== item.colorName ||
                  (row.sku_code && row.sku_code !== item.skuCode)
              )
            )
              throw new Error(`库存规格冲突，人工核对后再迁移：${item.skuCode}`);
            let product = matches[0];
            if (!product) {
              const [created] = await query(
                `INSERT INTO stock_products(model_key,model_name,storage_gb,color_key,color_name,sku_code)
                VALUES ('iphone18promax',:modelName,:storageGb,:colorName,:colorName,:skuCode) RETURNING *`,
                item
              );
              product = created[0];
            } else if (!product.sku_code)
              await query('UPDATE stock_products SET sku_code=:skuCode WHERE id=:id', {
                ...item,
                id: product.id,
              });
            const [prices] = await query(
              "SELECT * FROM stock_official_prices WHERE product_id=:id AND (source_version=:version OR valid_from='2026-09-21')",
              { id: product.id, version: PRICE_VERSION }
            );
            if (
              prices.length > 1 ||
              prices.some(
                price => price.source_version !== PRICE_VERSION || price.amount !== item.amount
              )
            )
              throw new Error(`固定价格版本冲突，保留原价：${item.skuCode}`);
            if (!prices.length)
              await query(
                `INSERT INTO stock_official_prices(product_id,valid_from,amount,source_label,source_version)
              VALUES (:id,'2026-09-21',:amount,'已确认大陆裸机固定目录',:version)`,
                { id: product.id, amount: item.amount, version: PRICE_VERSION }
              );
          }
          await query(`ALTER TABLE stock_units DROP CONSTRAINT IF EXISTS stock_units_cost_snapshot_v2_check;
            ALTER TABLE stock_units DROP CONSTRAINT IF EXISTS stock_units_cost_snapshot_v3_check;
            ALTER TABLE stock_units ADD CONSTRAINT stock_units_cost_snapshot_v3_check CHECK (
              (cost_status='pending' AND official_cost_amount IS NULL) OR
              (cost_status='confirmed' AND official_cost_amount>0 AND official_cost_amount IS NOT NULL AND cost_source IS NOT NULL AND
                ((cost_source='catalog' AND acquired_on IS NOT NULL) OR cost_source='manual' OR (cost_source='fixed_catalog' AND price_id IS NOT NULL))));`);
        } catch (error) {
          logger.debug('库存盒标处理未完成', { code: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.debug('库存盒标处理未完成', { code: error.code || error.name });
      throw error;
    }
  },
  /** 回退仅恢复约束；预置资料保留，已使用新成本来源则拒绝回退。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          const query = sql => queryInterface.sequelize.query(sql, { transaction });
          await query('LOCK TABLE stock_units IN ACCESS EXCLUSIVE MODE');
          const [rows] = await query(
            "SELECT 1 FROM stock_units WHERE cost_source='fixed_catalog' LIMIT 1"
          );
          if (rows.length) throw new Error('已有 fixed_catalog 成本事实，拒绝破坏性回退');
          await query(`ALTER TABLE stock_units DROP CONSTRAINT IF EXISTS stock_units_cost_snapshot_v3_check;
            ALTER TABLE stock_units ADD CONSTRAINT stock_units_cost_snapshot_v2_check CHECK (
              (cost_status='pending' AND official_cost_amount IS NULL) OR
              (cost_status='confirmed' AND official_cost_amount>0 AND official_cost_amount IS NOT NULL AND cost_source IS NOT NULL AND cost_source IN ('catalog','manual') AND (cost_source='manual' OR acquired_on IS NOT NULL)));`);
        } catch (error) {
          logger.debug('库存盒标处理未完成', { code: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.debug('库存盒标处理未完成', { code: error.code || error.name });
      throw error;
    }
  },
};
