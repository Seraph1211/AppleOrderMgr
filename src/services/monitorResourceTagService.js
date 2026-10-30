const { randomUUID } = require('crypto');
const {
  sequelize,
  AosDevice,
  MonitorInstance,
  MonitorLogState,
  MonitorResourceTag,
} = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const policy = require('./monitorPolicy');
const logs = require('./monitorLogService');

const resourceKey = (deviceId, localId) => `${deviceId}:${localId || ''}`;
const plain = row => (row.toJSON ? row.toJSON() : row);

/** 日志目录附加人工标签，无 N+1，不暴露设备凭证。 @returns {Promise<Object>} 目录 */
async function states() {
  try {
    const [catalog, rows] = await Promise.all([logs.states(), MonitorResourceTag.findAll()]);
    const tags = new Map(rows.map(row => [resourceKey(row.deviceId, row.localId), row]));
    const tagged = (row, deviceId, localId) => {
      const tag = tags.get(resourceKey(deviceId, localId));
      return { ...plain(row), tag: tag?.tag || '', tagVersion: tag?.version || 0 };
    };
    return {
      ...catalog,
      devices: catalog.devices.map(row => tagged(row, row.id, null)),
      instances: catalog.instances.map(row => tagged(row, row.deviceId, row.localId)),
    };
  } catch (error) {
    logger.warn('监控标签目录读取失败', { errorCode: error.code || error.name });
    throw error;
  }
}

/**
 * 持久化单个资源标签，使用事务锁及版本检查防止覆盖他人编辑。
 * @param {number} actorId 操作用户
 * @param {Object} body 资源、标签及期望版本
 * @returns {Promise<Object>} 保存后的标签与版本
 */
async function save(actorId, body) {
  try {
    policy.fields(body, ['deviceId', 'localId', 'tag', 'expectedVersion']);
    const deviceId = policy.uuid(body.deviceId).toLowerCase();
    const localId = body.localId == null ? null : policy.uuid(body.localId).toLowerCase();
    const tag = policy.shortText(body.tag, 100, true);
    if (
      [...body.tag].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 || code === 8232 || code === 8233;
      })
    )
      throw ApiError.badRequest('标签须为单行文本');
    const expectedVersion = policy.integer(body.expectedVersion, 0, 2147483646);
    return await sequelize.transaction(async transaction => {
      try {
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:resourceKey))', {
          replacements: { resourceKey: `monitor-tag:${resourceKey(deviceId, localId)}` },
          transaction,
        });
        const device = await AosDevice.findByPk(deviceId, {
          attributes: ['id'],
          transaction,
          lock: transaction.LOCK.KEY_SHARE,
        });
        if (!device) throw ApiError.notFound('服务器不存在');
        if (localId) {
          const where = { deviceId, localId };
          const configured = await MonitorInstance.findOne({
            where,
            attributes: ['id'],
            transaction,
          });
          const observed =
            configured ||
            (await MonitorLogState.findOne({
              where,
              attributes: ['id'],
              transaction,
            }));
          if (!observed) throw ApiError.notFound('实例不存在');
        }
        let row = await MonitorResourceTag.findOne({
          where: { deviceId, localId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if ((row?.version || 0) !== expectedVersion)
          throw new ApiError(409, 'CONCURRENT_MODIFICATION', '标签已被修改，请重新读取后再保存');
        if (row) await row.update({ tag, version: row.version + 1 }, { transaction });
        else
          row = await MonitorResourceTag.create(
            {
              id: randomUUID(),
              deviceId,
              localId,
              tag,
              version: 1,
            },
            { transaction }
          );
        logger.info('监控人工标签已保存', { actorId, deviceId, localId, version: row.version });
        return { deviceId, localId, tag: row.tag, tagVersion: row.version };
      } catch (error) {
        logger.warn('监控标签保存失败', { actorId, errorCode: error.code || error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.warn('监控标签请求未完成', { actorId, errorCode: error.code || error.name });
    throw error;
  }
}

module.exports = { states, save };
