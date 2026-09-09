const { Op } = require('sequelize');
const {
  sequelize,
  IdentityVerificationBatch: Batch,
  IdentityVerificationItem: Item,
} = require('../models');
const { PERMISSIONS } = require('../constants/business');
const service = require('./identityVerificationService');
const provider = require('./identityProviderService');
const logger = require('../utils/logger');

const LOCK_ID = 742095;
let timer;
let inFlight;

/** 取得全局排他锁后执行一行；已发出请求的中断任务从不重发。 @returns {Promise<boolean>} 是否处理 */
async function runOnce(verify = provider.verifyIdentity) {
  let connection;
  let locked = false;
  try {
    const readiness = provider.getStatus();
    if (!readiness.configured || !readiness.enabled) return false;
    connection = await sequelize.connectionManager.getConnection({ type: 'WRITE' });
    const lock = await connection.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
    locked = lock.rows[0].locked;
    if (!locked) return false;
    await sequelize.transaction(async transaction => {
      const abandoned = await Item.findAll({
        where: { status: 'processing' },
        attributes: ['id', 'batchId'],
        transaction,
      });
      if (abandoned.length) {
        await Item.update(
          {
            status: 'unknown',
            message: '上次执行中断，结果未知，未自动重试',
            finishedAt: new Date(),
          },
          { where: { id: abandoned.map(row => row.id) }, transaction }
        );
        await Batch.update(
          { status: 'paused', message: '上次执行中断，请查看结果后继续未开始项目' },
          {
            where: {
              id: [...new Set(abandoned.map(row => row.batchId))],
              status: { [Op.in]: service.ACTIVE },
            },
            transaction,
          }
        );
      }
    });
    const latest = await Item.max('startedAt');
    if (latest && Date.now() - new Date(latest).getTime() < 500) return false;
    const candidate = await Batch.findOne({
      where: { status: { [Op.in]: service.ACTIVE } },
      order: [
        ['updatedAt', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });
    if (!candidate) return false;
    let item;
    try {
      item = await sequelize.transaction(async transaction => {
        await service.authorize(
          { id: candidate.userId },
          candidate.source === 'single' ? PERMISSIONS.IDENTITY_VERIFY : PERMISSIONS.IDENTITY_BATCH,
          transaction
        );
        const batch = await Batch.findByPk(candidate.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!service.ACTIVE.includes(batch.status)) return null;
        const next = await Item.findOne({
          where: { batchId: batch.id, status: 'pending' },
          order: [['rowNumber', 'ASC']],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!next) {
          await batch.update({ status: 'completed' }, { transaction });
          return null;
        }
        await next.update({ status: 'processing', startedAt: new Date() }, { transaction });
        await batch.update({ status: 'running' }, { transaction });
        return next;
      });
    } catch (error) {
      if (error.statusCode !== 403) throw error;
      await Batch.update(
        { status: 'paused', message: '提交人账号已停用或核验权限已撤销' },
        { where: { id: candidate.id, status: { [Op.in]: service.ACTIVE } } }
      );
      return false;
    }
    if (!item) return false;
    // processing 已提交；即使回包持久化失败，下次也只标结果未知。
    const result = await verify(item.name, item.idCardNumber);
    await sequelize.transaction(async transaction => {
      const batch = await Batch.findByPk(item.batchId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      await item.update(
        {
          status: result.status,
          message: result.message,
          resultData: result.resultData || null,
          finishedAt: new Date(),
        },
        { transaction }
      );
      if (result.fatal) {
        await Batch.update(
          { status: 'paused', message: result.message },
          { where: { status: { [Op.in]: service.ACTIVE } }, transaction }
        );
      } else if (batch.status !== 'cancelled') {
        const pending = await Item.count({
          where: { batchId: batch.id, status: 'pending' },
          transaction,
        });
        await batch.update({ status: pending ? 'queued' : 'completed' }, { transaction });
      }
    });
    return true;
  } catch (_error) {
    logger.error('身份核验执行失败', { code: 'IDENTITY_RUN_FAILED' });
    return false;
  } finally {
    if (connection) {
      try {
        if (locked) await connection.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
        await sequelize.connectionManager.releaseConnection(connection);
      } catch (_error) {
        await sequelize.connectionManager.destroyConnection(connection).catch(() => {});
      }
    }
  }
}

/** 启动与订单Worker独立的核验执行循环。 @returns {void} */
function start() {
  if (timer) return;
  timer = setInterval(() => {
    if (!inFlight)
      inFlight = runOnce().finally(() => {
        inFlight = null;
      });
  }, 500);
  timer.unref();
}

/** 停止领取并等待一次在途请求。 @returns {Promise<void>} 完成 */
async function stop() {
  try {
    clearInterval(timer);
    timer = null;
    if (inFlight) await inFlight;
  } catch (_error) {
    logger.error('身份核验停止失败', { code: 'IDENTITY_STOP_FAILED' });
  }
}

module.exports = { start, stop, runOnce };
