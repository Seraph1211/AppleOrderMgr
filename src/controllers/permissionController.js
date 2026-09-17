const logger = require('../utils/logger');
const permissionService = require('../services/permissionService');

/**
 * 返回版本化权限目录。
 * @param {Object} _req - Express 请求
 * @param {Object} res - Express 响应
 * @returns {Object} Express 响应
 */
function getCatalog(_req, res) {
  return res.json({
    success: true,
    data: { version: 1, permissions: permissionService.getPermissionCatalog() },
  });
}

/**
 * 查询指定用户权限。
 * @param {Object} req - Express 请求
 * @param {Object} res - Express 响应
 * @returns {Promise<Object>} Express 响应
 */
async function getUserPermissions(req, res) {
  const result = await permissionService.getUserPermissions(Number(req.params.id));
  return res.json({ success: true, data: result });
}

/**
 * 完整替换指定普通用户权限集合。
 * @param {Object} req - Express 请求
 * @param {Object} res - Express 响应
 * @returns {Promise<Object>} Express 响应
 */
async function replaceUserPermissions(req, res) {
  const result = await permissionService.replaceUserPermissions(
    Number(req.params.id),
    {
      permissions: req.body.permissions,
      orderAccess: req.body.orderAccess,
      expectedVersion: req.body.expectedVersion,
      reason: req.body.reason,
      idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey,
    },
    req.user.id
  );
  return res.json({ success: true, data: result, message: '权限配置已更新' });
}

/** 管理员获取订单自身 TAG 候选。 */
async function getOrderTagOptions(_req, res) {
  try {
    const { Order } = require('../models');
    const { Op } = require('sequelize');
    const rows = await Order.findAll({
      attributes: ['tag'],
      where: { tag: { [Op.ne]: null } },
      group: ['tag'],
      order: [['tag', 'ASC']],
      raw: true,
    });
    return res.json({
      success: true,
      data: { tags: rows.map(row => row.tag).filter(tag => tag.trim()) },
    });
  } catch (error) {
    logger.warn('读取授权 TAG 候选失败', { errorType: error.name });
    throw error;
  }
}

module.exports = {
  getOrderTagOptions,
  getCatalog,
  getUserPermissions,
  replaceUserPermissions,
};
