const { PROVIDER_LABEL: ACTIVE_EGRESS } = require('./inventoryTunnelPolicy');
const WAIT_REASONS = new Set([
  'REQUEST_IN_FLIGHT',
  'TARGET_COOLDOWN',
  'PROXY_PROVIDER_COOLDOWN',
  'ALTERNATE_EGRESS_REQUIRED',
  'RECOVERY_PROBE_REQUIRED',
]);
const MANUAL_REASONS = new Set([
  'NO_HEALTHY_PROXY',
  'PROXY_AUTH_FAILED',
  'PROXY_CONNECT_REJECTED',
  'PROXY_CONNECT_FAILED',
  'PROXY_RECOVERY_EXHAUSTED',
  'PROXY_PACKAGE_EXPIRED',
  'PROVIDER_FAILED',
]);

/** 仅投影当前来源的业务健康，不修改保护、预算或恢复门槛。 */
function healthProjection(runtime = {}, guard = {}, config = {}, now, coverage) {
  const reason =
    guard.pausedReason || guard.pausedEgress?.[ACTIVE_EGRESS] || runtime.lastError || null;
  const hour = Math.floor(now / 3600000);
  const day = Math.floor(now / 86400000);
  const budgetUntil =
    reason === 'REQUEST_BUDGET_EXHAUSTED'
      ? Math.max(
        guard.hour === hour && guard.hourCount >= config.hourlyRequests
          ? (hour + 1) * 3600000
          : 0,
        guard.day === day &&
            (guard.dayCount >= config.dailyRequests ||
              (guard.byteCount || 0) + 5242880 > config.dailyBytes ||
              guard.proxyCount >= config.dailyProxyExtractions)
          ? (day + 1) * 86400000
          : 0
      )
      : 0;
  const waitUntil = Math.max(
    budgetUntil,
    guard.cooldownUntil || 0,
    guard.providerCooldownUntil || 0,
    runtime.waitUntil || 0
  );
  const dataStale = coverage ? coverage.expected > 0 && coverage.fresh === 0 : false;
  let state = 'normal';
  let nextAction = '按计划继续采集；库存以各组合有效期为准';
  if (config.enabled === false) {
    state = 'disabled';
    nextAction = '管理员启用采集后按计划查询';
  } else if (!runtime.workerHeartbeat || now - runtime.workerHeartbeat > 120000) {
    state = 'offline';
    nextAction = '管理员检查库存 Worker 服务及数据库连接';
  } else if (guard.pausedReason || guard.pausedEgress?.[ACTIVE_EGRESS]) {
    state = 'manual_required';
    nextAction = '管理员核查当前代理配置、账号或预算，处理后确认恢复探测';
  } else if (guard.cooldownUntil > now) {
    state = 'cooldown';
    nextAction = '自动等待保护冷却到期，再进行有限恢复探测';
  } else if (guard.providerCooldownUntil > now) {
    state = 'automatic_wait';
    nextAction = '自动等待供应商冷却到期，再更换并验证出口';
  } else if (guard.recovering) {
    state = 'recovering';
    nextAction = '自动执行有限恢复探测，仍遵守当前冷却和预算';
  } else if (reason === 'REQUEST_BUDGET_EXHAUSTED') {
    state = 'automatic_wait';
    nextAction = '自动等待预算桶重置后重新核验请求许可；管理员可检查预算配置';
  } else if (MANUAL_REASONS.has(reason)) {
    state = 'manual_required';
    nextAction = '管理员核查当前代理配置、账号或预算，处理后确认恢复探测';
  } else if (WAIT_REASONS.has(reason)) {
    state = 'automatic_wait';
    nextAction = '自动等待请求许可或可用新出口，当前轮次截止后停止未发任务';
  } else if (dataStale) {
    state = 'data_stale';
    nextAction = '当前无有效库存结果；等待新采样并检查最近查询错误';
  } else if (reason) {
    state = 'degraded';
    nextAction = '按计划继续有限重试；持续异常时管理员核查查询原因';
  }
  return {
    state,
    reason,
    automaticWait: ['cooldown', 'recovering', 'automatic_wait'].includes(state),
    actionRequired: ['manual_required', 'offline'].includes(state),
    stoppedAt: runtime.stoppedAt || null,
    nextAction,
    waitUntil: waitUntil > now ? waitUntil : null,
    dataStale,
  };
}

module.exports = { ACTIVE_EGRESS, WAIT_REASONS, healthProjection };
