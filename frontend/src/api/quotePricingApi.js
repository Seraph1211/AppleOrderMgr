import client from './client';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/** 读取无需登录的 Apple 全系公开报价。 */
export async function getPublicAppleQuotes() {
  const response = await fetch(`${API_BASE_URL}/public/apple-quotes`, {
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error?.message || '报价暂时不可用，请稍后再试');
  }
  return payload;
}

/** 读取管理员报价和当前调整。 */
export const getIphone18QuotePricing = () => client.get('/quote-pricing/iphone18');

/** 切换固定公开报价链接。 */
export const setIphone18QuoteAvailability = payload =>
  client.put('/quote-pricing/iphone18/availability', payload);

/** 保存公开报价逐行展示顺序。 */
export const saveIphone18QuoteDisplayOrder = payload =>
  client.put('/quote-pricing/iphone18/display-order', payload);

/** 覆盖选中商品的百分比和固定金额调整。 */
export const saveIphone18QuoteAdjustments = payload =>
  client.put('/quote-pricing/iphone18/adjustments', payload);

/** 删除选中商品的调整规则。 */
export const resetIphone18QuoteAdjustments = payload =>
  client.post('/quote-pricing/iphone18/adjustments/reset', payload);

/** 读取调价历史版本。 */
export const getIphone18QuoteVersions = (limit = 20) =>
  client.get('/quote-pricing/iphone18/versions', { params: { limit } });

/** 恢复一个历史调价快照。 */
export const restoreIphone18QuoteVersion = (id, payload) =>
  client.post(`/quote-pricing/iphone18/versions/${id}/restore`, payload);
