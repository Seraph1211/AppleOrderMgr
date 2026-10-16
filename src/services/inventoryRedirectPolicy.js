const { createHash } = require('crypto');

const INVENTORY_ORIGIN = 'https://www.apple.com.cn';
const INVENTORY_PATH = '/shop/retail/pickup-message';
const MAX_LOCATION_LENGTH = 8192;
const MAX_SPACE_CODE = 32;
const DELETE_CODE = 127;
const CHALLENGE_SIGNAL =
  /(?:^|[^a-z0-9])(?:captcha|challenge|verify|verification|login|signin|auth|authentication|authorize|authorization|access[-_]?denied|blocked|bot[-_]?check)(?:$|[^a-z0-9])/i;

/** 包含控制字符或空白时拒绝解析，避免 URL 自动规整隐藏异常。 */
function hasControlOrSpace(value) {
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code <= MAX_SPACE_CODE || code === DELETE_CODE;
  });
}

/** 返回固定分类，不携带 Location、路径、参数或响应正文。 */
function decision(summary, reason, retry = false) {
  return {
    outcome: retry ? 'TARGET_REJECTED' : 'REDIRECT_BLOCKED',
    summary: {
      ...summary,
      redirectDecision: retry ? 'RETRY_ORIGINAL' : 'MANUAL_REVIEW',
      redirectReason: reason,
      ...(retry ? { targetRejectReason: 'UNFOLLOWED_REDIRECT' } : {}),
    },
  };
}

/** 对未跟随的重定向分级；只允许有限重试原库存 URL，绝不授权访问 Location。
 * @param {Object} options 请求用途、响应状态、CONNECT 状态与 Location
 * @returns {Object} 既有结果枚举及脱敏分类
 */
function classifyInventoryRedirect({ purpose, status, tunnelStatus, location }) {
  const summary = { redirectLocationClass: 'MISSING' };
  const missing = location == null || location === '';
  if (!missing && typeof location === 'string')
    summary.redirectLocationHash = createHash('sha256').update(location).digest('hex');
  if (purpose !== 'inventory') return decision(summary, 'OUTSIDE_INVENTORY');
  if (status !== 307) return decision(summary, 'UNSUPPORTED_REDIRECT');
  if (tunnelStatus !== 200) return decision(summary, 'UNPROVEN_TUNNEL');
  if (missing) return decision(summary, 'UNFOLLOWED_REDIRECT', true);
  summary.redirectLocationClass = 'INVALID';
  if (
    typeof location !== 'string' ||
    location.length > MAX_LOCATION_LENGTH ||
    hasControlOrSpace(location)
  )
    return decision(summary, 'INVALID_LOCATION');
  let url;
  let decoded;
  try {
    // URL 会容忍部分非法百分号编码，单独解码以保持拒绝边界。
    decoded = decodeURIComponent(location);
    if (hasControlOrSpace(decoded)) return decision(summary, 'INVALID_LOCATION');
    url = new URL(location, `${INVENTORY_ORIGIN}${INVENTORY_PATH}`);
  } catch (_error) {
    return decision(summary, 'INVALID_LOCATION');
  }
  summary.redirectProtocolClass =
    url.protocol === 'https:' ? 'HTTPS' : url.protocol === 'http:' ? 'HTTP' : 'OTHER';
  summary.redirectHostClass = url.hostname === 'www.apple.com.cn' ? 'APPLE_CN' : 'OTHER';
  summary.redirectPathClass = url.pathname === INVENTORY_PATH ? 'INVENTORY_ENDPOINT' : 'OTHER';
  summary.redirectLocationClass = 'UNSAFE';
  if (url.protocol !== 'https:') return decision(summary, 'UNSAFE_PROTOCOL');
  if (url.username || url.password) return decision(summary, 'CREDENTIALS_PRESENT');
  if (url.port) return decision(summary, 'UNSAFE_PORT');
  if (url.hash || location.includes('#')) return decision(summary, 'FRAGMENT_PRESENT');
  if (url.origin !== INVENTORY_ORIGIN) {
    summary.redirectLocationClass = 'EXTERNAL';
    return decision(summary, 'EXTERNAL_ORIGIN');
  }
  if (CHALLENGE_SIGNAL.test(decoded)) {
    summary.redirectPathClass = 'CHALLENGE';
    return decision(summary, 'CHALLENGE_SIGNAL');
  }
  summary.redirectLocationClass = 'SAME_ORIGIN';
  return decision(summary, 'UNFOLLOWED_REDIRECT', true);
}

module.exports = { classifyInventoryRedirect };
