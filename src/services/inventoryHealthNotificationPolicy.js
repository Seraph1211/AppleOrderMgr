const OBSERVATION_MS = 120000;
const REPEAT_MS = 1800000;
const VERSION = 1;
const URGENT_REASONS = new Set([
  'NO_HEALTHY_PROXY',
  'PROXY_AUTH_FAILED',
  'PROXY_CONNECT_REJECTED',
  'REQUEST_BUDGET_EXHAUSTED',
  'PROVIDER_FAILED',
]);

/** 从事务内的运行状态投影通知分类，不改变采集保护状态。 */
function healthObservation(runtime, guard = {}, now) {
  if (guard.pausedReason)
    return {
      key: `manual:${guard.pausedReason}`,
      urgent: true,
      label: '需要人工处理',
      reason: guard.pausedReason,
    };
  if (guard.cooldownUntil > now)
    return {
      key: 'cooldown',
      urgent: true,
      label: '保护冷却中',
      reason: runtime.lastError || '采集保护已触发',
      cooldownUntil: guard.cooldownUntil,
    };
  if (guard.recovering)
    return { key: 'recovering', urgent: false, label: '正在恢复检查', reason: '等待恢复检查完成' };
  if (runtime.lastError)
    return {
      key: URGENT_REASONS.has(runtime.lastError) ? `urgent:${runtime.lastError}` : 'degraded',
      urgent: URGENT_REASONS.has(runtime.lastError),
      label: '查询持续异常',
      reason: runtime.lastError,
    };
  return { key: 'normal', urgent: false, label: '已稳定恢复', reason: '查询已连续稳定 2 分钟' };
}

/** 持久化观察窗口；旧版本和目标切换从当前状态重新观察。 */
function observeHealth(previous, observation, settings, now) {
  const enabled =
    settings.config.enabled && settings.config.notificationsEnabled && settings.webhookCipher;
  const state =
    enabled && previous?.version === VERSION && previous.destinationId === settings.destinationId
      ? { ...previous, lastAttempts: { ...previous.lastAttempts } }
      : {
        version: VERSION,
        destinationId: settings.destinationId,
        announcedKey: null,
        lastAttempts: {},
      };
  if (!enabled || state.observedKey !== observation.key) {
    state.observedKey = observation.key;
    state.since = now;
  }
  const stable = observation.urgent || now - state.since >= OBSERVATION_MS;
  const needed =
    observation.key === 'normal'
      ? Boolean(state.announcedKey)
      : state.announcedKey !== observation.key;
  return { state, desiredKey: enabled && stable && needed ? observation.key : null };
}

/** 同类故障的发送尝试在 30 分钟内合并，恢复提醒只跟随已发故障。 */
function canQueueHealth(state, key, now) {
  return state.lastAttempts[key] === undefined || now - state.lastAttempts[key] >= REPEAT_MS;
}

/** 成功或不确定送达才建立恢复关联；明确失败不会产生孤立恢复。 */
function settleHealth(state, delivery) {
  if (
    !state ||
    delivery.healthVersion !== VERSION ||
    delivery.destinationId !== state.destinationId ||
    !['accepted', 'unknown'].includes(delivery.status)
  )
    return state;
  const next = {
    ...state,
    lastAttempts: { ...state.lastAttempts },
    announcedKey: delivery.healthKey === 'normal' ? null : delivery.healthKey,
  };
  if (delivery.healthKey !== 'normal') delete next.lastAttempts.normal;
  return next;
}
module.exports = {
  VERSION,
  OBSERVATION_MS,
  REPEAT_MS,
  healthObservation,
  observeHealth,
  canQueueHealth,
  settleHealth,
};
