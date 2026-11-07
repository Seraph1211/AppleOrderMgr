const BASE = '/api/public/apple-purchase-availability';

async function get(path, query, signal) {
  try {
    const response = await fetch(`${BASE}/${path}${query ? `?${query}` : ''}`, {
      signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    const data = await response.json();
    if (response.ok) return data;
    const error = new Error(data.error?.message || '有货记录查询暂不可用');
    error.code = data.error?.code;
    throw error;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new Error('有货记录查询暂不可用');
    }
    throw error;
  }
}

export const publicApplePurchaseAvailabilityApi = {
  availabilityOptions: (query, signal) => get('options', query, signal),
  availabilityRecords: (query, signal) => get('records', query, signal),
  availabilityTrend: (query, signal) => get('trend', query, signal),
  availabilityChanges: (query, signal) => get('changes', query, signal),
};

/** 订阅公开的同步版本提示。 */
export function subscribePublicAvailability(onVersion) {
  if (typeof EventSource !== 'function') return () => {};
  const stream = new EventSource(`${BASE}/events`);
  stream.addEventListener('inventory-version', event => {
    try {
      onVersion(JSON.parse(event.data));
    } catch {
      // 忽略异常事件，等待后续通知。
    }
  });
  return () => stream.close();
}
