/* eslint-disable camelcase -- 既有订单 API 使用 snake_case */
const { safeText } = require('../services/crawler/officialOrderData');

/** 订单商品对外白名单，历史图片和动作链接也不返回。 */
function serializePublicProducts(products, filterItems = []) {
  return (Array.isArray(products) ? products : []).map((product, productIndex) => {
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
    const filter = filterItems?.find(item => item.productIndex === productIndex);
    if (filter) {
      result.filterKeys = filter.keys;
      result.filterNeedsReview = filter.needsReview;
    }
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
      result.resolution = ['official', 'manual_review'].includes(issue.resolution)
        ? issue.resolution
        : null;
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

/**
 * 对外映射金额；不以官网观测或 0 代替未知值。
 * @param {Object} order 订单
 * @returns {Object} camelCase 金额字段
 */
function serializeOrderPricing(order) {
  return {
    orderAmount: order?.orderAmount == null ? null : Number(order.orderAmount).toFixed(2),
    orderAmountCurrency: 'CNY',
    orderAmountSource: 'catalog',
    orderAmountPriceVersion: order?.orderAmountPriceVersion || null,
  };
}

/**
 * 订单列表和详情使用的 snake_case 金额字段。
 * @param {Object} order 订单
 * @returns {Object} 订单 API 金额字段
 */
function serializeOrderPricingFields(order) {
  const pricing = serializeOrderPricing(order);
  return {
    order_amount: pricing.orderAmount,
    order_amount_currency: pricing.orderAmountCurrency,
    order_amount_source: pricing.orderAmountSource,
    order_amount_price_version: pricing.orderAmountPriceVersion,
  };
}

/** 官方订单邮件归并字段；与官网状态及人工付款任务保持独立。 */
function serializeEmailLifecycleFields(order) {
  return {
    email_order_status: order?.emailOrderStatus || 'unknown',
    email_payment_status: order?.emailPaymentStatus || 'unknown',
    email_status_needs_review: Boolean(order?.emailStatusNeedsReview),
    email_status_review_reasons: Array.isArray(order?.emailStatusReviewReasons)
      ? order.emailStatusReviewReasons
      : [],
    email_status_version: Number(order?.emailStatusVersion || 0),
    email_status_evidence_at: order?.emailStatusEvidenceAt || null,
    email_pickup_info: order?.emailPickupInfo || null,
    email_pickup_date: order?.emailPickupDate || null,
    email_lifecycle_updated_at: order?.emailLifecycleUpdatedAt || null,
  };
}

module.exports = {
  serializePublicProducts,
  serializeValidationIssues,
  serializeOfficialFields,
  serializeOrderPricing,
  serializeOrderPricingFields,
  serializeEmailLifecycleFields,
};
