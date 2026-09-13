const logger = require('../utils/logger');
const crypto = require('crypto');
const { CollectorUpdateJob, AosDevice } = require('../models');
const repo = require('./ingestionRepository');
const { getRelease, VERSION_PATTERN } = require('./collectorReleaseService');
const ApiError = require('../utils/ApiError');
const ACTIVE = ['queued', 'downloading', 'installing'];
const TERMINAL = ['succeeded', 'failed', 'rolled_back'];
/** 创建指定设备升级任务，进行中的相同目标幂等复用。 @param {Object} req 请求 @returns {Promise<Object>} 任务 */
async function scheduleUpdates(req) {
  try {
    repo.assertFields(req.body, ['deviceIds', 'releaseVersion']);
    const { deviceIds, releaseVersion } = req.body;
    if (
      !Array.isArray(deviceIds) ||
      deviceIds.length < 1 ||
      deviceIds.length > 20 ||
      new Set(deviceIds).size !== deviceIds.length
    )
      throw ApiError.badRequest('请选择 1–20 台不同设备');
    deviceIds.forEach(repo.requireUuid);
    await getRelease(releaseVersion);
    return await repo.ingestionTransaction(async transaction => {
      try {
        const items = [];
        for (const deviceId of deviceIds) {
          const device = await AosDevice.findByPk(deviceId, { transaction });
          if (!device?.enabled) throw ApiError.badRequest('目标设备不存在或已禁用');
          let row = await CollectorUpdateJob.findOne({
            where: { deviceId, status: { [repo.Op.in]: ACTIVE } },
            transaction,
          });
          if (row && row.releaseVersion !== releaseVersion)
            throw ApiError.conflict('设备已有其他进行中的更新');
          if (!row)
            row = await CollectorUpdateJob.create(
              { id: crypto.randomUUID(), deviceId, releaseVersion, actorId: req.user.id },
              { transaction }
            );
          items.push(row);
        }
        await repo.audit(req.user, '下发采集器更新', releaseVersion, transaction);
        return { items };
      } catch (error) {
        logger.debug('付款码或采集更新操作未完成', {
          errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
        });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('付款码或采集更新操作未完成', {
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}
/** 查询更新历史。 @returns {Promise<Object>} 任务 */
async function listUpdates() {
  try {
    return {
      items: await CollectorUpdateJob.findAll({ order: [['createdAt', 'DESC']], limit: 100 }),
    };
  } catch (error) {
    logger.debug('付款码或采集更新操作未完成', {
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}
/** 领取自身更新任务。 @param {string} header 凭据 @returns {Promise<Object>} 任务或空 */
async function pollUpdate(header) {
  try {
    const device = await repo.authenticateDevice(header);
    const job = await CollectorUpdateJob.findOne({
      where: { deviceId: device.id, status: { [repo.Op.in]: ACTIVE } },
      order: [['createdAt', 'ASC']],
    });
    if (!job) return { job: null };
    return { job, envelope: (await getRelease(job.releaseVersion)).envelope };
  } catch (error) {
    logger.debug('付款码或采集更新操作未完成', {
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}
/** 校验设备下载归属。 @param {string} header 凭据 @param {string} id 任务 @returns {Promise<Object>} 文件 */
async function updatePackage(header, id) {
  try {
    const device = await repo.authenticateDevice(header);
    const job = await CollectorUpdateJob.findOne({
      where: { id: repo.requireUuid(id), deviceId: device.id, status: { [repo.Op.in]: ACTIVE } },
    });
    if (!job) throw ApiError.notFound('更新任务不存在');
    return await getRelease(job.releaseVersion);
  } catch (error) {
    logger.debug('付款码或采集更新操作未完成', {
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}
/** 设备上报更新状态；终态不可倒退。 @param {string} header 凭据 @param {string} id 任务 @param {Object} body 状态 @returns {Promise<Object>} 任务 */
async function reportUpdate(header, id, body) {
  try {
    repo.assertFields(body, ['status', 'agentVersion', 'errorCode']);
    if (
      ![...ACTIVE.slice(1), ...TERMINAL].includes(body.status) ||
      !VERSION_PATTERN.test(body.agentVersion) ||
      (body.errorCode != null && !/^[A-Z0-9_]{1,80}$/.test(body.errorCode))
    )
      throw ApiError.badRequest('更新状态无效');
    return await repo.ingestionTransaction(async transaction => {
      try {
        const device = await repo.authenticateDevice(header, transaction);
        const row = await CollectorUpdateJob.findOne({
          where: { id: repo.requireUuid(id), deviceId: device.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!row) throw ApiError.notFound('更新任务不存在');
        if (TERMINAL.includes(row.status)) {
          if (
            row.status !== body.status ||
            row.agentVersion !== body.agentVersion ||
            (row.errorCode || null) !== (body.errorCode || null)
          )
            throw ApiError.conflict('更新任务已结束');
          return row;
        }
        if (
          ACTIVE.includes(body.status) &&
          ACTIVE.indexOf(body.status) < ACTIVE.indexOf(row.status)
        )
          throw ApiError.conflict('更新状态不能倒退');
        if (body.status === 'succeeded' && body.agentVersion !== row.releaseVersion)
          throw ApiError.badRequest('运行版本与目标版本不一致');
        if (body.status === 'succeeded' && row.status !== 'installing')
          throw ApiError.conflict('尚未开始安装');
        await row.update(
          {
            status: body.status,
            agentVersion: body.agentVersion,
            errorCode: body.errorCode || null,
          },
          { transaction }
        );
        return row;
      } catch (error) {
        logger.debug('付款码或采集更新操作未完成', {
          errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
        });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('付款码或采集更新操作未完成', {
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}
module.exports = { scheduleUpdates, listUpdates, pollUpdate, updatePackage, reportUpdate };
