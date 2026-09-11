const logger = require('../utils/logger');
const service = require('../services/paymentTagRuleService');

/**
 * 查询 TAG 规则。
 * @param {Object} _req 请求
 * @param {Object} res 响应
 * @returns {Promise<Object>} 响应
 */
async function list(_req, res) {
  try {
    return res.json({ success: true, data: await service.listRules() });
  } catch (error) {
    logger.error('TAG 分配操作失败', { errorCode: error.code || 'TAG_RULE_FAILED' });
    throw error;
  }
}
/**
 * 新建 TAG 规则。
 * @param {Object} req 请求
 * @param {Object} res 响应
 * @returns {Promise<Object>} 响应
 */
async function create(req, res) {
  try {
    return res
      .status(201)
      .json({ success: true, data: await service.saveRule(null, req.body, req.user.id) });
  } catch (error) {
    logger.error('TAG 分配操作失败', { errorCode: error.code || 'TAG_RULE_FAILED' });
    throw error;
  }
}
/**
 * 更新 TAG 规则。
 * @param {Object} req 请求
 * @param {Object} res 响应
 * @returns {Promise<Object>} 响应
 */
async function update(req, res) {
  try {
    return res.json({
      success: true,
      data: await service.saveRule(Number(req.params.id), req.body, req.user.id),
    });
  } catch (error) {
    logger.error('TAG 分配操作失败', { errorCode: error.code || 'TAG_RULE_FAILED' });
    throw error;
  }
}
/**
 * 删除 TAG 规则。
 * @param {Object} req 请求
 * @param {Object} res 响应
 * @returns {Promise<Object>} 响应
 */
async function remove(req, res) {
  try {
    return res.json({
      success: true,
      data: await service.saveRule(Number(req.params.id), req.body, req.user.id, true),
    });
  } catch (error) {
    logger.error('TAG 分配操作失败', { errorCode: error.code || 'TAG_RULE_FAILED' });
    throw error;
  }
}
module.exports = { list, create, update, remove };
