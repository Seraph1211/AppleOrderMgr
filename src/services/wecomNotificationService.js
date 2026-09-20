const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  WecomNotificationSetting: Setting,
  WecomNotificationDelivery: Delivery,
  Order,
} = require('../models');
const { encrypt, decrypt } = require('../utils/fieldEncryption');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { validateWebhook } = require('./wecomTransport');
const { orderBlockReason } = require('./wecomNotificationContent');
const ACTIVE_STATUSES = ['pending', 'waiting'];
const STATUSES = [...ACTIVE_STATUSES, 'sending', 'accepted', 'failed', 'unknown', 'skipped'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fields(body, allowed) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some(k => !allowed.includes(k))
  )
    throw ApiError.badRequest('请求字段无效');
}
function checkVersion(row, version) {
  if (!Number.isSafeInteger(version) || version < 1) throw ApiError.badRequest('版本号无效');
  if (row.version !== version)
    throw new ApiError(409, 'CONCURRENT_MODIFICATION', '内容已更新，请刷新后重试');
}
function settingDto(row) {
  return {
    enabled: row.enabled,
    groupName: row.groupName,
    configured: Boolean(row.webhookCipher),
    destinationId: row.destinationId,
    enabledAt: row.enabledAt,
    version: row.version,
    pausedReason: row.pausedReason,
    workerHeartbeatAt: row.workerHeartbeatAt,
    updatedAt: row.updatedAt,
    waitSeconds: 60,
    ratePerMinute: 18,
  };
}
function deliveryDto(row) {
  return Object.fromEntries(
    [
      'id',
      'orderId',
      'groupName',
      'kind',
      'status',
      'attempts',
      'version',
      'createdAt',
      'updatedAt',
      'sentAt',
      'errorCode',
    ].map(k => [k, row[k]])
  );
}
/** 统一事务错误记录，不包含输入、SQL或密钥。 @param {Function} work 事务 @returns {Promise<*>} 结果 */
async function transactionWork(work) {
  try {
    return await sequelize.transaction(work);
  } catch (error) {
    logger.debug('企微通知操作未完成', { errorType: error.name });
    throw error;
  }
}
/** 获取唯一设置行并锁定，必须已迁移。 @param {Object} transaction 事务 @returns {Promise<Object>} 设置 */
async function lockedSetting(transaction) {
  try {
    const row = await Setting.findByPk(1, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw new ApiError(503, 'WECOM_NOT_MIGRATED', '企微通知尚未初始化');
    return row;
  } catch (error) {
    logger.debug('企微通知事务未完成', { errorType: error.name });
    throw error;
  }
}
/** 查询脱敏配置。 @returns {Promise<Object>} 配置 */
async function settings() {
  try {
    const row = await Setting.findByPk(1);
    if (!row) throw new ApiError(503, 'WECOM_NOT_MIGRATED', '企微通知尚未初始化');
    return settingDto(row);
  } catch (error) {
    logger.debug('读取企微配置失败', { errorType: error.name });
    throw error;
  }
}
/** 保存配置，切换目标不迁移旧消息。 @param {number} actorId 用户 @param {Object} body 请求 @returns {Promise<Object>} 配置 */
async function saveSettings(actorId, body) {
  try {
    fields(body, ['enabled', 'groupName', 'webhook', 'expectedVersion']);
    if (
      typeof body.enabled !== 'boolean' ||
      typeof body.groupName !== 'string' ||
      !body.groupName.trim() ||
      body.groupName.length > 100 ||
      [...body.groupName].some(char => char.charCodeAt(0) < 32) ||
      (body.webhook !== undefined && typeof body.webhook !== 'string')
    )
      throw ApiError.badRequest('群名称或配置无效');
    const webhook = body.webhook ? validateWebhook(body.webhook) : null;
    return await transactionWork(async transaction => {
      const row = await lockedSetting(transaction);
      checkVersion(row, body.expectedVersion);
      const changing = webhook && webhook !== decrypt(row.webhookCipher);
      if (changing && row.enabled) throw ApiError.badRequest('更换机器人前请先停用自动通知');
      if (body.enabled && !webhook && !row.webhookCipher)
        throw ApiError.badRequest('启用前请先配置 Webhook');
      if (!body.enabled || changing) {
        await Delivery.update(
          {
            status: 'skipped',
            errorCode: changing ? 'DESTINATION_CHANGED' : 'DISABLED',
            version: sequelize.literal('version + 1'),
          },
          {
            where: {
              status: { [Op.in]: [...ACTIVE_STATUSES, 'sending'] },
              dispatchStartedAt: null,
            },
            transaction,
          }
        );
      }
      await row.update(
        {
          enabled: body.enabled,
          groupName: body.groupName.trim(),
          ...(webhook ? { webhookCipher: encrypt(webhook) } : {}),
          ...(changing ? { destinationId: randomUUID() } : {}),
          enabledAt: body.enabled && !row.enabled ? new Date() : row.enabledAt,
          pausedReason: null,
          version: row.version + 1,
          updatedBy: actorId,
        },
        { transaction }
      );
      return settingDto(row);
    });
  } catch (error) {
    logger.debug('企微通知事务未完成', { errorType: error.name });
    throw error;
  }
}
/** 在新订单事务内幂等登记，关闭时不补发。 @param {Object} order 新订单 @param {Object} transaction 事务 @returns {Promise<Object|null>} 投递 */
async function enrollOrder(order, transaction) {
  try {
    const setting = await lockedSetting(transaction);
    if (
      !setting.enabled ||
      !setting.enabledAt ||
      +new Date(order.createdAt) < +new Date(setting.enabledAt)
    )
      return null;
    const now = new Date();
    const [row] = await Delivery.findOrCreate({
      where: { orderId: order.id },
      defaults: {
        id: randomUUID(),
        destinationId: setting.destinationId,
        groupName: setting.groupName,
        kind: 'order',
        waitUntil: new Date(+now + 60000),
        notBefore: now,
      },
      transaction,
    });
    return row;
  } catch (error) {
    logger.debug('企微通知登记失败', { errorType: error.name });
    throw error;
  }
}
/** 登记固定合成测试；可在自动通知停用时测试。 @param {number} actorId 用户 @param {Object} body 请求 @returns {Promise<Object>} 投递 */
async function queueTest(actorId, body) {
  try {
    fields(body, ['expectedVersion', 'idempotencyKey']);
    if (!UUID.test(body.idempotencyKey || '')) throw ApiError.badRequest('测试请求标识无效');
    return await transactionWork(async transaction => {
      const setting = await lockedSetting(transaction);
      checkVersion(setting, body.expectedVersion);
      if (!setting.webhookCipher || setting.pausedReason)
        throw ApiError.badRequest('请先保存有效配置；暂停后重新保存可恢复');
      const existing = await Delivery.findOne({
        where: { requestKey: body.idempotencyKey },
        transaction,
      });
      if (existing) return deliveryDto(existing);
      const now = new Date();
      return deliveryDto(
        await Delivery.create(
          {
            id: randomUUID(),
            destinationId: setting.destinationId,
            groupName: setting.groupName,
            kind: 'test',
            requestKey: body.idempotencyKey,
            actorId,
            waitUntil: now,
            notBefore: now,
          },
          { transaction }
        )
      );
    });
  } catch (error) {
    logger.debug('企微通知事务未完成', { errorType: error.name });
    throw error;
  }
}
/** 分页读取元数据及积压，永不返回支付地址或密钥。 @param {Object} query 查询 @returns {Promise<Object>} 分页 */
async function history(query = {}) {
  try {
    fields(query, ['page', 'status']);
    const page = Number(query.page || 1);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100000 ||
      (query.status && !STATUSES.includes(query.status))
    )
      throw ApiError.badRequest('分页或状态无效');
    const [result, counts, oldest] = await Promise.all([
      Delivery.findAndCountAll({
        where: query.status ? { status: query.status } : {},
        limit: 30,
        offset: (page - 1) * 30,
        order: [
          ['createdAt', 'DESC'],
          ['id', 'DESC'],
        ],
      }),
      Delivery.count({ group: ['status'] }),
      Delivery.findOne({
        where: { status: { [Op.in]: [...ACTIVE_STATUSES, 'sending'] } },
        order: [['createdAt', 'ASC']],
      }),
    ]);
    const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const entry of counts) byStatus[entry.status] = Number(entry.count);
    return {
      rows: result.rows.map(deliveryDto),
      total: result.count,
      page,
      totalPages: Math.ceil(result.count / 30),
      summary: {
        ...byStatus,
        backlog: byStatus.pending + byStatus.waiting + byStatus.sending,
        oldestPendingAt: oldest?.createdAt || null,
      },
    };
  } catch (error) {
    logger.debug('读取企微投递失败', { errorType: error.name });
    throw error;
  }
}
/** 人工重试，未知结果须显式确认，状态更新受版本保护。 @param {number} actorId 用户 @param {string} id 投递 @param {Object} body 请求 @returns {Promise<Object>} 投递 */
async function retry(actorId, id, body) {
  try {
    fields(body, ['expectedVersion', 'acknowledgeUnknown']);
    if (
      !UUID.test(id) ||
      (body.acknowledgeUnknown !== undefined && typeof body.acknowledgeUnknown !== 'boolean')
    )
      throw ApiError.badRequest('重试参数无效');
    return await transactionWork(async transaction => {
      const setting = await lockedSetting(transaction);
      const row = await Delivery.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row) throw ApiError.notFound('投递记录不存在');
      checkVersion(row, body.expectedVersion);
      if (!['failed', 'unknown'].includes(row.status)) throw ApiError.badRequest('此状态不能重试');
      if (row.status === 'unknown' && body.acknowledgeUnknown !== true)
        throw ApiError.badRequest('请先核对群消息并确认可能重复发送');
      if (
        setting.destinationId !== row.destinationId ||
        setting.pausedReason ||
        (row.kind === 'order' &&
          (!setting.enabled || +new Date(row.createdAt) < +new Date(setting.enabledAt)))
      )
        throw ApiError.badRequest('原通知范围已停用或目标已更换，不能重试');
      const reason =
        row.kind === 'order'
          ? orderBlockReason(await Order.findByPk(row.orderId, { transaction }), new Date())
          : null;
      await row.update(
        {
          status: reason ? (reason === 'DEADLINE_MISSING' ? 'failed' : 'skipped') : 'pending',
          errorCode: reason,
          attempts: 0,
          notBefore: new Date(),
          leaseUntil: null,
          leaseToken: null,
          dispatchStartedAt: null,
          version: row.version + 1,
          actorId,
        },
        { transaction }
      );
      return deliveryDto(row);
    });
  } catch (error) {
    logger.debug('企微通知事务未完成', { errorType: error.name });
    throw error;
  }
}
module.exports = {
  settings,
  saveSettings,
  enrollOrder,
  queueTest,
  history,
  retry,
  transactionWork,
  lockedSetting,
  ACTIVE_STATUSES,
};
