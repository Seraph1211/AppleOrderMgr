const logger = require('../utils/logger');
const { sequelize, AppleId } = require('../models');
const ApiError = require('../utils/ApiError');

/** 同一事务内串行化基础档案变更，避免导入、手工换绑及分配互相覆盖。 */
async function lockProfiles(transaction, actorId = null, initial = false) {
  try {
    await sequelize.query('SELECT pg_advisory_xact_lock(742091)', { transaction });
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

/** 兼容旧调用路径；绑定已退役，拒绝任何写入。 */
function bindRecipient() {
  return Promise.reject(
    new ApiError(410, 'PROFILE_BINDING_RETIRED', '取机人与 Apple ID 已独立维护，绑定功能不再使用')
  );
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
