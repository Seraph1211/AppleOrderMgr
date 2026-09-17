const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { sequelize, Recipient, AppleId } = require('../models');
const ApiError = require('../utils/ApiError');

/** 同一事务内串行化基础档案变更，避免导入、手工换绑及分配互相覆盖。 */
async function lockProfiles(transaction, actorId = null, initial = false) {
  try {
    await sequelize.query('SELECT pg_advisory_xact_lock(17092026)', { transaction });
    await sequelize.query(
      "SELECT set_config('app.actor_id', :actor, true), set_config('app.binding_initial', :initial, true)",
      {
        replacements: { actor: actorId ? String(actorId) : '', initial: String(initial) },
        transaction,
      }
    );
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}

/** 事务内换绑；不抢占、不改状态，历史由数据库触发器记录。 */
async function bindRecipient(recipient, appleIdRef, transaction, expectedAppleIdRef) {
  try {
    if (expectedAppleIdRef !== undefined && (recipient.appleIdRef || null) !== expectedAppleIdRef) {
      throw ApiError.conflict('当前绑定已改变，请刷新后重试');
    }
    if (appleIdRef !== null && (!Number.isSafeInteger(appleIdRef) || appleIdRef <= 0)) {
      throw ApiError.badRequest('appleIdRef 必须是正整数或 null');
    }
    if (appleIdRef !== null) {
      const account = await AppleId.findByPk(appleIdRef, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!account) throw ApiError.notFound('Apple ID 不存在');
      const occupied = await Recipient.findOne({
        where: { appleIdRef, id: { [Op.ne]: recipient.id } },
        transaction,
      });
      if (occupied)
        throw ApiError.conflict('该 Apple ID 已绑定其他取机人，请先明确解除原绑定', {
          recipientId: occupied.id,
        });
    }
    await recipient.update({ appleIdRef }, { transaction });
    return recipient.reload({ transaction });
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}

/** 依据邮箱解析现有账号，不猜测不存在账号的密码。 */
async function resolveAccount(appleId, transaction) {
  try {
    if (appleId === null || appleId === '') return null;
    if (typeof appleId !== 'string') throw ApiError.badRequest('Apple ID 必须为邮箱');
    const account = await AppleId.findOne({
      where: sequelize.where(
        sequelize.fn('lower', sequelize.fn('trim', sequelize.col('apple_id'))),
        appleId.trim().toLowerCase()
      ),
      transaction,
    });
    if (!account) throw ApiError.badRequest('该 Apple ID 尚未入库，请先导入账号');
    return account.id;
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}

module.exports = { lockProfiles, bindRecipient, resolveAccount };
