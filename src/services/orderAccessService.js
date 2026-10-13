const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { recipientTagWhere, normalizeRecipientTag } = require('./recipientTagService');
const ApiError = require('../utils/ApiError');

/** 校验并规范化订单范围，不改写 TAG 原文。 */
function validateOrderAccess(value) {
  if (!value || !['all', 'tags'].includes(value.mode) || !Array.isArray(value.tags)) {
    throw ApiError.badRequest('orderAccess 必须包含 mode（all/tags）及 tags 数组');
  }
  if (
    value.tags.length > 500 ||
    value.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 500)
  ) {
    throw ApiError.badRequest('授权 TAG 最多 500 项，每项为 1-500 字符的非空字符串');
  }
  return { mode: value.mode, tags: value.mode === 'all' ? [] : [...new Set(value.tags)].sort() };
}

/** 返回服务端有效范围；缺失或异常配置默认没有订单访问范围。 */
function getOrderAccess(user) {
  if (user?.role === 'admin') return { mode: 'all', tags: [] };
  if (!user?.orderAccess) return { mode: 'tags', tags: [] };
  return validateOrderAccess(user.orderAccess);
}

/** 生成订单范围条件，与业务条件相交，不能被请求筛选覆盖。 */
function scopeOrderWhere(user, where = {}, alias = 'Order') {
  const access = getOrderAccess(user);
  return access.mode === 'all'
    ? where
    : { [Op.and]: [where, recipientTagWhere({ [Op.in]: access.tags }, alias)] };
}

/** 校验单个 TAG，不暴露范围外资源是否存在。 */
function assertTagAccess(user, tag) {
  const access = getOrderAccess(user);
  if (access.mode !== 'all' && (!normalizeRecipientTag(tag) || !access.tags.includes(tag))) {
    throw ApiError.notFound('订单或渠道不存在或不可访问');
  }
}

/** 在实际查询中验证完整 ID 集合；混合越权集合整体拒绝。 */
async function assertOrderIdsAccess(user, orderIds, options = {}) {
  try {
    const { Order } = require('../models');
    const ids = [...new Set(orderIds.map(Number))];
    const count = await Order.count({
      where: scopeOrderWhere(user, { id: { [Op.in]: ids } }),
      transaction: options.transaction,
    });
    if (count !== ids.length) throw ApiError.notFound('订单不存在或不可访问');
  } catch (error) {
    logger.warn('订单范围校验失败', { errorType: error.name });
    throw error;
  }
}

/** 原生 SQL 通过绑定数组使用同一授权范围，null 表示全部。 */
function getOrderTagBind(user) {
  const access = getOrderAccess(user);
  return access.mode === 'all' ? null : access.tags;
}

/** 拒绝通过基础资料修改扩大有限范围账号的订单访问。 */
function assertAllOrderAccess(user) {
  if (getOrderAccess(user).mode !== 'all')
    throw new ApiError(403, 'FORBIDDEN', '此操作改变订单 TAG 范围，需要全部订单范围');
}

/** 加载实时账号并校验订单范围，付款任务不额外要求 orders.read。 */
async function assertCurrentOrderAccess(userId, orderIds, options = {}) {
  try {
    const { User } = require('../models');
    const user = await User.findByPk(userId, { transaction: options.transaction });
    if (!user || user.status !== 'active') throw ApiError.notFound('订单不存在或不可访问');
    await assertOrderIdsAccess(user, orderIds, options);
    return user;
  } catch (error) {
    logger.warn('实时订单范围校验失败', { userId, errorType: error.name });
    throw error;
  }
}

module.exports = {
  assertAllOrderAccess,
  assertCurrentOrderAccess,
  validateOrderAccess,
  getOrderAccess,
  scopeOrderWhere,
  assertTagAccess,
  assertOrderIdsAccess,
  getOrderTagBind,
};
