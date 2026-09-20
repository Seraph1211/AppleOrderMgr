/**
 * 等待时响应取消信号，避免任务结束后继续占用重试或代理等待槽。
 * @param {number} delayMs - 等待毫秒数
 * @param {AbortSignal} [signal] - 抓取取消信号
 * @returns {Promise<void>} 等待完成
 */
function waitForRefresh(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 创建抓取流程总时限，底层网络必须使用返回的 signal。
 * @param {number} timeoutMs - 总预算
 * @param {AbortSignal} [parentSignal] - 调用方取消信号
 * @returns {Object} 信号与清理方法
 */
function createRefreshBudget(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  const cancel = () => {
    const error = new Error('刷新请求已取消');
    error.refreshErrorCode = 'REQUEST_CANCELLED';
    controller.abort(error);
  };
  const expire = () => {
    const error = new Error('抓取总时限已到，请稍后重试');
    error.refreshErrorCode = 'TASK_TIMEOUT';
    controller.abort(error);
  };
  const timer = setTimeout(expire, timeoutMs);
  timer.unref?.();
  if (parentSignal?.aborted) cancel();
  else parentSignal?.addEventListener('abort', cancel, { once: true });
  return {
    signal: controller.signal,
    check() {
      if (Date.now() >= expiresAt && !controller.signal.aborted) expire();
      controller.signal.throwIfAborted();
    },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', cancel);
    },
  };
}

module.exports = { waitForRefresh, createRefreshBudget };
