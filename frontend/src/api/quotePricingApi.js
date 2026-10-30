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

/** 读取无需登录的 Duo 明威原始批发报价。 */
export async function getPublicDuoQuotes(signal) {
  try {
    const response = await fetch(`${API_BASE_URL}/public/duo-quotes`, {
      headers: { Accept: 'application/json' },
      signal,
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error?.message || '报价暂时不可用，请稍后再试');
    }
    return payload.data;
  } catch (error) {
    if (error instanceof TypeError) throw new Error('无法连接报价服务，请稍后重试');
    throw error;
  }
}

/** 读取无需登录的Duo零售价与官网价走势。 */
export async function getPublicDuoQuoteHistory(range = '7d', signal) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/public/duo-quotes/history?range=${encodeURIComponent(range)}`,
      {
        headers: { Accept: 'application/json' },
        signal,
        cache: 'no-store',
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error?.message || '价格走势暂时不可用，请稍后再试');
    }
    return payload.data;
  } catch (error) {
    if (error instanceof TypeError) throw new Error('无法连接报价服务，请稍后重试');
    throw error;
  }
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

/** 读取管理员 Duo 八款报价与版本。 */
export const getDuoQuotePricing = () => client.get('/quote-pricing/duo');

/** 预览 Duo 调价、恢复默认或历史恢复。 */
export const previewDuoQuotePricing = payload => client.post('/quote-pricing/duo/preview', payload);

/** 保存 Duo 商品的随行加价额。 */
export const saveDuoQuoteAdjustments = payload =>
  client.put('/quote-pricing/duo/adjustments', payload);

/** 将选中 Duo 商品恢复为默认加价额。 */
export const resetDuoQuoteAdjustments = payload =>
  client.post('/quote-pricing/duo/adjustments/reset', payload);

/** 读取 Duo 调价历史。 */
export const getDuoQuoteVersions = (limit = 20, offset = 0) =>
  client.get('/quote-pricing/duo/versions', { params: { limit, offset } });

/** 恢复 Duo 历史加价快照。 */
export const restoreDuoQuoteVersion = (id, payload) =>
  client.post(`/quote-pricing/duo/versions/${id}/restore`, payload);
