const { randomBytes, createHash } = require('crypto');

const PROVIDER_LABEL = 'iproyal-main';
const PROVIDER_FAILURES = new Set(['PROXY_TUNNEL_UNAVAILABLE', 'PROXY_SESSION_EXPIRED']);
const MAX_PROVIDER_FAILURES = 3;

/** 校验唯一授权的 IPRoyal 中国住宅入口及基础凭据。 @param {Object} proxy 代理 @param {Object} value 配置 @returns {Object} 参数 */
function validateTunnel(proxy, value) {
  const url = new URL(proxy.url);
  const expiresAt = value?.expiresAt == null ? null : Date.parse(value.expiresAt);
  const password = decodeURIComponent(url.password);
  if (
    proxy.label !== PROVIDER_LABEL ||
    value?.provider !== 'iproyal' ||
    Object.keys(value).some(key => !['provider', 'stickySeconds', 'expiresAt'].includes(key)) ||
    url.protocol !== 'http:' ||
    url.hostname !== 'geo.iproyal.com' ||
    url.port !== '12321' ||
    !url.username ||
    !password ||
    /[\r\n]/.test(decodeURIComponent(url.username) + password) ||
    /_(?:country|session|lifetime|streaming|killswitch|forcerandom)-/i.test(password) ||
    value.stickySeconds !== 600 ||
    (value.expiresAt != null &&
      (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value.expiresAt) || !Number.isFinite(expiresAt)))
  )
    throw new Error('INVALID_TUNNEL_CONFIG');
  return { provider: 'iproyal', stickySeconds: 600, expiresAt };
}

/** 生成八位随机会话，固定中国、高端池及 killswitch；实际出口仍须验证。 @param {string} original 基础认证 URL @returns {string} 新认证 URL */
function rotateTunnel(original) {
  const url = new URL(original);
  const session = randomBytes(4).toString('hex');
  url.password = encodeURIComponent(
    `${decodeURIComponent(url.password)}_country-cn_session-${session}_lifetime-10m_streaming-1_killswitch-1`
  );
  return url.href;
}

/** 配置摘要用于跨进程复用，禁止输出原认证信息。 @param {Object} proxy 代理 @returns {string} 摘要 */
function tunnelFingerprint(proxy) {
  return createHash('sha256')
    .update(JSON.stringify([proxy.label, proxy.url, proxy.tunnel]))
    .digest('hex');
}

/** 记录有限供应商失败，不修改 Apple 风控或恢复次数。 @param {Object} original 状态 @param {number} now 时间 @param {string} egress 出口 @returns {Object} 状态 */
function settleProviderFailure(original, now, egress) {
  const state = { ...original };
  const token = state.tunnel?.label === egress ? state.tunnel.token : null;
  if (token && state.providerFailedToken === token) return state;
  if (token) state.providerFailedToken = token;
  state.providerFailures = (state.providerFailures || 0) + 1;
  state.providerCooldownUntil = now + (state.providerFailures === 1 ? 60000 : 120000);
  if (state.tunnel?.label === egress)
    state.tunnel = { ...state.tunnel, expiresAt: 0, verified: false, probeUntil: 0 };
  if (state.providerFailures >= MAX_PROVIDER_FAILURES)
    state.pausedEgress = { ...state.pausedEgress, [egress]: 'PROXY_RECOVERY_EXHAUSTED' };
  return state;
}

module.exports = {
  PROVIDER_LABEL,
  PROVIDER_FAILURES,
  validateTunnel,
  rotateTunnel,
  tunnelFingerprint,
  settleProviderFailure,
};
