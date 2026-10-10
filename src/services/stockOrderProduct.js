const db = require('../models');
const logger = require('../utils/logger');

// u 为台账设备；未入库缺规格时，只接受整单商品均可识别且唯一的料号。
const PRODUCT_JOIN_SQL = `LEFT JOIN LATERAL (
  SELECT (array_agg(DISTINCT sp.id))[1] AS product_id
  FROM pickup_devices d JOIN orders o ON o.id=d.order_id
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.products)='array' THEN o.products ELSE '[]'::jsonb END) item
  LEFT JOIN stock_products sp ON sp.sku_code=UPPER(TRIM(COALESCE(NULLIF(item->>'skuCode',''),NULLIF(item->>'sku',''),item->>'model')))
  WHERE u.state='registered' AND u.product_id IS NULL AND d.stock_unit_id=u.id
  HAVING count(*)>0 AND bool_and(sp.id IS NOT NULL) AND count(DISTINCT sp.id)=1
) order_product ON true
LEFT JOIN stock_products p ON p.id=COALESCE(u.product_id,order_product.product_id)`;

/** 批量读取与列表、统计相同的有效规格，不写库、不返回订单私密信息。 */
async function effectiveProducts(ctx, ids) {
  try {
    if (!ids.length) return new Map();
    const [rows] = await db.sequelize.query(
      `SELECT u.id AS "unitId",p.id,p.model_name AS "modelName",p.storage_gb AS "storageGb",p.color_name AS "colorName",CASE WHEN u.product_id IS NULL THEN 'order' ELSE 'manual' END AS source
      FROM stock_units u ${PRODUCT_JOIN_SQL} WHERE u.id IN (:ids) AND p.id IS NOT NULL`,
      { replacements: { ids }, transaction: ctx.transaction }
    );
    return new Map(rows.map(({ unitId, ...product }) => [unitId, product]));
  } catch (error) {
    logger.warn('读取订单关联库存规格失败', { code: error.code || error.name });
    throw error;
  }
}
module.exports = { PRODUCT_JOIN_SQL, effectiveProducts };
