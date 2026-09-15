const nodemailer = require('nodemailer');
const { Op } = require('sequelize');
const {
  sequelize,
  MonitorNotificationSetting,
  MonitorNotificationDelivery,
  MonitorNotificationEvent,
  MonitorAlert,
  MonitorInstance,
  AosDevice,
} = require('../models');
const { config } = require('../utils/config');
const logger = require('../utils/logger');

const RETRIES_MS = [60000, 5 * 60000, 15 * 60000, 60 * 60000];
let timer = null;
let running = null;
let transporter = null;

const escapeHtml = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

function mailClient() {
  if (!transporter)
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.password },
    });
  return transporter;
}

async function claim(now) {
  return await sequelize.transaction(async transaction => {
    await MonitorNotificationDelivery.update(
      { status: 'pending' },
      {
        where: { status: 'sending', updatedAt: { [Op.lt]: new Date(+now - 5 * 60000) } },
        transaction,
      }
    );
    const row = await MonitorNotificationDelivery.findOne({
      where: { status: 'pending', notBefore: { [Op.lte]: now } },
      order: [
        ['notBefore', 'ASC'],
        ['createdAt', 'ASC'],
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });
    if (!row) return null;
    await row.update({ status: 'sending' }, { transaction });
    return row;
  });
}

async function validEvents(delivery, now) {
  const events = await MonitorNotificationEvent.findAll({
    where: { deliveryId: delivery.id },
    order: [['createdAt', 'ASC']],
  });
  const payloads = events.map(event => event.payload || {});
  const instanceIds = [...new Set(payloads.map(payload => payload.instanceId).filter(Boolean))];
  const alertIds = [...new Set(payloads.map(payload => payload.alertId).filter(Boolean))];
  const [instances, alerts] = await Promise.all([
    instanceIds.length ? MonitorInstance.findAll({ where: { id: { [Op.in]: instanceIds } } }) : [],
    alertIds.length || instanceIds.length
      ? MonitorAlert.findAll({
        where: {
          [Op.or]: [
            ...(alertIds.length ? [{ id: { [Op.in]: alertIds } }] : []),
            ...(instanceIds.length
              ? [{ instanceId: { [Op.in]: instanceIds }, status: 'active' }]
              : []),
          ],
        },
      })
      : [],
  ]);
  const instanceById = new Map(instances.map(instance => [instance.id, instance]));
  const alertById = new Map(alerts.map(alert => [alert.id, alert]));
  const activeInstances = new Set(
    alerts.filter(alert => alert.status === 'active').map(alert => alert.instanceId)
  );
  return payloads.filter(payload => {
    if (payload.category === 'alert') {
      const alert = alertById.get(payload.alertId);
      const instance = instanceById.get(payload.instanceId);
      if (!alert || alert.status !== 'active' || new Date(instance?.handling?.until || 0) > now)
        return false;
    }
    if (payload.category === 'reminder') {
      const instance = instanceById.get(payload.instanceId);
      if (
        !instance ||
        instance.handling?.until !== payload.until ||
        new Date(payload.until) > now ||
        !activeInstances.has(payload.instanceId)
      )
        return false;
    }
    return true;
  });
}

async function content(delivery, events) {
  const device = delivery.deviceId ? await AosDevice.findByPk(delivery.deviceId) : null;
  const deviceName = device?.name || events[0]?.deviceName || '服务器监控';
  const labels = {
    alert: '异常告警',
    recovery: '恢复通知',
    reminder: '静默到期提醒',
    test: '测试邮件',
  };
  const subject = `【${labels[delivery.category]}】${deviceName}${events.length > 1 ? `（${events.length}项）` : ''}`;
  const rows = events.map(item => {
    const summary =
      item.category === 'reminder'
        ? `${item.instanceLabel}：静默已到期，异常仍在持续`
        : `${item.instanceLabel || item.title || '服务器监控'}${item.ruleName ? ` · ${item.ruleName}` : ''}${item.hitCount === undefined ? '' : ` · ${item.hitCount} 次`}`;
    return { summary, at: item.at };
  });
  const base = String(
    process.env.FRONTEND_URL || process.env.AOS_COLLECTOR_PUBLIC_URL || ''
  ).replace(/\/$/, '');
  const link = base ? `${base}/server-monitor` : '';
  const text = [
    subject,
    '',
    ...rows.map(
      row =>
        `${row.summary}（${new Date(row.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}）`
    ),
    '',
    link ? `查看详情：${link}` : '请登录管理网站查看原始日志。',
    '邮件仅包含摘要，原始日志请在网站查看。',
  ].join('\n');
  const html = `<h2>${escapeHtml(subject)}</h2><ul>${rows.map(row => `<li>${escapeHtml(row.summary)}（${escapeHtml(new Date(row.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}）</li>`).join('')}</ul><p>${link ? `<a href="${escapeHtml(link)}">进入服务器监控</a>` : '请登录管理网站查看原始日志。'}</p><p>邮件仅包含摘要，原始日志请在网站查看。</p>`;
  return { subject, text, html };
}

async function processOne(now = new Date()) {
  const delivery = await claim(now);
  if (!delivery) return false;
  try {
    const setting = await MonitorNotificationSetting.findByPk(1);
    if (!setting?.enabled) {
      await delivery.update({ status: 'skipped', lastError: '通知已停用' });
      return true;
    }
    const events = await validEvents(delivery, now);
    if (!events.length) {
      await delivery.update({ status: 'skipped', lastError: '异常已恢复或处于人工静默' });
      return true;
    }
    const message = await content(delivery, events);
    await mailClient().sendMail({
      from: config.smtp.from,
      to: delivery.recipientSnapshot,
      ...message,
    });
    await delivery.update({
      status: 'sent',
      sentAt: new Date(),
      attempts: delivery.attempts + 1,
      lastError: null,
    });
  } catch (error) {
    const attempts = delivery.attempts + 1;
    const retry = RETRIES_MS[attempts - 1];
    await delivery.update({
      attempts,
      status: retry ? 'pending' : 'failed',
      notBefore: retry ? new Date(+now + retry) : delivery.notBefore,
      lastError: String(error.message || error.name).slice(0, 500),
    });
    logger.warn('服务器监控邮件投递失败', {
      deliveryId: delivery.id,
      attempts,
      errorCode: error.code || error.name,
    });
  }
  return true;
}

async function tick() {
  if (running) return running;
  running = (async () => {
    for (let index = 0; index < 20 && (await processOne()); index++);
  })().finally(() => {
    running = null;
  });
  return await running;
}

/** 启动监控邮件发送器。 */
function start() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 15000);
  timer.unref?.();
}

/** 停止监控邮件发送器。 @returns {Promise<void>} 完成 */
async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (running) await running;
  transporter?.close?.();
  transporter = null;
}

module.exports = {
  processOne,
  start,
  stop,
  _setTransporter: value => {
    transporter = value;
  },
};
