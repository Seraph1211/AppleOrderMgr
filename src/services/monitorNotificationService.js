const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  MonitorNotificationSetting: Legacy,
  MonitorNotificationChannel: Channel,
  MonitorNotificationDelivery: Delivery,
  MonitorNotificationEvent: Event,
  MonitorNotificationLink: Link,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { config } = require('../utils/config');
const { encrypt } = require('../utils/fieldEncryption');
const { validateWebhook } = require('./wecomTransport');
const content = require('./monitorNotificationContent');
const p = require('./monitorPolicy');

const DEFAULT_POLICY = Object.freeze({
  warningWindowMinutes: 3,
  infoEnabled: false,
  recoveryMinutes: 2,
  criticalReminderMinutes: [15, 30, 60],
  warningReminderMinutes: 60,
  dailySummaryEnabled: false,
});
const EMAIL_POLICY = Object.freeze({ warningWindowMinutes: 10, infoEnabled: true, recoveryMinutes: 10, criticalReminderMinutes: [], warningReminderMinutes: null, dailySummaryEnabled: false });
const plain = row => (row?.toJSON ? row.toJSON() : row);
const conflict = () => new ApiError(409, 'CONCURRENT_MODIFICATION', '内容已更新，请刷新后重试');
const scopeError = () =>
  new ApiError(409, 'NOTIFICATION_SCOPE_CHANGED', '目标、开关或事件已变更，请刷新');

/** SMTP配置状态。 @returns {boolean} 已配置 */
function smtpConfigured() {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.password && config.smtp.from);
}
/** 目标修改和出站授权共用通道锁。 @param {string} channel 通道 @param {Object} transaction 事务 @returns {Promise<Object>} 设置 */
async function lockedChannel(channel, transaction) {
  try {
    if (!['email', 'wecom'].includes(channel)) throw ApiError.badRequest('通知通道无效');
    const row = await Channel.findByPk(channel, { transaction, lock: transaction?.LOCK.UPDATE });
    if (!row) throw new ApiError(503, 'NOTIFICATION_MIGRATION_REQUIRED', '通知迁移尚未完成');
    return row;
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 构造脱敏通道。 @param {Object} row 设置 @returns {Object} DTO */
function channelDto(row) {
  const value = plain(row);
  const [sender, domain] = String(config.smtp.from || '').split('@');
  return {
    channel: value.channel,
    enabled: value.enabled,
    version: value.version,
    targetVersion: value.targetVersion,
    policyVersion: value.policyVersion,
    targetName: value.targetName,
    configured:
      value.channel === 'email'
        ? smtpConfigured() && value.recipients.length > 0
        : Boolean(value.webhookCipher),
    sendRecovery: value.sendRecovery,
    policy: value.channel === 'email' ? EMAIL_POLICY : { ...DEFAULT_POLICY, ...value.policy },
    pausedReason: value.pausedReason,
    enabledAt: value.enabledAt,
    lastTest: value.lastTest,
    lastAcceptedAt: value.lastAcceptedAt,
    updatedAt: value.updatedAt,
    ...(value.channel === 'email'
      ? {
        recipients: value.recipients,
        smtp: {
          configured: smtpConfigured(),
          reusedFromOrderMailbox: config.smtp.reusedFromImap,
          sender: domain ? `${sender.slice(0, 2)}***@${domain}` : '未配置',
        },
      }
      : {}),
  };
}
/** 双通道脱敏配置。 @returns {Promise<Object>} 列表 */
async function channels() {
  try {
    return { channels: (await Channel.findAll({ order: [['channel', 'ASC']] })).map(channelDto) };
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 邮件兼容读取。 @returns {Promise<Object>} DTO */
async function settings() {
  try {
    return channelDto(await lockedChannel('email'));
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
function validatePolicy(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw ApiError.badRequest('通知策略无效');
  p.fields(value, Object.keys(DEFAULT_POLICY));
  for (const key of ['infoEnabled', 'dailySummaryEnabled'])
    if (value[key] !== undefined && typeof value[key] !== 'boolean')
      throw ApiError.badRequest('策略开关无效');
  if (value.warningWindowMinutes !== undefined) p.integer(value.warningWindowMinutes, 1, 30);
  if (value.recoveryMinutes !== undefined) p.integer(value.recoveryMinutes, 2, 30);
  if (value.warningReminderMinutes !== undefined) p.integer(value.warningReminderMinutes, 15, 1440);
  if (
    value.criticalReminderMinutes !== undefined &&
    (!Array.isArray(value.criticalReminderMinutes) ||
      value.criticalReminderMinutes.length !== 3 ||
      value.criticalReminderMinutes.some(n => !Number.isInteger(n) || n < 15 || n > 1440))
  )
    throw ApiError.badRequest('严重提醒间隔无效');
  return value;
}
/** 保存单通道并取消未出站旧目标。 @param {number} actor 用户 @param {string} channel 通道 @param {Object} body 输入 @returns {Promise<Object>} 设置 */
async function saveChannel(actor, channel, body) {
  try {
    p.fields(body, [
      'expectedVersion',
      'enabled',
      'sendRecovery',
      'recipients',
      'targetName',
      'webhook',
      'policy',
    ]);
    if (typeof body.enabled !== 'boolean' || typeof body.sendRecovery !== 'boolean')
      throw ApiError.badRequest('通知开关无效');
    if (
      channel === 'email' &&
      (body.webhook !== undefined || body.targetName !== undefined || body.policy !== undefined)
    )
      throw ApiError.badRequest('邮件保留原有通知策略');
    const policy = body.policy === undefined ? undefined : validatePolicy(body.policy);
    let recipients;
    if (body.recipients !== undefined) {
      if (channel !== 'email' || !Array.isArray(body.recipients) || body.recipients.length > 20)
        throw ApiError.badRequest('收件人无效');
      recipients = [
        ...new Set(body.recipients.map(value => String(value).trim().toLowerCase())),
      ].sort();
      if (recipients.some(value => value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))
        throw ApiError.badRequest('收件邮箱格式无效');
    }
    const webhook = body.webhook ? validateWebhook(body.webhook) : null;
    if (
      body.targetName !== undefined &&
      (typeof body.targetName !== 'string' ||
        !body.targetName.trim() ||
        body.targetName.length > 100)
    )
      throw ApiError.badRequest('群名称无效');
    return await sequelize.transaction(async transaction => {
      const row = await lockedChannel(channel, transaction);
      if (row.version !== body.expectedVersion) throw conflict();
      if (webhook && (row.enabled || body.enabled))
        throw ApiError.badRequest('替换机器人前请先停用通道，保存新目标后再启用');
      const targetChanged =
        Boolean(webhook) ||
        (recipients && JSON.stringify([...row.recipients].sort()) !== JSON.stringify(recipients));
      const policyChanged =
        policy &&
        JSON.stringify({ ...DEFAULT_POLICY, ...row.policy, ...policy }) !==
          JSON.stringify({ ...DEFAULT_POLICY, ...row.policy });
      const values = {
        enabled: body.enabled,
        sendRecovery: body.sendRecovery,
        version: row.version + 1,
        updatedBy: actor,
        ...(channel === 'email' && !row.enabled && body.enabled ? { pausedReason: null } : {}),
        ...(recipients ? { recipients } : {}),
        ...(webhook ? { webhookCipher: encrypt(webhook), pausedReason: null } : {}),
        ...(body.targetName ? { targetName: content.safeName(body.targetName) } : {}),
        ...(targetChanged ? { targetVersion: row.targetVersion + 1 } : {}),
        ...(policy
          ? {
            policy: { ...DEFAULT_POLICY, ...row.policy, ...policy },
            policyVersion: row.policyVersion + (policyChanged ? 1 : 0),
          }
          : {}),
        ...(!row.enabled && body.enabled ? { enabledAt: new Date() } : {}),
      };
      if (
        body.enabled &&
        (channel === 'email'
          ? !smtpConfigured() || !(recipients || row.recipients).length
          : !webhook && !row.webhookCipher)
      )
        throw ApiError.badRequest('启用前请配置有效目标');
      await row.update(values, { transaction });
      if (!body.enabled || targetChanged || !body.sendRecovery || policyChanged) {
        const where = {
          channel,
          status: { [Op.in]: ['pending', 'sending'] },
          dispatchStartedAt: null,
          ...(!body.enabled || targetChanged || policyChanged ? {} : { category: 'recovery' }),
        };
        // 旧策略的尚未出站任务保留事实，按新策略重建；目标变化绝不转发。
        const old =
          policyChanged && !targetChanged && body.enabled
            ? await Delivery.findAll({ where, transaction, limit: 1000 })
            : [];
        if (old.length === 1000) throw ApiError.badRequest('待发批次过多，请清理或等待后调整策略');
        await Delivery.update(
          {
            status: 'skipped',
            completedAt: new Date(),
            errorCode: targetChanged
              ? 'TARGET_CHANGED'
              : !body.enabled
                ? 'CHANNEL_DISABLED'
                : 'POLICY_CHANGED',
            version: sequelize.literal('version + 1'),
          },
          { where, transaction }
        );
        for (const batch of old) {
          const events = await Event.findAll({
            where: { deliveryId: batch.id },
            transaction,
            limit: 1001,
          });
          if (events.length > 1000) throw ApiError.badRequest('批次事件过多，请等待后调整策略');
          for (const event of events)
            await enqueueForChannel(
              row,
              event.payload,
              `policy:${row.policyVersion}:${event.eventKey}`,
              transaction,
              new Date()
            );
        }
      }
      if (channel === 'email')
        await Legacy.update(
          {
            enabled: row.enabled,
            recipients: row.recipients,
            sendRecovery: row.sendRecovery,
            version: row.version,
            updatedBy: actor,
          },
          { where: { id: 1 }, transaction }
        );
      return channelDto(row);
    });
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 旧邮件适配。 @param {number} actor 用户 @param {Object} body 设置 @returns {Promise<Object>} 设置 */
async function saveSettings(actor, body) {
  try {
    return await saveChannel(actor, 'email', body);
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
function nextHour(now) {
  return new Date(Math.floor(+now / 3600000) * 3600000 + 3600000);
}
/** 按通道安排首次计划。 @param {string} channel 通道 @param {Object} payload 事实 @param {Date} now 时间 @param {Object} policy 策略 @returns {Date} 计划 */
function schedule(channel, payload, now, policy) {
  if (['test', 'summary', 'reminder', 'daily'].includes(payload.category)) return now;
  if (payload.category === 'recovery')
    return new Date(+now + (channel === 'email' ? 10 : policy.recoveryMinutes) * 60000);
  if (payload.severity === 'critical') return now;
  if (payload.severity === 'warning')
    return new Date(+now + (channel === 'email' ? 10 : policy.warningWindowMinutes) * 60000);
  return nextHour(now);
}
/** 同告警事务登记单通道事件，窗口固定。 @param {Object} row 通道锁 @param {Object} payload 事实 @param {string} eventKey 事实键 @param {Object} transaction 事务 @param {Date} now 时间 @returns {Promise<Object|null>} 批次 */
async function enqueueForChannel(row, payload, eventKey, transaction, now = new Date()) {
  try {
    const policy = { ...DEFAULT_POLICY, ...row.policy };
    if (
      payload.category === 'alert' &&
      row.channel === 'wecom' &&
      row.enabledAt &&
      +new Date(payload.at) < +new Date(row.enabledAt)
    )
      return null;
    if (payload.category !== 'test' && (!row.enabled || row.pausedReason)) return null;
    if (row.channel === 'email' ? !row.recipients.length : !row.webhookCipher) return null;
    if (
      payload.category === 'alert' &&
      row.channel === 'wecom' &&
      payload.severity === 'info' &&
      !policy.infoEnabled
    )
      return null;
    if (payload.category === 'recovery' && !row.sendRecovery) return null;
    const sourceKey = `${row.channel}:${row.targetVersion}:${eventKey}`;
    const existing = await Event.findOne({ where: { eventKey, channel: row.channel, targetVersion: row.targetVersion }, transaction });
    if (existing) return Delivery.findByPk(existing.deliveryId, { transaction });
    if (payload.category === 'recovery') {
      const link = await Link.findOne({
        where: {
          alertId: payload.alertId,
          channel: row.channel,
          targetVersion: row.targetVersion,
          initialStatus: { [Op.in]: ['accepted', 'unknown'] },
        },
        transaction,
      });
      if (!link) return null;
      payload = { ...payload, originalUnknown: link.initialStatus === 'unknown' };
    }
    let delivery;
    let category = payload.category;
    let notBefore = schedule(row.channel, payload, now, policy);
    let deviceId = payload.deviceId || null;
    if (row.channel === 'wecom' && payload.category === 'alert') {
      const { NotificationWorkerState } = require('../models');
      const [storm] = await NotificationWorkerState.findOrCreate({
        where: { lane: 'storm-wecom' },
        defaults: { details: {} },
        transaction,
      });
      const details = storm.details?.targetVersion === row.targetVersion ? storm.details : {};
      const seen = (details.seen || []).filter(item => item.at > +now - 180000);
      seen.push({ id: payload.alertId, at: +now });
      const recent = new Set(seen.filter(item => item.at > +now - 60000).map(item => item.id)).size;
      const prior = new Set(
        seen.filter(item => item.at <= +now - 60000 && item.at > +now - 120000).map(item => item.id)
      ).size;
      const active =
        recent > 5 ||
        (details.active &&
          !(recent < 5 && prior < 5 && +now - (details.activatedAt || +now) >= 120000));
      await storm.update(
        {
          heartbeatAt: now,
          details: {
            active,
            activatedAt: active ? details.activatedAt || +now : null,
            seen: seen.slice(-1000),
            targetVersion: row.targetVersion,
          },
        },
        { transaction }
      );
      if (active) {
        category = 'storm';
        deviceId = null;
        notBefore = new Date(Math.floor(+now / 60000) * 60000 + 60000);
      }
    }
    if (
      (payload.severity !== 'critical' && ['alert', 'recovery'].includes(category)) ||
      category === 'storm'
    )
      delivery = await Delivery.findOne({
        where: {
          channel: row.channel,
          targetVersion: row.targetVersion,
          policyVersion: row.policyVersion,
          deviceId,
          category,
          severity: category === 'storm' ? 'critical' : payload.severity,
          status: 'pending',
          dispatchStartedAt: null,
          notBefore: { [Op.gt]: now },
        },
        order: [['createdAt', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
    if (
      delivery &&
      (await Event.count({ where: { deliveryId: delivery.id }, transaction })) >= 1000
    )
      delivery = null;
    if (!delivery)
      delivery = await Delivery.create(
        {
          id: randomUUID(),
          channel: row.channel,
          targetVersion: row.targetVersion,
          policyVersion: row.policyVersion,
          targetName: row.targetName,
          deviceId,
          category,
          severity: category === 'storm' ? 'critical' : payload.severity,
          status: 'pending',
          notBefore,
          recipientSnapshot: row.recipients,
          recipientResults: {},
          attempts: 0,
          priority: category === 'storm' ? 90 : payload.severity === 'critical' ? 100 : 10,
          version: 1,
          expiresAt: new Date(
            +notBefore +
              (row.channel === 'email'
                ? 86400000
                : payload.category === 'recovery'
                  ? 1800000
                  : 600000)
          ),
        },
        { transaction }
      );
    await Event.create(
      {
        id: randomUUID(),
        deliveryId: delivery.id,
        sourceKey,
        eventKey,
        channel: row.channel,
        targetVersion: row.targetVersion,
        payload,
        outcome: 'pending',
        reminderSequence: payload.reminderSequence || 0,
      },
      { transaction }
    );
    return delivery;
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
async function enqueueBoth(payload, key, transaction, now) {
  try {
    const results = [];
    for (const channel of ['email', 'wecom'])
      results.push(
        await enqueueForChannel(
          await lockedChannel(channel, transaction),
          payload,
          key,
          transaction,
          now
        )
      );
    return results[0] || results[1];
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 首次异常双通道入队。 @param {Object} input 事实 @param {Object} transaction 事务 @returns {Promise<Object>} 投递 */
async function enqueueAlert(input, transaction) {
  try {
    return await enqueueBoth(
      { ...input, category: 'alert' },
      `alert:${input.alertId}`,
      transaction,
      new Date(input.at)
    );
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 恢复关联入队。 @param {Object} input 事实 @param {Object} transaction 事务 @returns {Promise<Object>} 投递 */
async function enqueueRecovery(input, transaction) {
  try {
    return await enqueueBoth(
      { ...input, originalSeverity: input.severity, severity: 'info', category: 'recovery' },
      `recovery:${input.alertId}`,
      transaction,
      new Date(input.at)
    );
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 静默到期双通道入队。 @param {Object} input 事实 @param {Object} transaction 事务 @returns {Promise<Object>} 投递 */
async function enqueueReminder(input, transaction) {
  try {
    return await enqueueBoth(
      { ...input, category: 'reminder', severity: 'warning' },
      `silence:${input.instanceId}:${input.until}`,
      transaction,
      new Date(input.until)
    );
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 合成测试幂等，允许自动关闭。 @param {string} channel 通道 @param {Object} body 输入 @returns {Promise<Object>} 投递ID */
async function queueTest(channel = 'email', body = { requestKey: randomUUID() }) {
  try {
    p.uuid(body.requestKey);
    return await sequelize.transaction(async transaction => {
      const row = await lockedChannel(channel, transaction);
      if (channel === 'email' ? !smtpConfigured() || !row.recipients.length : !row.webhookCipher)
        throw ApiError.badRequest('请先配置有效通知目标');
      const delivery = await enqueueForChannel(
        row,
        { category: 'test', severity: 'info', title: '合成连接测试', at: new Date().toISOString() },
        `test:${body.requestKey}`,
        transaction
      );
      return { deliveryId: delivery.id, status: delivery.status };
    });
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
module.exports = {
  DEFAULT_POLICY,
  smtpConfigured,
  channels,
  settings,
  saveSettings,
  saveChannel,
  lockedChannel,
  enqueueForChannel,
  enqueueAlert,
  enqueueRecovery,
  enqueueReminder,
  queueTest,
  scopeError,
  conflict,
  schedule,
  channelDto,
  /** 调度入口惰性加载避免循环依赖。 */
  scheduleTick: async now => {
    try { return await require('./monitorNotificationScheduler').scheduleTick(now); }
    catch (error) { require('../utils/logger').debug('监控通知调度未完成', { errorCode: error.code || error.name }); throw error; }
  },
};
