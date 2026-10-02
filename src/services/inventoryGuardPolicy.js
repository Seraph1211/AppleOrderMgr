const { LIMITS } = require('./inventoryValidationPolicy');

/** 正式采集的持久化请求许可，预占最大响应字节防并发超额。 @param {Object} original 状态 @param {number} now 时间 @param {string} id 尝试编号 @param {number} jitter 抖动 @param {string} egress 出口 @param {string} purpose 用途 @param {Object} config 配置 @returns {Object} 许可 */
function reserveProduction(original, now, id, jitter, egress, purpose, config) {
  const state = { ...original, production: true };
  if (!config.enabled) return { blocked: 'MONITOR_DISABLED' };
  if (state.pausedReason) return { blocked: state.pausedReason };
  if (state.pausedEgress?.[egress]) return { blocked: state.pausedEgress[egress] };
  if (state.requiredAlternateEgress === egress) return { blocked: 'ALTERNATE_EGRESS_REQUIRED' };
  if (state.cooldownUntil > now) return { blocked: 'TARGET_COOLDOWN', until: state.cooldownUntil };
  if (state.recovering && !['inventory', 'provider'].includes(purpose))
    return { blocked: 'RECOVERY_PROBE_REQUIRED' };
  const wait = Math.max(state.nextAt || 0, state.leaseUntil || 0, state.probeAt || 0);
  if (wait > now) return { waitMs: wait - now };
  const hour = Math.floor(now / 3600000);
  const day = Math.floor(now / 86400000);
  if (state.hour !== hour) Object.assign(state, { hour, hourCount: 0 });
  if (state.day !== day) Object.assign(state, { day, dayCount: 0, byteCount: 0, proxyCount: 0 });
  const reserveBytes = purpose === 'provider' ? 100000 : 5242880;
  if (
    (state.hourCount || 0) >= config.hourlyRequests ||
    (state.dayCount || 0) >= config.dailyRequests ||
    (state.byteCount || 0) + reserveBytes > config.dailyBytes ||
    (purpose === 'provider' && (state.proxyCount || 0) >= config.dailyProxyExtractions)
  )
    return { blocked: 'REQUEST_BUDGET_EXHAUSTED' };
  Object.assign(state, {
    hourCount: (state.hourCount || 0) + 1,
    dayCount: (state.dayCount || 0) + 1,
    byteCount: (state.byteCount || 0) + reserveBytes,
    proxyCount: (state.proxyCount || 0) + (purpose === 'provider' ? 1 : 0),
    leaseId: id,
    leaseUntil: now + LIMITS.leaseMs,
    leaseBytes: reserveBytes,
    leaseDay: day,
    nextAt: now + 1000 + Math.min(150, Math.max(0, jitter)),
  });
  return { state };
}
/** 正式保护状态机，供应商请求不清空 Apple 风险历史。 @param {Object} original 状态 @param {Object} result 结果 @param {number} now 时间 @returns {Object} 状态 */
function settleProduction(original, result, now) {
  const state = { ...original };
  if (state.leaseId === result.id) {
    if (state.leaseDay === Math.floor(now / 86400000))
      state.byteCount = Math.max(
        0,
        (state.byteCount || 0) - (state.leaseBytes || 0) + Math.max(0, result.bytes || 0)
      );
    Object.assign(state, { leaseId: null, leaseUntil: 0, leaseBytes: 0 });
  }
  if (result.purpose === 'provider' || result.egress?.includes('provider')) {
    if (result.outcome !== 'PROVIDER_ENDPOINT_RECEIVED') {
      state.pausedEgress = { ...state.pausedEgress, [result.egress]: 'PROVIDER_FAILED' };
      state.pausedReason = 'PROVIDER_FAILED';
    }
    return state;
  }
  if (result.purpose === 'inventory') {
    const transient = [
      'UPSTREAM_ERROR',
      'PROXY_TUNNEL_UNAVAILABLE',
      'REQUEST_TIMEOUT',
      'TRANSPORT_UNKNOWN',
      'RESPONSE_READ_FAILED',
    ].includes(result.outcome);
    state.consecutiveFailures = transient ? (state.consecutiveFailures || 0) + 1 : 0;
    if (state.consecutiveFailures >= 5) {
      state.cooldownUntil = Math.max(state.cooldownUntil || 0, now + 600000);
      state.recovering = true;
      state.recoverySuccesses = 0;
    }
  }
  const risk = ['TARGET_RATE_LIMITED', 'TARGET_REJECTED'].includes(result.outcome);
  state.recent = [
    ...(state.recent || []).filter(r => r.at >= now - 300000),
    { at: now, risk, egress: result.egress },
  ].slice(-300);
  state.consecutiveRisks = risk ? (state.consecutiveRisks || 0) + 1 : 0;
  if (
    ['TARGET_CHALLENGE', 'REDIRECT_BLOCKED', 'INVALID_RESPONSE', 'CATALOG_MISMATCH'].includes(
      result.outcome
    )
  )
    state.pausedReason = result.outcome;
  if (
    ['PROXY_AUTH_FAILED', 'PROXY_CONNECT_REJECTED', 'PROXY_CONNECT_FAILED'].includes(result.outcome)
  )
    state.pausedEgress = { ...state.pausedEgress, [result.egress]: result.outcome };
  if (risk) {
    const risks = state.recent.filter(r => r.risk);
    const threshold =
      state.consecutiveRisks >= 3 ||
      (state.recent.length >= 20 && risks.length / state.recent.length >= 0.2) ||
      new Set(risks.map(r => r.egress)).size >= 2;
    state.cooldownUntil = Math.max(
      state.cooldownUntil || 0,
      now + Math.max(result.retryMs || 0, threshold ? 600000 : 60000)
    );
    state.lastRiskAt = now;
    state.recovering = true;
    state.recoverySuccesses = 0;
    if (result.outcome === 'TARGET_REJECTED') state.requiredAlternateEgress = result.egress;
  } else if (result.retryMs)
    state.cooldownUntil = Math.max(state.cooldownUntil || 0, now + result.retryMs);
  // 只有实际库存结构可解除恢复；目录和代理成功均无此权限。
  if (original.recovering && result.purpose === 'inventory') {
    if (result.outcome === 'INVENTORY_VALID') {
      state.recoverySuccesses = (state.recoverySuccesses || 0) + 1;
      state.probeAt = now + 5000;
      if (state.recoverySuccesses >= 3) {
        state.recovering = false;
        state.recoveryFailures = 0;
        state.requiredAlternateEgress = null;
        state.probeAt = 0;
      }
    } else {
      state.recoveryFailures = (state.recoveryFailures || 0) + 1;
      state.recoverySuccesses = 0;
      state.cooldownUntil = Math.max(
        state.cooldownUntil || 0,
        now + (state.recoveryFailures === 1 ? 1200000 : 2400000)
      );
      if (state.recoveryFailures >= 3) state.pausedReason = 'RECOVERY_EXHAUSTED';
    }
  }
  return state;
}
module.exports = { reserveProduction, settleProduction };
