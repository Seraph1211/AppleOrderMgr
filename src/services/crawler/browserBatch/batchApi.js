const { batchError } = require('./batchConfig');

/** 创建只向指定系统发送凭证的 API 客户端；禁止重定向及不确定提交的重试。 */
function createBatchApi({ apiBaseUrl, token, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{20,8192}$/.test(token)) {
    throw batchError('INVALID_LOGIN_TOKEN');
  }
  async function call(orderId, action, body, signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, 35000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const response = await fetchImpl(
        `${apiBaseUrl}/orders/${orderId}/browser-refresh/${action}`,
        {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const text = await response.text();
      if (text.length > 1024 * 1024) throw batchError('API_RESPONSE_INVALID');
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        throw batchError('API_RESPONSE_INVALID');
      }
      if (!response.ok || payload.success !== true) {
        const known = new Set([
          'REFRESH_PAUSED',
          'BROWSER_REFRESH_DISABLED',
          'BROWSER_ORDER_CHANGED',
          'BROWSER_TICKET_INVALID',
        ]);
        const code =
          response.status === 401 || response.status === 403
            ? 'API_AUTH_REQUIRED'
            : known.has(payload.error?.code)
              ? payload.error.code
              : 'API_REJECTED';
        throw batchError(code);
      }
      return payload.data;
    } catch (error) {
      if (error.code && /^[A-Z_]+$/.test(error.code) && error.message === error.code) throw error;
      throw batchError(signal?.aborted ? 'CANCELLED' : 'API_UNREACHABLE');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  return {
    start: (id, signal) => call(id, 'start', { mode: 'isolated_batch' }, signal),
    permit: (id, ticket, signal) =>
      call(id, 'permit', { ticket }, signal).then(result => {
        if (result?.allowed !== true) throw batchError('PERMIT_DENIED');
      }),
    submit: (id, ticket, page, signal) => call(id, 'result', { ticket, page }, signal),
  };
}

module.exports = { createBatchApi };
