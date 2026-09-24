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

module.exports = { getActiveSessions };
