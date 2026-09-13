/** 格式化两张付款页面共用的订单复制内容。 */
export function buildPaymentCopyText(task, paymentUrl) {
  const grouped = new Map();
  for (const product of Array.isArray(task.products) ? task.products : []) {
    const productName = String(product?.name || '').trim();
    const model = String(product?.model || '').trim();
    const name = productName || model;
    if (!name) continue;
    const parsedQuantity = Number(product?.quantity);
    const quantity = Number.isInteger(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1;
    const key = JSON.stringify([name, model]);
    if (grouped.has(key)) grouped.get(key).quantity += quantity;
    else grouped.set(key, { name, quantity });
  }
  const productInfo = [...grouped.values()]
    .map(product => `${product.name} x ${product.quantity}`)
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

  return `${task.orderId ?? '-'} || ${productInfo || '-'} || ${paymentMethod || '-'} || ${paymentUrl}`;
}
