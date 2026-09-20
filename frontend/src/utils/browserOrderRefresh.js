export const BROWSER_EXTENSION_ID = 'oghnhnhheeajagnfjmicoicdpokacdmc';

function sanitizeDiagnostics(input) {
  const output = {};
  for (const key of ['documentStatuses', 'fetchOrderStatuses']) {
    if (Array.isArray(input?.[key]))
      output[key] = input[key]
        .filter(value => Number.isInteger(value) && value >= 100 && value <= 999)
        .slice(0, 10);
  }
  for (const key of [
    'requestCount',
    'parsedBodies',
    'missingDetailBodies',
    'unrecognizedBodies',
    'bodyReadFailures',
    'bodyParseFailures',
    'networkFailures',
  ]) {
    if (Number.isInteger(input?.[key]) && input[key] >= 0 && input[key] <= 1000)
      output[key] = input[key];
  }
  return output;
}

/** 通过已安装的采集端取得正常官网响应；任务票据始终留在管理台。 */
export function collectBrowserOrder({ runtime, task, permit, signal, onProgress = () => {} }) {
  return new Promise((resolve, reject) => {
    let port;
    let settled = false;
    let ready = false;
    const timeout = setTimeout(() => finish(new Error('浏览器采集超时，本次未更新')), 95000);
    const connectTimeout = setTimeout(
      () => finish(new Error('未连接到订单采集扩展，请先安装或启用')),
      3000
    );
    const finish = (error, page) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(connectTimeout);
      signal?.removeEventListener('abort', cancel);
      try {
        port?.disconnect();
      } catch {
        /* 连接可能已经结束。 */
      }
      if (error) reject(error);
      else resolve(page);
    };
    const cancel = () => finish(new Error('已取消浏览器刷新，本次未更新'));
    const receive = async message => {
      try {
        if (settled) return;
        if (message?.type === 'ready' && !ready) {
          ready = true;
          clearTimeout(connectTimeout);
          const details = await task();
          if (settled) return;
          port.postMessage({
            type: 'start',
            orderUrl: details.orderUrl,
            orderNumber: details.orderNumber,
            expiresAt: details.expiresAt,
          });
          onProgress('collecting');
        } else if (message?.type === 'permit' && ready) {
          if (!Number.isInteger(message.id) || message.id < 1 || message.id > 100)
            throw new Error('浏览器请求数量无效');
          await permit();
          if (!settled) port.postMessage({ type: 'permit', id: message.id, allowed: true });
        } else if (message?.type === 'result') {
          if (message.error || !message.page) {
            const error = new Error(message.error || '浏览器未返回订单详情');
            error.diagnostics = sanitizeDiagnostics(message.diagnostics);
            finish(error);
          } else finish(null, message.page);
        }
      } catch (error) {
        finish(error);
      }
    };
    try {
      if (signal?.aborted) {
        cancel();
        return;
      }
      if (!runtime?.connect) throw new Error('当前浏览器不支持订单采集扩展，请使用桌面 Chrome');
      port = runtime.connect(BROWSER_EXTENSION_ID, {
        name: 'apple-order-refresh',
      });
      port.onMessage.addListener(receive);
      port.onDisconnect.addListener(() => {
        // 读取 lastError，避免 Chrome 输出未处理错误；不向用户回显原始运行时信息。
        void runtime.lastError;
        finish(new Error('订单采集扩展已断开，本次未更新'));
      });
      signal?.addEventListener('abort', cancel, { once: true });
    } catch (error) {
      finish(error);
    }
  });
}
