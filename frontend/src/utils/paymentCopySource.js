import { buildPaymentCopyText } from './paymentCopy.js';
import { decodePaymentQr } from './paymentQr.js';
import { isWechatPayment } from './paymentMethod.js';

/** 从已鉴权付款码优先提取支付地址，缺码或识读失败再读取原订单链接。 */
export async function readPaymentCopyText(task, getCode, getLink, decode = decodePaymentQr) {
  try {
    const response = isWechatPayment(task.paymentMethod)
      ? await getCode(task.id)
      : { success: true, data: { availability: 'unsupported' } };
    if (
      !response.success ||
      !['available', 'missing', 'unsupported'].includes(response.data?.availability)
    ) {
      throw new Error('付款码读取失败，请重试');
    }
    const paymentUrl =
      response.data.availability === 'available' ? await decode(response.data.imageDataUrl) : null;
    if (paymentUrl) return buildPaymentCopyText(task, paymentUrl);
    const link = await getLink(task.id);
    if (!link.success || !link.data?.paymentUrl) throw new Error('订单链接不存在');
    return buildPaymentCopyText(task, link.data.paymentUrl);
  } catch (error) {
    throw new Error(`${task.orderNumber}：${error.message || '订单信息读取失败'}`);
  }
}
