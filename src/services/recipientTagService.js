const { Sequelize } = require('sequelize');

/** 返回有效档案 TAG，非空字符串保留原值。 */
function normalizeRecipientTag(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** 唯一业务 TAG SQL；别名仅接受代码内静态标识符。 */
function recipientTagSql(alias = 'Order') {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid order alias');
  return `(SELECT CASE WHEN btrim(r.tag, E'\\u0009\\u000a\\u000b\\u000c\\u000d\\u0020\\u00a0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff') <> '' THEN r.tag ELSE NULL END FROM recipients r WHERE r.id = "${alias}".recipient_ref)`;
}

/** 按同一口径生成 Sequelize 条件。 */
function recipientTagWhere(value, alias = 'Order') {
  return Sequelize.where(Sequelize.literal(recipientTagSql(alias)), value);
}

/** 从已预加载档案或查询计算列读取 TAG，绝不回退订单来源。 */
function getRecipientTag(order) {
  return normalizeRecipientTag(
    order?.recipient?.tag ?? order?.recipientTag ?? order?.get?.('recipientTag')
  );
}

/** 区分未关联、已关联缺失与有效 TAG。 */
function getRecipientTagState(order) {
  if (!order?.recipientRef && !order?.recipient) return 'unlinked';
  return getRecipientTag(order) === null ? 'missing' : 'present';
}

/** 付款等嵌套订单查询所需的计算属性。 */
function recipientTagAttributes(alias = 'order') {
  return ['recipientRef', [Sequelize.literal(recipientTagSql(alias)), 'recipientTag']];
}

module.exports = {
  normalizeRecipientTag,
  recipientTagSql,
  recipientTagWhere,
  getRecipientTag,
  getRecipientTagState,
  recipientTagAttributes,
};
