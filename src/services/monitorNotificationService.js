const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  MonitorNotificationSetting,
  MonitorNotificationDelivery,
  MonitorNotificationEvent,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { config } = require('../utils/config');
const p = require('./monitorPolicy');

const SETTING_ID = 1;
const RETENTION_MS = 90 * 86400000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const plain = row => (row?.toJSON ? row.toJSON() : row);

function smtpConfigured() {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.password && config.smtp.from);
}

function maskedSender() {
  const value = config.smtp.from || '';
  const [name, domain] = value.split('@');
  if (!domain) return value ? '已配置' : '未配置';
  return `${name.slice(0, 2)}***@${domain}`;
}

async function lockedSetting(transaction) {
  let setting = await MonitorNotificationSetting.findByPk(SETTING_ID, {
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });
  if (!setting)
    setting = await MonitorNotificationSetting.create(
      { id: SETTING_ID, enabled: false, recipients: [], sendRecovery: true, version: 1 },
      { transaction }
    );
  return setting;
}

function settingDto(setting) {
  const value = plain(setting);
  return {
    enabled: value.enabled,
    recipients: value.recipients,
    sendRecovery: value.sendRecovery,
    version: value.version,
    smtp: {
      configured: smtpConfigured(),
      reusedFromOrderMailbox: config.smtp.reusedFromImap,
      sender: maskedSender(),
    },
  };
}

/** 读取监控邮件设置，不返回 SMTP 凭据。 @returns {Promise<Object>} 设置 */
async function settings() {
  return await sequelize.transaction(async transaction =>
    settingDto(await lockedSetting(transaction))
  );
}

/** 保存监控邮件设置。 @param {number} actorId 用户ID @param {Object} body 设置 @returns {Promise<Object>} 设置 */
async function saveSettings(actorId, body) {
  p.fields(body, ['enabled', 'recipients', 'sendRecovery', 'expectedVersion']);
  if (
    typeof body.enabled !== 'boolean' ||
    typeof body.sendRecovery !== 'boolean' ||
    !Array.isArray(body.recipients) ||
    body.recipients.length > 20
  )
    throw ApiError.badRequest('通知设置无效');
  const recipients = [...new Set(body.recipients.map(value => String(value).trim().toLowerCase()))];
  if (recipients.some(value => value.length > 254 || !EMAIL.test(value)))
    throw ApiError.badRequest('收件邮箱格式无效');
  if (body.enabled && (!recipients.length || !smtpConfigured()))
    throw ApiError.badRequest('启用通知前需配置收件邮箱和发件邮箱');
  return await sequelize.transaction(async transaction => {
    const setting = await lockedSetting(transaction);
    if (setting.version !== body.expectedVersion)
      throw new ApiError(409, 'CONCURRENT_MODIFICATION', '内容已更新，请刷新后重试');
    await setting.update(
      {
        enabled: body.enabled,
        recipients,
        sendRecovery: body.sendRecovery,
        updatedBy: actorId,
        version: setting.version + 1,
      },
      { transaction }
    );
    return settingDto(setting);
  });
}

function nextHour(now) {
  const value = new Date(now);
  value.setMinutes(0, 0, 0);
  value.setHours(value.getHours() + 1);
  return value;
}

function schedule(category, severity, now) {
  if (category === 'test' || category === 'reminder') return now;
  if (category === 'recovery') return new Date(+now + 10 * 60000);
  if (severity === 'critical') return now;
  if (severity === 'warning') return new Date(+now + 10 * 60000);
  return nextHour(now);
}

async function enqueue(payload, sourceKey, transaction, now = new Date()) {
  const setting = await lockedSetting(transaction);
  if (!setting.enabled || !setting.recipients.length) return null;
  if (payload.category === 'recovery' && !setting.sendRecovery) return null;
  const existingEvent = await MonitorNotificationEvent.findOne({
    where: { sourceKey },
    transaction,
  });
  if (existingEvent)
    return MonitorNotificationDelivery.findByPk(existingEvent.deliveryId, { transaction });
  const notBefore = schedule(payload.category, payload.severity, now);
  let delivery = null;
  if (payload.severity !== 'critical')
    delivery = await MonitorNotificationDelivery.findOne({
      where: {
        deviceId: payload.deviceId,
        category: payload.category,
        severity: payload.severity,
        status: 'pending',
      },
      order: [['createdAt', 'ASC']],
      transaction,
      lock: transaction?.LOCK?.UPDATE,
    });
  if (!delivery)
    delivery = await MonitorNotificationDelivery.create(
      {
        id: randomUUID(),
        deviceId: payload.deviceId || null,
        category: payload.category,
        severity: payload.severity,
        status: 'pending',
        notBefore,
        recipientSnapshot: setting.recipients,
      },
      { transaction }
    );
  await MonitorNotificationEvent.findOrCreate({
    where: { sourceKey },
    defaults: { id: randomUUID(), deliveryId: delivery.id, sourceKey, payload },
    transaction,
  });
  return delivery;
}

/** 将首次告警加入邮件队列。 @param {Object} input 告警上下文 @param {Object} transaction 事务 */
async function enqueueAlert(input, transaction) {
  const payload = { ...input, category: 'alert' };
  return await enqueue(payload, `alert:${input.alertId}`, transaction, new Date(input.at));
}

/** 将恢复事件加入邮件队列。 @param {Object} input 恢复上下文 @param {Object} transaction 事务 */
async function enqueueRecovery(input, transaction) {
  const payload = {
    ...input,
    category: 'recovery',
    originalSeverity: input.severity,
    severity: 'info',
  };
  return await enqueue(payload, `recovery:${input.alertId}`, transaction, new Date(input.at));
}

/** 安排人工静默到期提醒。 @param {Object} input 实例上下文 @param {Object} transaction 事务 */
async function enqueueReminder(input, transaction) {
  const payload = { ...input, category: 'reminder', severity: 'warning' };
  return await enqueue(
    payload,
    `reminder:${input.instanceId}:${input.until}`,
    transaction,
    new Date(input.until)
  );
}

/** 创建测试邮件任务。 @returns {Promise<Object>} 投递 */
async function queueTest() {
  return await sequelize.transaction(async transaction => {
    const setting = await lockedSetting(transaction);
    if (!setting.enabled || !setting.recipients.length || !smtpConfigured())
      throw ApiError.badRequest('请先保存并启用有效的邮件通知设置');
    const now = new Date();
    return enqueue(
      {
        category: 'test',
        severity: 'info',
        deviceId: null,
        deviceName: '系统测试',
        title: '服务器监控测试邮件',
        at: now.toISOString(),
      },
      `test:${randomUUID()}`,
      transaction,
      now
    );
  });
}

/** 分页读取投递历史。 @param {number} page 页码 @returns {Promise<Object>} 历史 */
async function history(page = 1) {
  p.integer(page, 1, 100000);
  const result = await MonitorNotificationDelivery.findAndCountAll({
    where: { createdAt: { [Op.gte]: new Date(Date.now() - RETENTION_MS) } },
    limit: 30,
    offset: (page - 1) * 30,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const ids = result.rows.map(row => row.id);
  const events = ids.length
    ? await MonitorNotificationEvent.findAll({ where: { deliveryId: { [Op.in]: ids } } })
    : [];
  return {
    count: result.count,
    page,
    rows: result.rows.map(row => ({
      ...plain(row),
      eventCount: events.filter(event => event.deliveryId === row.id).length,
    })),
  };
}

module.exports = {
  smtpConfigured,
  settings,
  saveSettings,
  enqueueAlert,
  enqueueRecovery,
  enqueueReminder,
  queueTest,
  history,
};
