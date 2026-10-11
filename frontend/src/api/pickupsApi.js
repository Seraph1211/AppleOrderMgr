import client from './client';

function serializeFilters(params = {}) {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value) ? JSON.stringify(value) : value,
    ])
  );
}

/** 读取历史照片所在记录，保留订单详情的分页和精确身份核对。 */
export const getPickupRecords = params =>
  client.get('/pickups', { params: serializeFilters(params) });
/** 取得授权订单历史凭证的短期读取地址。 */
export const getPickupEvidenceUrl = (orderId, evidenceId) =>
  client.get(`/pickups/${orderId}/evidence/${evidenceId}`);

/** 上传单张标签图片到服务端 OCR，取消只停止等待，不保证撤回已受理调用。 */
export function recognizePickupSerial(orderId, image, signal) {
  const form = new FormData();
  form.append('image', image);
  return client.post(`/pickups/${orderId}/devices/ocr`, form, {
    headers: { 'Content-Type': undefined },
    timeout: 40000,
    signal,
  });
}
