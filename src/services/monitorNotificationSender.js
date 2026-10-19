const { randomUUID } = require('crypto');
const nodemailer = require('nodemailer');
const { Op } = require('sequelize');
const {
  sequelize,
  MonitorNotificationSetting: Legacy,
  MonitorNotificationDelivery: Delivery,
  MonitorNotificationEvent: Event,
  MonitorNotificationLink: Link,
  NotificationWorkerState,
} = require('../models');
const { config } = require('../utils/config');
const { decrypt } = require('../utils/fieldEncryption');
const logger = require('../utils/logger');
const service = require('./monitorNotificationService');
const state = require('./monitorNotificationState');
const content = require('./monitorNotificationContent');
const transport = require('./wecomTransport');
const budget = require('./wecomRobotBudget');
const RETRIES_MS = [60000, 300000, 900000, 3600000];
const WECOM_RETRIES_MS = [10000, 30000, 60000];
const LEASE_MS = 120000;
let transporter;
let timer;
let running;

/** 新发送者数据库闸门，旧sender无法领取新任务。 @param {Function} work 事务 @returns {Promise<*>} 结果 */
async function transactionWork(work) {
  try {
    return await sequelize.transaction(async transaction => {
      await sequelize.query("SELECT set_config('app.monitor_sender_generation','2',true)", {
        transaction,
      });
      return await work(transaction);
    });
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
function mailClient() {
  if (!transporter)
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      logger: false,
      debug: false,
    });
  return transporter;
}
async function heartbeat(channel, now, transaction) {
  try {
    await NotificationWorkerState.upsert({ lane: channel, heartbeatAt: now }, { transaction });
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}

async function settleLinks(row, events, status, now, transaction, channel) {
  try {
    if (!['accepted', 'unknown'].includes(status)) return;
    const policy = { ...service.DEFAULT_POLICY, ...channel.policy };
    for (const payload of events) {
      if (!payload.alertId || !['alert', 'summary', 'reminder'].includes(payload.category))
        continue;
      const [link] = await Link.findOrCreate({
        where: { alertId: payload.alertId, channel: row.channel, targetVersion: row.targetVersion },
        defaults: { id: randomUUID(), initialStatus: status, reminderSequence: 0 },
        transaction,
      });
      // SMTP部分接受立即建立关联，即使其他地址继续安全重试。
      const minutes =
        payload.severity === 'critical'
          ? policy.criticalReminderMinutes[Math.min(payload.reminderSequence || 0, 2)]
          : policy.warningReminderMinutes;
      await link.update(
        {
          initialStatus: link.initialStatus === 'accepted' ? 'accepted' : status,
          lastNotifiedAt: now,
          nextReminderAt: row.channel === 'wecom' ? new Date(+now + minutes * 60000) : null,
          reminderSequence: payload.reminderSequence || link.reminderSequence || 0,
        },
        { transaction }
      );
    }
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
async function reapLocked(channel, now, transaction) {
  try {
    const rows = await Delivery.findAll({
      where: { channel: channel.channel, status: 'sending', leaseUntil: { [Op.lte]: now } },
      limit: 100,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });
    for (const row of rows) {
      const status = row.dispatchStartedAt ? 'unknown' : 'pending';
      if (status === 'unknown') {
        const events = await Event.findAll({
          where: { deliveryId: row.id, outcome: 'included' },
          limit: 1000,
          transaction,
        });
        await settleLinks(
          row,
          events.map(event => event.payload),
          status,
          now,
          transaction,
          channel
        );
      }
      await row.update(
        {
          status,
          errorCode: status === 'unknown' ? 'LEASE_UNKNOWN' : null,
          leaseToken: null,
          leaseUntil: null,
          version: row.version + 1,
        },
        { transaction }
      );
    }
    return rows.length;
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 恢复过期租约，已出站保守unknown。 @param {string} channel 通道 @param {Date} now 时间 @returns {Promise<number>} 数量 */
async function reap(channel, now = new Date()) {
  try {
    return await transactionWork(async transaction =>
      reapLocked(await service.lockedChannel(channel, transaction), now, transaction)
    );
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 领取一条，有界租约恢复。 @param {string} channel 通道 @param {Date} now 时间 @returns {Promise<Object|null>} 任务 */
async function claim(channel, now = new Date()) {
  try {
    return await transactionWork(async transaction => {
      const setting = await service.lockedChannel(channel, transaction);
      if (setting.senderGeneration !== 2) throw new Error('MONITOR_SENDER_GENERATION');
      await heartbeat(channel, now, transaction);
      await reapLocked(setting, now, transaction);
      if (setting.pausedReason) return null;
      const row = await Delivery.findOne({
        where: { channel, status: 'pending', notBefore: { [Op.lte]: now } },
        order: [
          ['priority', 'DESC'],
          ['notBefore', 'ASC'],
          ['id', 'ASC'],
        ],
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });
      if (!row) return null;
      await row.update(
        {
          status: 'sending',
          leaseToken: randomUUID(),
          leaseUntil: new Date(+now + LEASE_MS),
          dispatchStartedAt: null,
          version: row.version + 1,
        },
        { transaction }
      );
      return row;
    });
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
function validScope(setting, row) {
  return (
    setting.targetVersion === row.targetVersion &&
    setting.policyVersion === row.policyVersion &&
    !setting.pausedReason &&
    (row.category === 'test' || setting.enabled) &&
    (row.category !== 'recovery' || setting.sendRecovery)
  );
}
/** 临出站原子校验并标记，事务外才允许发送。 @param {Object} row 领取任务 @param {Date} now 时间 @returns {Promise<Object|null>} 授权 */
async function authorize(row, now = new Date()) {
  try {
    return await transactionWork(async transaction => {
      const setting = await service.lockedChannel(row.channel, transaction);
      const legacy =
        row.channel === 'email'
          ? await Legacy.findByPk(1, { transaction, lock: transaction.LOCK.UPDATE })
          : null;
      const current = await Delivery.findByPk(row.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        !current ||
        current.status !== 'sending' ||
        current.leaseToken !== row.leaseToken ||
        current.dispatchStartedAt ||
        +new Date(current.leaseUntil) <= +now
      )
        return null;
      let reason = !validScope(setting, current) ? 'SCOPE_CHANGED' : null;
      if (row.channel === 'email') {
        const recipients = values => JSON.stringify([...(values || [])].sort());
        if (
          recipients(current.recipientSnapshot) !== recipients(setting.recipients) ||
          recipients(current.recipientSnapshot) !== recipients(legacy?.recipients) ||
          (current.category !== 'test' &&
            (!legacy?.enabled || (current.category === 'recovery' && !legacy.sendRecovery)))
        )
          reason = 'LEGACY_SETTINGS_CHANGED';
      }
      let events = [];
      if (!reason) events = await state.validEvents(current, now, transaction);
      if (
        !reason &&
        !events.length &&
        current.category === 'recovery' &&
        +new Date(current.expiresAt) > +now
      ) {
        const candidates = await sequelize.query(
          "SELECT 1 FROM monitor_notification_events e JOIN monitor_alerts a ON a.id::text=e.payload->>'alertId' JOIN monitor_instances i ON i.id=a.instance_id JOIN monitor_rules r ON r.id=a.rule_id WHERE e.delivery_id=:id AND a.status='recovered' AND i.active AND r.version=a.rule_version AND r.config->>'enabled'='true' AND NOT EXISTS(SELECT 1 FROM monitor_alerts active WHERE active.instance_id=a.instance_id AND active.rule_id=a.rule_id AND active.status='active') LIMIT 1",
          {
            replacements: { id: current.id },
            type: require('sequelize').QueryTypes.SELECT,
            transaction,
          }
        );
        if (candidates.length) {
          await current.update(
            {
              status: 'pending',
              notBefore: new Date(+now + 30000),
              waitReason: 'RECOVERY_OBSERVING',
              leaseToken: null,
              leaseUntil: null,
              version: current.version + 1,
            },
            { transaction }
          );
          return null;
        }
      }
      if (!events.length && !reason) reason = 'EVENT_NO_LONGER_VALID';
      if (+new Date(current.expiresAt) <= +now) reason = 'MESSAGE_EXPIRED';
      if (reason) {
        await current.update(
          { status: 'skipped', errorCode: reason, completedAt: now, version: current.version + 1 },
          { transaction }
        );
        await Event.update(
          { outcome: 'suppressed' },
          { where: { deliveryId: current.id }, transaction }
        );
        if (
          reason === 'MESSAGE_EXPIRED' &&
          current.channel === 'wecom' &&
          current.category !== 'recovery' &&
          events.length
        ) {
          // 旧内容取消，每十分钟最多一份服务恢复摘要；保持全部关联事实。
          const key = `restart:${Math.floor(+now / 600000)}`;
          const previous = await Event.findOne({
            where: {
              channel: 'wecom',
              targetVersion: setting.targetVersion,
              eventKey: { [Op.like]: `${key}:%` },
            },
            order: [['createdAt', 'ASC']],
            transaction,
          });
          let summary = previous
            ? await Delivery.findByPk(previous.deliveryId, { transaction })
            : null;
          // 一个恢复窗口已出站的摘要不再追加；其余旧事件显式留站内为suppressed。
          if (summary && summary.status !== 'pending') return null;
          for (const [index, event] of events.entries()) {
            const queued = await service.enqueueForChannel(
              setting,
              { ...event, category: 'summary' },
              `${key}:${event.alertId || index}`,
              transaction,
              now
            );
            if (!summary) summary = queued;
            else if (queued && queued.id !== summary.id) {
              await Event.update(
                { deliveryId: summary.id },
                { where: { deliveryId: queued.id }, transaction }
              );
              await queued.update(
                { status: 'skipped', errorCode: 'MERGED_CURRENT_SUMMARY', completedAt: now },
                { transaction }
              );
            }
          }
        }
        return null;
      }
      const message = content.build(current, events);
      if (current.category === 'recovery') {
        // 同批恢复各自完成连续观察，尚未成熟的事实移交新批次，不能随已成熟项被suppressed。
        const includedIds = events.map(event => event.notificationEventId);
        const deferred = await sequelize.query(
          "SELECT e.id FROM monitor_notification_events e JOIN monitor_alerts a ON a.id::text=e.payload->>'alertId' JOIN monitor_instances i ON i.id=a.instance_id JOIN monitor_rules r ON r.id=a.rule_id WHERE e.delivery_id=:deliveryId AND e.id NOT IN (:ids) AND a.status='recovered' AND i.active AND r.version=a.rule_version AND r.config->>'enabled'='true' AND NOT EXISTS(SELECT 1 FROM monitor_alerts active WHERE active.instance_id=a.instance_id AND active.rule_id=a.rule_id AND active.status='active') LIMIT 1000",
          {
            replacements: { deliveryId: current.id, ids: includedIds },
            type: require('sequelize').QueryTypes.SELECT,
            transaction,
          }
        );
        if (deferred.length) {
          const batch = await Delivery.create(
            {
              id: randomUUID(),
              channel: current.channel,
              targetVersion: current.targetVersion,
              policyVersion: current.policyVersion,
              targetName: current.targetName,
              deviceId: current.deviceId,
              category: 'recovery',
              severity: current.severity,
              status: 'pending',
              notBefore: new Date(+now + 30000),
              recipientSnapshot: current.recipientSnapshot,
              recipientResults: {},
              attempts: 0,
              priority: current.priority,
              version: 1,
              expiresAt: current.expiresAt,
            },
            { transaction }
          );
          await Event.update(
            { deliveryId: batch.id },
            { where: { id: { [Op.in]: deferred.map(item => item.id) } }, transaction }
          );
        }
      }
      let webhook;
      if (row.channel === 'wecom') {
        webhook = decrypt(setting.webhookCipher);
        const reserved = await budget.reserve(webhook, 'monitor', transaction, now);
        if (!reserved.allowed) {
          await current.update(
            {
              status: 'pending',
              notBefore: reserved.retryAt,
              waitReason: 'ROBOT_BUDGET',
              leaseToken: null,
              leaseUntil: null,
              version: current.version + 1,
            },
            { transaction }
          );
          return null;
        }
      }
      await Event.update(
        { outcome: 'suppressed' },
        { where: { deliveryId: current.id }, transaction }
      );
      await Event.update(
        { outcome: 'included' },
        { where: { id: { [Op.in]: events.map(event => event.notificationEventId) } }, transaction }
      );
      await current.update(
        {
          dispatchStartedAt: now,
          attempts: current.attempts + 1,
          waitReason: null,
          version: current.version + 1,
        },
        { transaction }
      );
      row.attempts = current.attempts;
      return {
        message,
        webhook,
        events,
        recipients: current.recipientSnapshot.filter(
          email =>
            !['accepted', 'unknown', 'failed'].includes(current.recipientResults?.[email]?.status)
        ),
        attempts: current.attempts,
        targetVersion: setting.targetVersion,
      };
    });
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** SMTP回执分类，部分接受逐地址保存。 @param {Object} response Nodemailer回执 @param {Object} error 异常 @param {string[]} recipients 本次地址 @returns {Object} 状态 */
function mailResult(response, error, recipients) {
  const result = {};
  const accepted = new Set(
    (response?.accepted || error?.accepted || []).map(value => String(value).toLowerCase())
  );
  const rejected = new Set(
    (response?.rejected || error?.rejected || []).map(value => String(value).toLowerCase())
  );
  const code = Number(error?.responseCode);
  const safeTemporary =
    ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error?.code) || (code >= 400 && code < 500);
  const permanent = code >= 500 || ['EAUTH', 'EENVELOPE'].includes(error?.code);
  for (const email of recipients) {
    const rejectedError = response?.rejectedErrors?.find(
      item => String(item.recipient).toLowerCase() === email
    );
    const rejectedCode = Number(rejectedError?.responseCode || code);
    const status = accepted.has(email)
      ? 'accepted'
      : rejected.has(email)
        ? rejectedCode >= 400 && rejectedCode < 500
          ? 'pending'
          : 'failed'
        : error
          ? safeTemporary
            ? 'pending'
            : permanent
              ? 'failed'
              : 'unknown'
          : 'unknown';
    result[email] = {
      status,
      errorCode:
        status === 'accepted'
          ? null
          : status === 'unknown'
            ? 'SMTP_RESULT_UNKNOWN'
            : status === 'pending'
              ? 'SMTP_TEMPORARY_REJECTED'
              : 'SMTP_REJECTED',
    };
  }
  return {
    recipientResults: result,
    pause: error?.code === 'EAUTH' || code === 535,
    errorCode: error
      ? safeTemporary
        ? 'SMTP_TEMPORARY_REJECTED'
        : permanent
          ? 'SMTP_REJECTED'
          : 'SMTP_RESULT_UNKNOWN'
      : null,
  };
}
/** 以租约令牌回写，迟到worker不可覆盖新状态。 @param {Object} row 任务 @param {Object} result 脱敏回执 @param {Date} now 时间 @returns {Promise<void>} 完成 */
async function finish(row, result, now = new Date()) {
  try {
    const paused = await transactionWork(async transaction => {
      const setting = await service.lockedChannel(row.channel, transaction);
      const current = await Delivery.findByPk(row.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!current || current.status !== 'sending' || current.leaseToken !== row.leaseToken) return;
      const events = await Event.findAll({
        where: { deliveryId: row.id, outcome: 'included' },
        transaction,
        limit: 1000,
      });
      let status = result.status;
      const results = { ...current.recipientResults };
      if (row.channel === 'email') {
        for (const [email, outcome] of Object.entries(result.recipientResults || {}))
          results[email] = { ...outcome, attempts: (results[email]?.attempts || 0) + 1 };
        for (const item of Object.values(results))
          if (item.status === 'pending' && current.attempts >= 5) item.status = 'failed';
        const statuses = Object.values(results).map(item => item.status);
        status = statuses.includes('pending')
          ? 'pending'
          : statuses.includes('unknown')
            ? 'unknown'
            : statuses.includes('failed')
              ? 'failed'
              : 'accepted';
      } else if (status === 'pending' && current.attempts >= 4) status = 'failed';
      if (status === 'pending' && !validScope(setting, current)) status = 'skipped';
      const retry =
        row.channel === 'email'
          ? RETRIES_MS[Math.min(current.attempts - 1, 3)]
          : result.errorCode === 'RATE_LIMITED'
            ? 60000
            : WECOM_RETRIES_MS[Math.min(current.attempts - 1, 2)];
      const linkedStatus =
        row.channel === 'email'
          ? Object.values(results).some(item => item.status === 'accepted')
            ? 'accepted'
            : Object.values(results).some(item => item.status === 'unknown')
              ? 'unknown'
              : status
          : status;
      await settleLinks(
        current,
        events.map(event => event.payload),
        linkedStatus,
        now,
        transaction,
        setting
      );
      await current.update(
        {
          status,
          recipientResults: results,
          errorCode:
            result.errorCode || (status === 'failed' ? 'PARTIAL_OR_RETRY_EXHAUSTED' : null),
          lastError: null,
          sentAt: linkedStatus === 'accepted' ? now : current.sentAt,
          notBefore: status === 'pending' ? new Date(+now + retry) : current.notBefore,
          dispatchStartedAt: status === 'pending' ? null : current.dispatchStartedAt,
          leaseToken: null,
          leaseUntil: null,
          completedAt: ['accepted', 'failed', 'skipped'].includes(status) ? now : null,
          version: current.version + 1,
        },
        { transaction }
      );
      if (linkedStatus === 'accepted')
        await setting.update({ lastAcceptedAt: now }, { transaction });
      if (current.category === 'test' && current.targetVersion === setting.targetVersion)
        await setting.update(
          { lastTest: { status, at: now.toISOString(), deliveryId: current.id } },
          { transaction }
        );
      if (result.pause && current.targetVersion === setting.targetVersion)
        await setting.update({ pausedReason: result.errorCode }, { transaction });
      await NotificationWorkerState.upsert(
        {
          lane: row.channel,
          heartbeatAt: now,
          lastSuccessAt: linkedStatus === 'accepted' ? now : undefined,
          errorCode: result.errorCode || null,
        },
        { transaction }
      );
      return result.pause && current.targetVersion === setting.targetVersion
        ? { targetVersion: current.targetVersion, errorCode: result.errorCode }
        : null;
    });
    if (paused) {
      // 独立事务按固定通道顺序取锁，防止与事件入队形成反向死锁。
      await sequelize.transaction(async transaction => {
        const email = await service.lockedChannel('email', transaction);
        const wecom = await service.lockedChannel('wecom', transaction);
        const source = row.channel === 'wecom' ? wecom : email;
        if (
          source.targetVersion !== paused.targetVersion ||
          source.pausedReason !== paused.errorCode
        )
          return;
        const other = row.channel === 'wecom' ? email : wecom;
        if (other.enabled && !other.pausedReason)
          await service.enqueueForChannel(
            other,
            {
              category: 'summary',
              severity: 'critical',
              systemNotice: true,
              title: `${row.channel === 'wecom' ? '企业微信' : '邮件'}监控通道因目标明确拒绝已暂停，请到网站检查通知设置。错误码：${result.errorCode}`,
              at: now,
            },
            `channel-failure:${row.channel}:${row.targetVersion}`,
            transaction,
            now
          );
      });
    }
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 单次发送，测试显式注入传输；默认只处理email兼容调用。 @param {Date} now 时间 @param {Object} options 依赖 @returns {Promise<boolean>} 是否领取 */
async function processOne(now = new Date(), options = {}) {
  let row;
  try {
    row = await claim(options.channel || 'email', now);
    if (!row) return false;
    const authorization = await authorize(row, now);
    if (!authorization) return true;
    let result;
    if (row.channel === 'wecom') {
      try {
        result = await (options.send || transport.sendText)(
          authorization.webhook,
          authorization.message.text
        );
      } catch (_error) {
        result = { status: 'unknown', errorCode: 'TRANSPORT_UNKNOWN' };
      }
    } else {
      let response, error;
      try {
        response = await (options.mailClient || mailClient()).sendMail({
          from: config.smtp.from,
          to: authorization.recipients,
          ...authorization.message,
        });
      } catch (caught) {
        error = caught;
      }
      result = mailResult(response, error, authorization.recipients);
    }
    await finish(row, result, now);
    return true;
  } catch (error) {
    logger.error('监控通知单次执行失败', {
      deliveryId: row?.id,
      errorCode: error.code || error.name,
    });
    throw error;
  }
}
/** 兼容启动，独立worker使用processOne双lane。 */
function start() {
  if (timer) return;
  const tick = () => {
    if (!running)
      running = processOne()
        .catch(error => logger.error('监控邮件执行失败', { errorCode: error.code || error.name }))
        .finally(() => {
          running = null;
        });
  };
  tick();
  timer = setInterval(tick, 1000);
  timer.unref?.();
}
/** 停止并等待在途。 @returns {Promise<void>} 完成 */
async function stop() {
  try {
    clearInterval(timer);
    timer = null;
    if (running) await running;
    transporter?.close?.();
    transporter = null;
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
module.exports = {
  processOne,
  claim,
  authorize,
  finish,
  reap,
  transactionWork,
  mailResult,
  start,
  stop,
  _setTransporter: value => {
    transporter = value;
  },
};
