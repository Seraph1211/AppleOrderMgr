/**
 * 判断当前请求是否允许在本地开发页面展示敏感字段明文。
 *
 * 该能力采用三重门禁：仅 development 环境、显式开启配置且当前用户为 admin。
 * 任一条件不满足时均保持默认脱敏，避免配置被误带到生产后扩大暴露范围。
 *
 * @param {Object} req - Express request
 * @returns {boolean} 是否允许返回页面所需的敏感字段明文
 */
function canDisplayLocalSensitiveFields(req) {
  return (
    process.env.NODE_ENV === 'development' &&
    process.env.ALLOW_LOCAL_SENSITIVE_DISPLAY === 'true' &&
    req?.user?.role === 'admin'
  );
}

module.exports = { canDisplayLocalSensitiveFields };
