const { sequelize, EmailMailboxCursor } = require('../models');
const logger = require('../utils/logger');
const STARTUP_LOOKBACK_MS = 24 * 60 * 60_000;
const MAX_UID = 4294967295;

/**
 * 恢复可靠接收进度；首次回查起点只初始化一次。
 * @param {Object} identity - 邮箱哈希和 UIDVALIDITY
 * @returns {Promise<Object>} 游标
 */
async function loadCursor(identity) {
  try {
    const [cursor] = await EmailMailboxCursor.findOrCreate({
      where: identity,
      defaults: { ...identity, bootstrapSince: new Date(Date.now() - STARTUP_LOOKBACK_MS) },
    });
    return {
      lastUid: cursor.lastUid === null ? null : Number(cursor.lastUid),
      bootstrapSince: cursor.bootstrapSince,
    };
  } catch (error) {
    logger.error('邮件接收游标保存或读取失败', { errorCode: 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/**
 * 仅在整批已持久化后推进游标，行锁保证并发不能回退。
 * @param {Object} identity - 邮箱哈希和 UIDVALIDITY
 * @param {number} lastUid - 已完整接收批次的最大 UID
 * @returns {Promise<void>}
 */
async function advanceCursor(identity, lastUid) {
  try {
    if (!Number.isInteger(lastUid) || lastUid < 1 || lastUid > MAX_UID) {
      throw new Error('无效的邮件游标');
    }
    await sequelize.transaction(async transaction => {
      const cursor = await EmailMailboxCursor.findOne({
        where: identity,
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!cursor) throw new Error('邮件游标尚未初始化');
      if (cursor.lastUid === null || Number(cursor.lastUid) < lastUid) {
        cursor.lastUid = String(lastUid);
        await cursor.save({ transaction });
      }
    });
  } catch (error) {
    logger.error('邮件接收游标保存或读取失败', { errorCode: 'DATABASE_TEMPORARY' });
    throw error;
  }
}

module.exports = { loadCursor, advanceCursor };
