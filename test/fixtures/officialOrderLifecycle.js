/**
 * 根据 2026-09-08 四阶段与历史终态观测的字段结构重建。
 * 所有身份、金额和时间均为合成值；不包含原始页面、令牌、PIN 或联系人。
 */
const PHASES = {
  PAYMENT_DUE_STORED_ORDER: ['', '我们正在等待你的付款'],
  PAYMENT_RECEIVED: ['DEFERRED_PAYMENT_RECEIVED', '明天到 Apple Store 零售店取货。'],
  PROCESSING: ['PROCESSING_IMM_PICKUP', '你的商品很快将准备完毕，可供提取'],
  READY_FOR_PICKUP: ['READY_FOR_PICKUP', '请在 9月 15 前提取你的商品'],
  PICKED_UP: ['PICKED_UP', '已取货'],
  PAYMENT_EXPIRED_STORED_ORDER: ['', '付款已过期'],
};

/** 创建可安全提交仓库的最小官网结构 Fixture。 */
function buildLifecycleJson(status, options = {}) {
  const [description, message] = PHASES[status] || ['', ''];
  const key =
    options.key ||
    (['PAYMENT_DUE_STORED_ORDER', 'PAYMENT_RECEIVED'].includes(status)
      ? 'orderItem-11'
      : 'orderItem-0000101');
  const details = {
    productName: '测试手机 256GB 蓝色',
    quantity: 1,
    pickupType: 'INSTORE',
    deliveryDate: message,
  };
  const header = { d: { orderNumber: 'W1234567890', orderPlacedDate: '2026年9月8日' } };
  if (status === 'PAYMENT_DUE_STORED_ORDER') {
    details.paymentTimeToExpiryEpoch = 1788871260;
    header.payNow = { d: { totalAmount: 'RMB 8,999.00', showPayNowButton: true } };
  }
  return {
    orderDetail: {
      orderHeader: header,
      billingInfo: { d: { paymentMethodPaymentTypeName: '支付宝' } },
      orderItems: {
        c: [key],
        [key]: {
          d: { deliveryType: 'RETAIL_STORE' },
          orderItemDetails: { d: details },
          orderItemStatusTracker: {
            d: {
              currentStatus: status,
              statusDescription: description,
              possibleStatuses: ['PAYMENT_RECEIVED', 'PROCESSING', 'READY_FOR_PICKUP', 'PICKED_UP'],
            },
          },
          shippingInfo: {
            'shipping-address': { address: { d: { companyName: 'Apple 测试门店' } } },
          },
        },
      },
    },
  };
}

/** 将合成结构放入正式优先解析的 init_data 节点。 */
function buildLifecycleHtml(status, options) {
  return `<html><body><main>通用帮助内容</main><script id="init_data" type="application/json">${JSON.stringify(buildLifecycleJson(status, options))}</script></body></html>`;
}

module.exports = { buildLifecycleJson, buildLifecycleHtml };
