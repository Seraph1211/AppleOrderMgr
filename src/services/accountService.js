const { Op } = require('sequelize');
const { User, PaymentTask, PaymentStaffSetting, sequelize } = require('../models');
const { PAYMENT_ASSIGNMENT_LOCK_ID } = require('./permissionService');
const { ACTIVE_PAYMENT_TASK_STATUSES } = require('./paymentTaskService');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * 软删除已交接账号，保留历史记录和用户名。
 * @param {number} userId - 目标账号
 * @param {number|null} actorUserId - 操作者；授权维护脚本可为空
 * @returns {Promise<Object>} 删除账号的身份
 */
async function softDeleteUser(userId, actorUserId) {
  try {
    if (!Number.isInteger(userId) || userId <= 0) throw ApiError.badRequest('账号 ID 无效');
    if (userId === actorUserId) throw ApiError.badRequest('不能删除当前登录的用户');
    return await sequelize.transaction(async transaction => {
      try {
        await sequelize.query('SELECT pg_advisory_xact_lock(:lockId)', {
          replacements: { lockId: PAYMENT_ASSIGNMENT_LOCK_ID },
          transaction,
        });
        const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!user) throw ApiError.notFound('用户不存在或已删除');
        if (
          user.role === 'admin' &&
          !(await User.count({
            where: { role: 'admin', status: 'active', id: { [Op.ne]: user.id } },
            transaction,
          }))
        )
          throw ApiError.badRequest('不能删除最后一个有效管理员账号');
        const taskCount = await PaymentTask.count({
          where: {
            assigneeUserId: user.id,
            processingStatus: { [Op.in]: ACTIVE_PAYMENT_TASK_STATUSES },
          },
          transaction,
        });
        if (taskCount)
          throw ApiError.conflict(
            `该账号还有 ${taskCount} 个未交接任务，请先转派或完成后再删除`,
            { taskCount },
            'USER_HAS_ACTIVE_TASKS'
          );
        await user.update(
          {
            status: 'locked',
            lockedUntil: null,
            activeSessions: [],
            activeSessionId: null,
            activeSessionExpiresAt: null,
          },
          { transaction }
        );
        await PaymentStaffSetting.update(
          {
            autoAssignEnabled: false,
            version: sequelize.literal('version + 1'),
            updatedBy: actorUserId,
          },
          { where: { userId }, transaction }
        );
        await user.destroy({ transaction });
        return { id: user.id, username: user.username };
      } catch (error) {
        logger.error('账号软删除事务失败', { userId, error: error.message });
        throw error;
      }
    });
  } catch (error) {
    logger.error('账号软删除失败', { userId, error: error.message });
    throw error;
  }
}

module.exports = { softDeleteUser };
