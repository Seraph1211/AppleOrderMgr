/* eslint-disable camelcase -- 既有订单 API 使用 snake_case */
const { safeText } = require('./text');

/** 订单商品对外白名单，历史图片和动作链接也不返回。 */
function serializePublicProducts(products, filterItems = []) {
  return (Array.isArray(products) ? products : []).map((product, productIndex) => {
    const result = {};
    for (const key of ['model', 'name']) {
      if (product[key] !== undefined) result[key] = safeText(product[key]);
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
  serializeOrderPricing,
  serializeOrderPricingFields,
  serializeEmailLifecycleFields,
};
