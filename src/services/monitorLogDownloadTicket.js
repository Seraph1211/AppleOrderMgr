const { generateScopedToken } = require('../utils/jwtUtils');

const COOKIE_NAME = 'aos_monitor_log_export';
const COOKIE_PATH = '/api/server-monitor/logs/export';
const PURPOSE = 'monitor-log-export';
const EXPIRES_IN_SECONDS = 60;

/** 返回下载凭证 Cookie 的安全配置。 @returns {Object} Express Cookie 配置 */
function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: EXPIRES_IN_SECONDS * 1000,
  };
}

/** 从 Cookie 请求头读取指定值。 @param {Object} req Express 请求 @returns {string|null} */
function readCookie(req) {
  const source = req.headers.cookie;
  if (!source) return null;
  for (const pair of source.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== COOKIE_NAME) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch (_error) {
      return null;
    }
  }
  return null;
}

/** 判断请求是否为浏览器原生日志下载入口。 @param {Object} req Express 请求 @returns {boolean} */
function isDownloadRequest(req) {
  return req.method === 'GET' && String(req.originalUrl || '').split('?')[0] === COOKIE_PATH;
}

/** 签发仅限一个实例、一个日期的短期下载凭证。 @param {Object} user 当前用户 @param {Object} query 标准日志范围 @returns {string} */
function issue(user, query) {
  return generateScopedToken(
    {
      userId: user.id,
      username: user.username,
      role: user.role,
      sessionId: user.sessionId,
      purpose: PURPOSE,
      scope: {
        deviceId: query.deviceId,
        localId: query.localId,
        date: query.date,
      },
    },
    EXPIRES_IN_SECONDS
  );
}

/** 验证短期凭证是否只用于当前导出范围。 @param {Object} auth 认证上下文 @param {Object} input 查询参数 @returns {boolean} */
function matches(auth, input) {
  if (auth?.source !== 'download-cookie' || auth?.purpose !== PURPOSE) return false;
  const keys = Object.keys(input || {}).sort();
  if (keys.join(',') !== 'date,deviceId,localId') return false;
  return ['deviceId', 'localId', 'date'].every(key => auth.scope?.[key] === input[key]);
}

module.exports = {
  COOKIE_NAME,
  COOKIE_PATH,
  PURPOSE,
  EXPIRES_IN_SECONDS,
  cookieOptions,
  readCookie,
  isDownloadRequest,
  issue,
  matches,
};
