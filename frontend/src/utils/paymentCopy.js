import { formatPaymentDeadline } from './paymentDeadline.js';
import { groupDisplayProducts } from './productDisplay.js';

/** 格式化两张付款页面共用的订单复制内容。 */
export function buildPaymentCopyText(task, paymentUrl) {
  const productInfo = groupDisplayProducts(
    (Array.isArray(task.products) ? task.products : []).map(product => {
      const quantity = Number(product?.quantity);
      return { ...product, quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1 };
    })
  )
    .map(product => `${product.name} x ${product.quantity ?? '待核实'}`)
    .join('、');
  const rawPaymentMethod = String(task.paymentMethod || '').trim();
  const normalizedPaymentMethod = rawPaymentMethod.toLowerCase();
  const paymentMethod =
    {
      wechat: '微信',
      'wechat pay': '微信',
      微信支付: '微信',
      alipay: '支付宝',
    }[normalizedPaymentMethod] || rawPaymentMethod;

  return `${task.orderId ?? '-'} || ${productInfo || '-'} || ${paymentMethod || '-'} || ${formatPaymentDeadline(task.orderDate)} || ${paymentUrl}`;
}
