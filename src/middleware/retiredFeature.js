/**
 * 为过渡期旧客户端返回明确的功能退休响应。
 * @param {string} featureName - 已退休功能名称
 * @returns {Function} Express 处理器
 */
function retiredFeature(featureName) {
  return (_req, res) =>
    res.status(410).json({
      success: false,
      error: {
        code: 'FEATURE_RETIRED',
        message: `${featureName}已下线，系统不会创建任务或访问官网订单链接`,
      },
    });
}

module.exports = retiredFeature;
