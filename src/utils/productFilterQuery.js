const { Sequelize } = require('sequelize');
const ApiError = require('./ApiError');

/** 校验公开的稳定商品多选键，拒绝非法格式和超限输入。 */
function parseProductKeys(value) {
  if (value === undefined || value === null || value === '') return [];
  let values = value;
  if (typeof value === 'string') {
    try {
      values = JSON.parse(value);
    } catch (_error) {
      throw ApiError.badRequest('productKeys 必须是合法数组');
    }
  }
  if (
    !Array.isArray(values) ||
    values.length > 100 ||
    values.some(
      key =>
        typeof key !== 'string' ||
        !/^(?:sku:[A-Z0-9]{5,12}\/[A-Z0-9]{1,3}:[a-f0-9]{64}|(?:name|review):[a-f0-9]{64})$/.test(key)
    )
  ) {
    throw ApiError.badRequest('productKeys 必须是最多 100 项的合法商品键数组');
  }
  return [...new Set(values)];
}

/** 构造同一商品项的索引条件；调用者只传受控 SQL 列表达式。 */
function productKeySql(keys, column, escape, productIndex = null) {
  if (!keys.length) return null;
  const values = keys.map(escape).join(', ');
  return `EXISTS (SELECT 1 FROM jsonb_array_elements(${column}) AS pf WHERE ${productIndex ? `(pf->>'productIndex')::int = ${productIndex} AND ` : ''}EXISTS (SELECT 1 FROM jsonb_array_elements_text(pf->'keys') AS pk(value) WHERE pk.value IN (${values})))`;
}

/** 订单管理与导出使用的商品键条件，兼容旧商品条件同项匹配。 */
function buildOrderProductCondition(query, sequelize, legacyNames = []) {
  const keys = parseProductKeys(query.productKeys);
  if (!keys.length) return null;
  const keySql = productKeySql(
    keys,
    '"Order"."product_filter_items"',
    value => sequelize.escape(value),
    'ordinality - 1'
  );
  const clauses = [keySql];
  if (legacyNames.length)
    clauses.push(
      `item->>'name' IN (${legacyNames.map(value => sequelize.escape(value)).join(', ')})`
    );
  if (query.productModel)
    clauses.push(`item::text ILIKE ${sequelize.escape(`%${query.productModel}%`)}`);
  return Sequelize.literal(
    `EXISTS (SELECT 1 FROM jsonb_array_elements("Order"."products") WITH ORDINALITY AS p(item, ordinality) WHERE ${clauses.join(' AND ')})`
  );
}

module.exports = { parseProductKeys, productKeySql, buildOrderProductCondition };
