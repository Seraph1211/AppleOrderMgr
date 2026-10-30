/**
 * 构造不含真实订单、账号或出口信息的正常队列 refresh audit。
 * 字段集合来自生产写入器 runOfficialOrderHttpQueue.py，值全部为合成测试值。
 */
function makeOfficialHttpRefreshAudit({ attemptId, jobId, orderId, runId, startedAt, finishedAt }) {
  return {
    attemptId,
    jobId,
    orderId,
    startedAt,
    outcome: 'SUCCEEDED',
    cleanupVerified: true,
    probeBeforeAttempts: 1,
    probeBeforeAttemptsDiagnostics: [],
    egressBefore: '192.0.2.10',
    collectorOutcome: 'SUCCEEDED',
    runId,
    probeAfterAttempts: 1,
    probeAfterAttemptsDiagnostics: [],
    egressAfter: '192.0.2.10',
    finishedAt,
  };
}

function makeOfficialHttpRefreshResult({
  orderId,
  runId,
  bodyFile,
  bodySha256,
  urlHash,
  observedAt,
}) {
  return {
    completeItemCount: 1,
    identityMatched: true,
    orderNumber: 'SYNTHETIC-ORDER',
    orderPlacedDateText: '2026-10-29',
    products: [],
    source: {
      cached: false,
      contentType: 'application/json',
      file: bodyFile,
      host: 'www.apple.com.cn',
      observedAt,
      path: '/synthetic',
      provider: 'Apple official website',
      runId,
      sha256: bodySha256,
      status: 200,
      urlHash,
    },
    sourceModel: 'official-http',
    systemOrderId: orderId,
  };
}

module.exports = { makeOfficialHttpRefreshAudit, makeOfficialHttpRefreshResult };
