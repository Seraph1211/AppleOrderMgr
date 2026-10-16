const { Sequelize } = require('sequelize');

// 与 JavaScript String.trim 相同的空白集合；非空 TAG 保留原文用于精确授权。
const SQL_WHITESPACE =
  "E'\\u0009\\u000a\\u000b\\u000c\\u000d\\u0020\\u00a0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'";
const trimmed = expression => `btrim(${expression}, ${SQL_WHITESPACE})`;
const nonblank = expression => `CASE WHEN ${trimmed(expression)} <> '' THEN ${expression} END`;

/** 返回有效 TAG，非空字符串保留原值。 */
function normalizeRecipientTag(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** 唯一业务 TAG SQL：AOS 来源优先，姓名与来源尾号唯一匹配才允许档案兜底。 */
function recipientTagSql(alias = 'Order') {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid order alias');
  const order = `"${alias}"`;
  const name = `NULLIF(${trimmed(`${order}.recipient_name`)}, '')`;
  const sourceName = `CASE WHEN ${order}.ingestion_source = 'aos' THEN NULLIF(${trimmed(`COALESCE(${order}.source_last_name, '') || COALESCE(${order}.source_first_name, '')`)}, '') END`;
  const tail = `upper(${trimmed(`${order}.recipient_id_last4`)})`;
  // 不使用 recipient_ref 或加密身份证快照推导身份；快照可能来自旧档案补充。
  return `(CASE WHEN ${order}.ingestion_source = 'aos' AND ${trimmed(`${order}.source_recipient_tag`)} <> ''
    THEN ${order}.source_recipient_tag
    ELSE (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(${nonblank('r.tag')}) END
      FROM recipients r
      WHERE ${tail} ~ '^[0-9]{3}[0-9X]$'
        AND r.id_card_last4 = ${tail}
        AND r.last_name || r.first_name = COALESCE(${sourceName}, ${name})
        AND (${sourceName} IS NULL OR ${name} IS NULL OR ${sourceName} = ${name})) END)`;
}

/** 按同一口径生成 Sequelize 条件。 */
function recipientTagWhere(value, alias = 'Order') {
  return Sequelize.where(Sequelize.literal(recipientTagSql(alias)), value);
}

/** 只信 AOS 来源和查询计算列；预加载关联不能证明全库唯一匹配。 */
function getRecipientTag(order) {
  const source =
    order?.ingestionSource === 'aos' && normalizeRecipientTag(order.sourceRecipientTag);
  return source || normalizeRecipientTag(order?.recipientTag ?? order?.get?.('recipientTag'));
}

/** 订单姓名采用来源快照，不把旧关联档案姓名冒充来源身份。 */
function getOrderRecipientName(order) {
  const sourceName =
    order?.ingestionSource === 'aos'
      ? `${order.sourceLastName || ''}${order.sourceFirstName || ''}`.trim()
      : '';
  return (
    sourceName ||
    (typeof order?.recipientName === 'string' ? order.recipientName.trim() : '') ||
    null
  );
}

/** 返回最终 TAG 的来源；空值不猜测来源。 */
function getRecipientTagSource(order) {
  if (getRecipientTag(order) === null) return null;
  return order?.ingestionSource === 'aos' && normalizeRecipientTag(order.sourceRecipientTag)
    ? 'aos'
    : 'recipient';
}

/** 有值优先；保留已有缺失状态枚举，未关联也可能唯一匹配到档案。 */
function getRecipientTagState(order) {
  if (getRecipientTag(order) !== null) return 'present';
  return !order?.recipientRef && !order?.recipient ? 'unlinked' : 'missing';
}

/** 付款等嵌套订单查询所需的计算属性。 */
function recipientTagAttributes(alias = 'order') {
  return [
    'recipientRef',
    'ingestionSource',
    'sourceRecipientTag',
    'sourceLastName',
    'sourceFirstName',
    'recipientName',
    [Sequelize.literal(recipientTagSql(alias)), 'recipientTag'],
  ];
}

/** 全字段订单查询显式附加最终 TAG，不影响聚合查询或写入快照。 */
function recipientTagProjection(alias = 'Order') {
  return { include: [[Sequelize.literal(recipientTagSql(alias)), 'recipientTag']] };
}

module.exports = {
  normalizeRecipientTag,
  recipientTagSql,
  recipientTagWhere,
  getRecipientTag,
  getRecipientTagSource,
  getOrderRecipientName,
  getRecipientTagState,
  recipientTagAttributes,
  recipientTagProjection,
};
