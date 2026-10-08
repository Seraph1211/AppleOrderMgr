const LIMITS = Object.freeze({
  globalRps: 5,
  taskRps: 1,
  hour: 60,
  day: 300,
  leaseMs: 45000,
  cooldownMs: 60000,
  pauseMs: 600000,
  riskWindowMs: 300000,
});

/** 仅接受服务端秒数或 HTTP 日期；更长等待不截短。 */
function retryAfterMs(value, now) {
  if (typeof value !== 'string' || value.length > 100) return 0;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, 2147483647000);
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - now) : 0;
}

/** 预占请求许可；等待或拒绝时不写入虚构的网络尝试。 */
function reserveBudget(original, now, attemptId, jitterMs = 0, egress = '') {
  const state = { ...original };
  if (state.pausedReason) return { blocked: state.pausedReason };
  if (state.pausedEgress?.[egress]) return { blocked: state.pausedEgress[egress] };
  if (state.requiredAlternateEgress === egress) return { blocked: 'ALTERNATE_EGRESS_REQUIRED' };
  if ((state.cooldownUntil || 0) > now)
    return { blocked: 'TARGET_COOLDOWN', until: state.cooldownUntil };
  const waitUntil = Math.max(
    state.nextAt || 0,
    state.leaseUntil || 0,
    ...Object.values(state.requestLeases || {}).map(lease => lease.until || 0)
  );
  if (waitUntil > now) return { waitMs: waitUntil - now };
  const hour = Math.floor(now / 3600000);
  const day = Math.floor(now / 86400000);
  if (state.hour !== hour) Object.assign(state, { hour, hourCount: 0 });
  if (state.day !== day) Object.assign(state, { day, dayCount: 0 });
  const hourLimit =
    state.preflightBudget?.expiresAt > now && state.preflightBudget?.hour === 120
      ? 120
      : LIMITS.hour;
  if ((state.hourCount || 0) >= hourLimit || (state.dayCount || 0) >= LIMITS.day)
    return { blocked: 'REQUEST_BUDGET_EXHAUSTED' };
  Object.assign(state, {
    hourCount: (state.hourCount || 0) + 1,
    dayCount: (state.dayCount || 0) + 1,
    nextAt:
      now +
      Math.max(1000 / LIMITS.globalRps, 1000 / LIMITS.taskRps) +
      Math.min(150, Math.max(0, jitterMs)),
    leaseUntil: now + LIMITS.leaseMs,
    leaseId: attemptId,
  });
  return { state };
}

/** 响应与链路故障分类；不传播可能包含代理凭据的原始错误。 */
function classifyResponse(status, contentType = '', errorCode = '') {
  if (status === 407) return 'PROXY_AUTH_FAILED';
  if (status === 429) return 'TARGET_RATE_LIMITED';
  if (status === 541) return 'TARGET_REJECTED';
  if ([401, 403].includes(status)) return 'TARGET_CHALLENGE';
  if (status >= 300 && status < 400) return 'REDIRECT_BLOCKED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  if (status === 200) return contentType.includes('json') ? 'JSON_RECEIVED' : 'DOCUMENT_RECEIVED';
  if (status) return 'HTTP_ERROR';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(errorCode)) return 'PROXY_CONNECT_FAILED';
  if (['ETIMEDOUT', 'ECONNABORTED'].includes(errorCode)) return 'REQUEST_TIMEOUT';
  return 'TRANSPORT_UNKNOWN';
}

/** 持久化风险保护状态；换出口不清空冷却、计数或预算。 */
function settleBudget(original, result, now) {
  const state = { ...original };
  if (state.leaseId === result.id) Object.assign(state, { leaseId: null, leaseUntil: 0 });
  const risk = ['TARGET_RATE_LIMITED', 'TARGET_REJECTED'].includes(result.outcome);
  state.recent = [
    ...(state.recent || []).filter(x => x.at >= now - LIMITS.riskWindowMs),
    { at: now, risk, egress: result.egress },
  ].slice(-300);
  state.consecutiveRisks = risk ? (state.consecutiveRisks || 0) + 1 : 0;
  if (risk) {
    const riskRows = state.recent.filter(x => x.risk);
    const threshold =
      state.consecutiveRisks >= 3 ||
      (state.recent.length >= 20 && riskRows.length / state.recent.length >= 0.2) ||
      new Set(riskRows.map(x => x.egress)).size >= 2;
    state.cooldownUntil = Math.max(
      state.cooldownUntil || 0,
      now + Math.max(result.retryMs || 0, threshold ? LIMITS.pauseMs : LIMITS.cooldownMs)
    );
    if (result.outcome === 'TARGET_REJECTED') {
      state.isolatedEgress = { ...state.isolatedEgress, [result.egress]: state.cooldownUntil };
      state.requiredAlternateEgress = result.egress;
    }
  } else if (result.retryMs) {
    state.cooldownUntil = Math.max(state.cooldownUntil || 0, now + result.retryMs);
  }
  if (['PROXY_AUTH_FAILED', 'PROXY_CONNECT_REJECTED'].includes(result.outcome))
    state.pausedEgress = { ...state.pausedEgress, [result.egress]: result.outcome };
  if (['TARGET_CHALLENGE', 'REDIRECT_BLOCKED', 'INVALID_RESPONSE'].includes(result.outcome))
    state.pausedReason = result.outcome;
  return state;
}

/** 精确解析指定 SKU；未知／缺失保持 unknown，冲突拒绝，不据此猜测无货。 */
function parsePickupResponse(payload, skus) {
  if (!Array.isArray(skus) || !skus.length || skus.some(s => !/^[A-Z0-9]{5,12}CH\/A$/.test(s)))
    throw new Error('INVALID_SKU');
  const stores = payload?.body?.stores;
  if (!Array.isArray(stores) || !stores.length) throw new Error('INVALID_STORES');
  const seen = new Map();
  for (const store of stores) {
    if (!/^R\d{3,5}$/.test(store.storeNumber) || typeof store.storeName !== 'string')
      throw new Error('INVALID_STORE');
    for (const sku of skus) {
      const item = store.partsAvailability?.[sku];
      const title = item?.messageTypes?.regular?.storePickupProductTitle;
      const valid = item && typeof title === 'string' && /^iPhone\b/i.test(title.trim());
      const raw = valid ? item.pickupDisplay : '';
      const status =
        raw === 'available' ? 'in_stock' : raw === 'unavailable' ? 'out_of_stock' : 'unknown';
      const row = {
        sku,
        storeCode: store.storeNumber,
        storeName: store.storeName,
        city: typeof store.city === 'string' ? store.city : '',
        status,
        title: valid ? title.replace(/\s+/g, ' ').slice(0, 200) : '',
        quote:
          typeof item?.pickupSearchQuote === 'string' ? item.pickupSearchQuote.slice(0, 500) : '',
        reason: valid
          ? status === 'unknown'
            ? 'UNKNOWN_PICKUP_STATE'
            : null
          : 'SKU_OR_TITLE_MISSING',
      };
      const key = `${sku}:${row.storeCode}`;
      if (seen.has(key) && JSON.stringify(seen.get(key)) !== JSON.stringify(row))
        throw new Error('CONFLICTING_DUPLICATE_STORE');
      seen.set(key, row);
    }
  }
  return [...seen.values()];
}

module.exports = {
  LIMITS,
  retryAfterMs,
  reserveBudget,
  classifyResponse,
  settleBudget,
  parsePickupResponse,
};
