/** 邮件来源切回后的持久化当天回查任务。 */
const crypto = require('crypto');
const { IngestionOperation } = require('../models');
const repo = require('./ingestionRepository');
const logger = require('../utils/logger');

/** 当前来源的待回查范围。 @returns {Promise<Object|null>} 扫描任务 */
function loadBackfill() {
  return repo.ingestionTransaction(async (transaction, settings) => {
    try {
      if (settings.activeSource !== 'email') return null;
      const task = await IngestionOperation.findOne({
        where: {
          kind: 'backfill',
          scope: `backfill:${settings.version}`,
          status: { [repo.Op.in]: ['queued', 'running'] },
        },
        transaction,
      });
      if (!task || task.data.source !== 'email' || task.data.scanCompletedAt) return null;
      return { id: task.id, ...task.data };
    } catch (error) {
      logger.warn('邮件补录读取失败', { errorCode: 'DATABASE_TEMPORARY' });
      throw error;
    }
  });
}

/** 仅表示 IMAP 回查结束，入库是否完成另外统计。 @param {string} id 补录 ID @returns {Promise<void>} 结果 */
function completeBackfill(id) {
  return repo.ingestionTransaction(async (transaction, settings) => {
    try {
      const task = await IngestionOperation.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        !task ||
        task.status === 'superseded' ||
        task.data.settingsVersion !== settings.version ||
        settings.activeSource !== 'email'
      )
        return;
      task.status = 'running';
      task.data = { ...task.data, scanCompletedAt: new Date().toISOString() };
      await task.save({ transaction });
    } catch (error) {
      logger.warn('邮件补录确认失败', { errorCode: 'DATABASE_TEMPORARY' });
      throw error;
    }
  });
}
/** 绑定本轮实际扫描并可靠接收的邮件，避免统计无关邮件。 @param {string} id 补录 @param {number} recordId 邮件 @returns {Promise<void>} 结果 */
async function recordBackfill(id, recordId) {
  try {
    await IngestionOperation.findOrCreate({
      where: { scope: `backfill-record:${id}:${recordId}` },
      defaults: {
        id: crypto.randomUUID(),
        kind: 'backfill_record',
        status: 'received',
        data: { backfillId: id, emailLogId: recordId },
      },
    });
  } catch (error) {
    logger.warn('邮件补录关联失败', { errorCode: 'DATABASE_TEMPORARY' });
    throw error;
  }
}
module.exports = { loadBackfill, completeBackfill, recordBackfill };
