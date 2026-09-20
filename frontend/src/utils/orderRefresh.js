const ACTIVE_STATUSES = ['pending', 'running'];
const ERROR_LABELS = {
  PAGE_LOADING: '官网尚未返回详情',
  REQUEST_TIMEOUT: '连接超时，可重试',
  TASK_TIMEOUT: '刷新超时，可重试',
  RESPONSE_STREAM: '连接中断，可重试',
  REQUEST_CANCELLED: '刷新已取消',
  PROXY_TRANSPORT: '线路暂不可用',
  APPLE_541: '官网暂时限制访问',
  APPLE_429: '官网请求受限',
  PROXY_407: '代理配置异常',
  HTTP_631: '上游响应异常（631）',
  IDENTITY: '订单身份异常，请核对',
  PARSE: '订单详情解析未完成',
};

function time(value) {
  return Date.parse(value) || 0;
}

/** 记录提交前已知的服务端观察时间，用于清理提交失败后出现的新结果。 */
export function getRefreshObservation(order) {
  return Math.max(time(order?.refreshLastSuccessAt), time(order?.refreshLastFailureAt));
}

/** 将最新订单状态与本地任务协调，避免旧终态遮挡新任务或新成功结果。 */
export function reconcileRowRefresh(previous, orders) {
  let next = previous;
  for (const order of orders) {
    const local = previous[order.id];
    if (!local || local.status === 'submitting') continue;
    const newerJob =
      order.refreshJob && (!local.jobId || Number(order.refreshJob.id) > Number(local.jobId));
    const localFinished = time(local.finishedAt);
    const observed = getRefreshObservation(order);
    const terminalObserved =
      localFinished > 0 && observed >= localFinished && !ACTIVE_STATUSES.includes(local.status);
    const submittedFailureSuperseded =
      !local.jobId &&
      local.status === 'failed' &&
      Number.isFinite(local.observedBeforeSubmit) &&
      observed > local.observedBeforeSubmit;
    if (newerJob || terminalObserved || submittedFailureSuperseded) {
      if (next === previous) next = { ...previous };
      delete next[order.id];
    }
  }
  return next;
}

/** 仅接受仍对应当前任务的轮询结果，提交新任务后忽略旧请求回包。 */
export function applyRefreshJobResult(previous, result) {
  const local = previous[result.orderId];
  if (
    !local ||
    String(local.jobId) !== String(result.jobId) ||
    !ACTIVE_STATUSES.includes(local.status)
  )
    return previous;
  return {
    ...previous,
    [result.orderId]: {
      jobId: result.jobId,
      status: result.status,
      errorCode: result.lastErrorCode,
      finishedAt: result.finishedAt,
      message: result.lastErrorMessage || '',
    },
  };
}

/** 为列表提供可折叠中文反馈；服务端成功时间必须晚于旧失败才消除失败状态。 */
export function getOrderRefreshFeedback(order, local) {
  const current = reconcileRowRefresh(local ? { [order.id]: local } : {}, [order])[order.id];
  const status =
    current?.status ||
    order.refreshJob?.status ||
    (order.freshnessStatus === 'failed' &&
    time(order.refreshLastFailureAt) >= time(order.refreshLastSuccessAt)
      ? 'failed'
      : null);
  const errorCode = current?.errorCode || order.refreshErrorCode;
  const message = current?.message || order.refreshErrorMessage || '未取得最新订单数据，请稍后重试';
  const label =
    {
      submitting: '提交中',
      pending: '排队中',
      running: '刷新中',
      succeeded: '刷新成功',
      skipped: '本次未执行刷新',
    }[status] ||
    (Object.hasOwn(ERROR_LABELS, errorCode) ? ERROR_LABELS[errorCode] : null) ||
    '刷新未完成，可重试';
  return {
    status,
    label,
    message,
    errorCode,
    busy: ['submitting', ...ACTIVE_STATUSES].includes(status),
    failedAt: current?.finishedAt || order.refreshLastFailureAt,
    lastSuccessAt: order.refreshLastSuccessAt || order.lastCrawledAt,
    isIdentityError: errorCode === 'IDENTITY',
  };
}
