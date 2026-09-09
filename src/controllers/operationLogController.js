const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { OperationLog } = require('../models');
const { accountId } = require('../utils/accountIdentity');
const { parsePositiveInt, paginatedResponse } = require('../utils/apiResponse');
const ApiError = require('../utils/ApiError');

/**
 * 分页查看账号操作记录，身份来自操作时的快照。
 * @param {Object} req - 请求
 * @param {Object} res - 响应
 */
async function listOperationLogs(req, res) {
  try {
    const page = parsePositiveInt(req.query.page, { defaultValue: 1, min: 1, max: 100000 });
    const limit = parsePositiveInt(req.query.limit, { defaultValue: 20, min: 1, max: 100 });
    const where = {};
    if (req.query.keyword) {
      const term = String(req.query.keyword).trim().slice(0, 100);
      where[Op.or] = [
        { username: { [Op.iLike]: `%${term}%` } },
        { nickname: { [Op.iLike]: `%${term}%` } },
      ];
      if (/^U\d+$/i.test(term) && Number(term.slice(1)) <= 2147483647)
        where[Op.or].push({ actorUserId: Number(term.slice(1)) });
    }
    if (req.query.action)
      where.action = { [Op.iLike]: `%${String(req.query.action).slice(0, 100)}%` };
    if (req.query.result) {
      if (!['success', 'failed', 'cancelled'].includes(req.query.result))
        throw ApiError.badRequest('操作结果无效');
      where.result = req.query.result;
    }
    if (req.query.dateFrom || req.query.dateTo) {
      where.createdAt = {};
      for (const [key, op] of [
        ['dateFrom', Op.gte],
        ['dateTo', Op.lte],
      ]) {
        if (!req.query[key]) continue;
        const date = new Date(req.query[key]);
        if (Number.isNaN(date.getTime())) throw ApiError.badRequest('请输入有效的筛选时间');
        where.createdAt[op] = date;
      }
      if (
        req.query.dateFrom &&
        req.query.dateTo &&
        new Date(req.query.dateFrom) > new Date(req.query.dateTo)
      )
        throw ApiError.badRequest('开始时间不能晚于结束时间');
    }
    const { count, rows } = await OperationLog.findAndCountAll({
      where,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
      offset: (page - 1) * limit,
    });
    return res.json(
      paginatedResponse(
        rows.map(row => ({
          ...row.toJSON(),
          accountId: row.actorUserId ? accountId(row.actorUserId) : null,
          resultLabel: { success: '成功', failed: '失败／被拒绝', cancelled: '等待确认登录' }[
            row.result
          ],
        })),
        count,
        page,
        limit,
        'logs'
      )
    );
  } catch (error) {
    logger.error('查询操作记录失败', { error: error.message });
    throw error;
  }
}

module.exports = { listOperationLogs };
