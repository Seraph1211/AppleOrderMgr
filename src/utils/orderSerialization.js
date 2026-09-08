/* eslint-disable camelcase -- 既有订单 API 使用 snake_case */
const { safeText } = require('../services/crawler/officialOrderData');

/** 订单商品对外白名单，历史图片和动作链接也不返回。 */
function serializePublicProducts(products) {
  return (Array.isArray(products) ? products : []).map(product => {
    const result = {};
    for (const key of [
      'model',
      'name',
      'status',
      'statusDescription',
      'deliveryType',
      'pickupType',
      'fulfillmentMessage',
    ]) {
      if (product[key] !== undefined)
        result[key] = safeText(product[key], key === 'fulfillmentMessage' ? 1000 : 255);
    }
    if (
      product.quantity !== null &&
      product.quantity !== undefined &&
      Number.isInteger(Number(product.quantity)) &&
      Number(product.quantity) >= 0
    )
      result.quantity = Number(product.quantity);
    return result;
  });
}

/** 冲突仅暴露业务白名单；身份异常不泄漏另一个订单的数据。 */
function serializeValidationIssues(issues) {
  return (Array.isArray(issues) ? issues : []).slice(0, 100).map(issue => {
    if (issue.type === 'order_identity')
      return {
        type: 'order_identity',
        field: 'orderNumber',
        message: '订单链接或官网返回身份不一致，已拒绝覆盖，请人工核对',
      };
    const result = {
      type: safeText(issue.type, 50),
      message: safeText(issue.message, 500) || '订单数据需要核对',
    };
    if (
      /^(?:paymentMethod|pickupStore|orderDate|products(?:\.\d+(?:\.(?:model|name|quantity))?)?)$/.test(
        issue.field || ''
      )
    ) {
      result.field = issue.field;
      result.source = 'imported';
      result.resolution = issue.resolution === 'official' ? 'official' : null;
      for (const key of ['sourceValue', 'officialValue'])
        result[key] = typeof issue[key] === 'number' ? issue[key] : safeText(issue[key], 500);
    }
    return result;
  });
}

/** 最新官网观测 DTO，不返回完整来源快照。 */
function serializeOfficialFields(order) {
  return {
    official_raw_status: order.officialRawStatus || null,
    official_status_description: order.officialStatusDescription ?? null,
    official_status_observed_at: order.officialStatusObservedAt || null,
    official_fulfillment_message: order.officialFulfillmentMessage || null,
    official_payment_expires_at: order.officialPaymentExpiresAt || null,
    official_payment_method: order.officialPaymentMethod || null,
    official_status_needs_review: Boolean(order.officialStatusNeedsReview),
    official_all_items_terminal: Boolean(order.officialAllItemsTerminal),
    official_field_diagnostics: Object.fromEntries(
      Object.entries(order.officialFieldDiagnostics || {}).filter(
        ([key, value]) =>
          /^(?:amount|paymentMethod|statusDescription|paymentExpiresAt(?:\.\d+)?)$/.test(key) &&
          ['missing', 'null', 'invalid', 'value'].includes(value)
      )
    ),
  };
}

module.exports = { serializePublicProducts, serializeValidationIssues, serializeOfficialFields };
