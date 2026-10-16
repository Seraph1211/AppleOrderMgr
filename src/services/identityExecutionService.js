const { Op } = require('sequelize');
const {
  sequelize,
  IdentityVerificationItem: Item,
  IdentityVerificationBatch: Batch,
} = require('../models');
const ApiError = require('../utils/ApiError');
const provider = require('./identityProviderService');
const logger = require('../utils/logger');
const LOCK_ID = 742095;
const DAILY_LIMIT = 500;

/** 北京时间日期，用于API调用日额度。 @returns {string} 日期 */
function usageDate() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

/** 读取跨进程服务暂停状态。 @returns {Promise<Object>} 状态 */
async function getState(transaction) {
  try {
    const [rows] = await sequelize.query(
      'SELECT paused,pause_reason AS "pauseReason" FROM identity_service_state WHERE id=1',
      { transaction }
    );
    return { ...provider.getStatus(), ...rows[0] };
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 修改全局暂停，供应商致命错误和管理员共用。 @returns {Promise<void>} 完成 */
async function setPaused(paused, reason, transaction) {
  try {
    await sequelize.query(
      'UPDATE identity_service_state SET paused=:paused,pause_reason=:reason,updated_at=NOW() WHERE id=1',
      { replacements: { paused, reason }, transaction }
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 在用户锁内原子预占限额，已发送未知请求不退还。 @returns {Promise<void>} 完成 */
async function reserveUsage(userId, kind, transaction) {
  try {
    const period = kind === 'day' ? usageDate() : String(Math.floor(Date.now() / 60000));
    const limit = kind === 'day' ? DAILY_LIMIT : 50;
    const [rows] = await sequelize.query(
      `INSERT INTO identity_api_usage(user_id,kind,period,count)
      VALUES(:userId,:kind,:period,1) ON CONFLICT(user_id,kind,period)
      DO UPDATE SET count=identity_api_usage.count+1 WHERE identity_api_usage.count < :limit RETURNING count`,
      { replacements: { userId, kind, period, limit }, transaction }
    );
    if (!rows.length)
      throw new ApiError(
        429,
        kind === 'day' ? 'DAILY_LIMIT' : 'RATE_LIMIT',
        kind === 'day' ? '今日核验调用额度已用尽' : '请求过于频繁'
      );
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 独占所有入口的供应商执行槽；不排队，持锁期间不会恢复其他在途请求。 @returns {Promise<*>} 执行结果 */
async function withSlot(work) {
  let connection;
  let locked = false;
  try {
    const ready = provider.getStatus();
    if (!ready.configured || !ready.enabled)
      throw new ApiError(503, 'IDENTITY_NOT_READY', '身份核验服务未启用');
    connection = await sequelize.connectionManager.getConnection({ type: 'WRITE' });
    const lock = await connection.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
    locked = lock.rows[0].locked;
    if (!locked)
      throw new ApiError(429, 'SERVICE_BUSY', '核验服务繁忙，请稍后由调用方明确发起新请求');
    await sequelize.transaction(async transaction => {
      const abandoned = await Item.findAll({
        where: { status: 'processing' },
        attributes: ['id', 'batchId'],
        transaction,
      });
      if (!abandoned.length) return;
      await Item.update(
        {
          status: 'unknown',
          message: '上次执行中断，结果未知，未自动重试',
          finishedAt: new Date(),
        },
        { where: { id: abandoned.map(row => row.id) }, transaction }
      );
      await Batch.update(
        { status: 'paused', message: '上次执行中断，请核查结果' },
        {
          where: {
            id: [...new Set(abandoned.map(row => row.batchId))],
            status: { [Op.in]: ['queued', 'running'] },
          },
          transaction,
        }
      );
    });
    const state = await getState();
    if (state.paused) throw new ApiError(503, 'SERVICE_PAUSED', '身份核验服务已暂停，请联系管理员');
    const latest = await Item.max('startedAt');
    if (latest && Date.now() - new Date(latest).getTime() < 500)
      throw new ApiError(429, 'SERVICE_BUSY', '核验服务间隔保护，请稍后发起新请求');
    return await work();
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  } finally {
    if (connection) {
      try {
        if (locked) await connection.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
        await sequelize.connectionManager.releaseConnection(connection);
      } catch (_error) {
        logger.error('核验执行锁连接回收失败', { code: 'IDENTITY_LOCK_RELEASE_FAILED' });
        await sequelize.connectionManager.destroyConnection(connection).catch(() => {});
      }
    }
  }
}

module.exports = { DAILY_LIMIT, usageDate, getState, setPaused, reserveUsage, withSlot };
