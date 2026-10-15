const logger = require('../src/utils/logger');
// 冻结数据；不依赖现行业务服务，后续变更必须新增版本。
const catalog = require('../src/data/stockCatalogV20261015.json');

module.exports = {
  /** 增量初始化 Duo；拒绝身份/价格冲突，保留原启停、成本及监控历史。 */
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          const query = (sql, replacements = {}) =>
            queryInterface.sequelize.query(sql, { transaction, replacements });
          await query(
            'LOCK TABLE stock_products, stock_official_prices, inventory_products IN SHARE ROW EXCLUSIVE MODE'
          );
          for (const item of catalog) {
            const values = {
              ...item,
              storageGb: item.capacity.includes('TB')
                ? parseInt(item.capacity, 10) * 1024
                : parseInt(item.capacity, 10),
            };
            const [rows] = await query(
              `SELECT * FROM stock_products WHERE upper(sku_code)=:sku OR
              (lower(regexp_replace(model_name,'\\s','','g'))='iphoneduo' AND storage_gb=:storageGb AND
              lower(regexp_replace(color_name,'\\s','','g')) IN (:color,:colorKey))`,
              values
            );
            if (
              rows.length > 1 ||
              rows.some(
                row =>
                  row.model_name !== item.model ||
                  row.storage_gb !== values.storageGb ||
                  row.color_name !== item.color ||
                  (row.sku_code && row.sku_code !== item.sku)
              )
            )
              throw new Error(`Duo 库存规格冲突，请人工核对：${item.sku}`);
            let product = rows[0];
            if (!product) {
              const [created] = await query(
                `INSERT INTO stock_products(model_key,model_name,storage_gb,color_key,color_name,sku_code)
                VALUES ('iphoneduo',:model,:storageGb,:colorKey,:color,:sku) RETURNING *`,
                values
              );
              product = created[0];
            } else if (!product.sku_code)
              await query('UPDATE stock_products SET sku_code=:sku WHERE id=:id', {
                ...values,
                id: product.id,
              });
            const [prices] = await query(
              "SELECT * FROM stock_official_prices WHERE product_id=:id AND (source_version=:priceVersion OR valid_from='2026-10-15')",
              { ...values, id: product.id }
            );
            if (
              prices.length > 1 ||
              prices.some(
                price => price.source_version !== item.priceVersion || price.amount !== item.amount
              )
            )
              throw new Error(`Duo 固定价格冲突，保留原价：${item.sku}`);
            if (!prices.length)
              await query(
                `INSERT INTO stock_official_prices(product_id,valid_from,amount,source_label,source_version)
              VALUES (:id,'2026-10-15',:amount,'已确认大陆 Duo 裸机固定目录',:priceVersion)`,
                { ...values, id: product.id }
              );
            const [existing] = await query(
              'SELECT body FROM inventory_products WHERE id=:sku',
              values
            );
            if (
              existing.some(
                row =>
                  row.body.sku !== item.sku ||
                  row.body.model !== item.model ||
                  row.body.capacity !== item.capacity ||
                  row.body.color !== item.color
              )
            )
              throw new Error(`Duo 监控目录冲突：${item.sku}`);
            const body = {
              sku: item.sku,
              title: item.title,
              family: item.family,
              model: item.model,
              capacity: item.capacity,
              color: item.color,
              enabled: false,
              supported: true,
              discoveredAt: Date.parse('2026-10-15T12:14:07Z'),
              lastSeenAt: Date.parse('2026-10-15T12:14:07Z'),
              sourceUrl: 'https://www.apple.com.cn/shop/buy-iphone/iphone-duo',
            };
            await query(
              'INSERT INTO inventory_products(id,body,created_at,updated_at) VALUES (:sku,CAST(:body AS jsonb),NOW(),NOW()) ON CONFLICT (id) DO NOTHING',
              { ...values, body: JSON.stringify(body) }
            );
          }
        } catch (error) {
          logger.debug('Duo 目录迁移未完成', { code: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.debug('Duo 目录迁移未完成', { code: error.code || error.name });
      throw error;
    }
  },
  /** 目录属可追溯资料，回退保留；已有 Duo 业务事实时拒绝回退代码契约。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          const query = sql => queryInterface.sequelize.query(sql, { transaction });
          await query(
            'LOCK TABLE stock_products, stock_units, stock_sale_lines, orders IN SHARE ROW EXCLUSIVE MODE'
          );
          const [facts] =
            await query(`SELECT 1 FROM stock_units u JOIN stock_products p ON p.id=u.product_id WHERE p.model_name='iPhone Duo'
            UNION ALL SELECT 1 FROM stock_sale_lines l JOIN stock_products p ON p.id=l.product_id WHERE p.model_name='iPhone Duo'
            UNION ALL SELECT 1 FROM orders WHERE order_amount_price_version='cn-iphone-duo-20261015' LIMIT 1`);
          if (facts.length) throw new Error('已有 Duo 业务事实，拒绝回退；目录与历史保留');
        } catch (error) {
          logger.debug('Duo 目录回退未完成', { code: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.debug('Duo 目录回退未完成', { code: error.code || error.name });
      throw error;
    }
  },
};
