/** 每个账号最多保留三台设备会话。 */
const MAX_ACCOUNT_SESSIONS = 3;

/**
 * 返回未到期会话，按登录时间从早到晚排序。
 * @param {Object} user - 用户
 * @returns {Object[]} 有效会话
 */
function getActiveSessions(user) {
  const now = Date.now();
  return (user.activeSessions || [])
    .filter(session => session.id && new Date(session.expiresAt).getTime() > now)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * 生成确认时绑定的会话集合标识。
 * @param {Object[]} sessions - 有效会话
 * @returns {string} 按时间排序的会话 ID
 */
function sessionFingerprint(sessions) {
  return sessions.map(session => session.id).join(',');
}

module.exports = { MAX_ACCOUNT_SESSIONS, getActiveSessions, sessionFingerprint };
