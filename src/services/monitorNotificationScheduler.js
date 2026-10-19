const { Op } = require('sequelize');
const {
  sequelize,
  MonitorNotificationLink: Link,
  MonitorNotificationDelivery: Delivery,
  MonitorNotificationEvent: Event,
  MonitorAlert,
  MonitorInstance,
  NotificationWorkerState,
} = require('../models');
const service = require('./monitorNotificationService');

/** 持久化提醒／晚回执恢复／可选每日09点摘要，最多100个关联/轮。 @param {Date} now 时间 @returns {Promise<Object>} 调度量 */
async function scheduleTick(now = new Date()) {
  try {
    return await sequelize.transaction(async transaction => {
      const result = { reminders: 0, recoveries: 0, daily: 0 };
      for (const channel of ['email', 'wecom']) {
        const setting = await service.lockedChannel(channel, transaction);
        if (!setting.enabled || setting.pausedReason) continue;
        const links = await Link.findAll({
          where: {
            channel,
            targetVersion: setting.targetVersion,
            initialStatus: { [Op.in]: ['accepted', 'unknown'] },
            [Op.or]: [{ nextReminderAt: { [Op.lte]: now } }, { recoveryQueuedAt: null, alertId: { [Op.in]: sequelize.literal("(SELECT id FROM monitor_alerts WHERE status='recovered')") } }],
          },
          order: [['updatedAt', 'ASC']],
          limit: 100,
          lock: transaction.LOCK.UPDATE,
          skipLocked: true,
          transaction,
        });
        const alerts = links.length
          ? await MonitorAlert.findAll({
            where: { id: { [Op.in]: links.map(item => item.alertId) } },
            attributes: { exclude: ['samples'] },
            transaction,
          })
          : [];
        const instances = alerts.length
          ? await MonitorInstance.findAll({
            where: { id: { [Op.in]: [...new Set(alerts.map(item => item.instanceId))] } },
            transaction,
          })
          : [];
        for (const link of links) {
          const alert = alerts.find(item => item.id === link.alertId);
          const instance = instances.find(item => item.id === alert?.instanceId);
          if (!alert || !instance) continue;
          const payload = {
            alertId: alert.id,
            instanceId: instance.id,
            deviceId: instance.deviceId,
            instanceLabel: instance.label,
            ruleName: alert.ruleName,
            severity: alert.severity,
            hitCount: alert.hitCount,
            at: alert.lastSeenAt,
          };
          if (alert.status === 'recovered' && !link.recoveryQueuedAt && setting.sendRecovery) {
            await service.enqueueForChannel(
              setting,
              {
                ...payload,
                category: 'recovery',
                originalSeverity: alert.severity,
                severity: 'info',
                at: alert.recoveredAt,
              },
              `recovery:${alert.id}`,
              transaction,
              new Date(alert.recoveredAt)
            );
            await link.update({ recoveryQueuedAt: now, nextReminderAt: null }, { transaction });
            result.recoveries++;
          } else if (
            channel === 'wecom' &&
            alert.status === 'active' &&
            link.nextReminderAt &&
            +new Date(link.nextReminderAt) <= +now
          ) {
            const policy = { ...service.DEFAULT_POLICY, ...setting.policy };
            const sequence = link.reminderSequence + 1;
            const minutes =
              alert.severity === 'critical'
                ? policy.criticalReminderMinutes[Math.min(sequence, 2)]
                : policy.warningReminderMinutes;
            const silent = +new Date(instance.handling?.until || 0) > +now;
            if (!silent) {
              // 到期静默和周期提醒使用同一轮持久键，出站前继续校验新鲜状态。
              const pending = await Event.findOne({
                where: {
                  channel,
                  targetVersion: setting.targetVersion,
                  'payload.alertId': alert.id,
                  'payload.category': 'reminder',
                },
                include: [
                  {
                    model: Delivery,
                    as: 'delivery',
                    where: { status: { [Op.in]: ['pending', 'sending'] } },
                  },
                ],
                transaction,
              });
              if (!pending) {
                await service.enqueueForChannel(
                  setting,
                  {
                    ...payload,
                    category: 'reminder',
                    reminderSequence: sequence,
                    originalUnknown: link.initialStatus === 'unknown',
                  },
                  `periodic:${alert.id}:${sequence}`,
                  transaction,
                  now
                );
                result.reminders++;
              }
            }
            await link.update(
              {
                reminderSequence: silent ? link.reminderSequence : sequence,
                nextReminderAt: silent
                  ? new Date(instance.handling.until)
                  : new Date(+now + minutes * 60000),
              },
              { transaction }
            );
          }
        }
        const policy = { ...service.DEFAULT_POLICY, ...setting.policy };
        const beijing = new Date(+now + 8 * 3600000);
        if (channel === 'wecom' && policy.dailySummaryEnabled && beijing.getUTCHours() === 9) {
          const day = beijing.toISOString().slice(0, 10);
          const [active, fresh, recovered, unresolved] = await Promise.all([
            MonitorAlert.count({ where: { status: 'active' }, transaction }),
            MonitorAlert.count({
              where: { createdAt: { [Op.gte]: new Date(+now - 86400000) } },
              transaction,
            }),
            MonitorAlert.count({
              where: { recoveredAt: { [Op.gte]: new Date(+now - 86400000) } },
              transaction,
            }),
            Delivery.count({ where: { status: { [Op.in]: ['failed', 'unknown'] } }, transaction }),
          ]);
          const offline = await MonitorInstance.count({
            where: {
              active: true,
              [Op.or]: [{ observedAt: null }, { observedAt: { [Op.lt]: new Date(+now - 180000) } }],
            },
            transaction,
          });
          await service.enqueueForChannel(
            setting,
            {
              category: 'daily',
              severity: 'info',
              title: `24小时新异常${fresh}，恢复${recovered}，当前未解除${active}，失联或未知实例${offline}，失败未知投递${unresolved}`,
              at: now,
            },
            `daily:${day}`,
            transaction,
            now
          );
          result.daily++;
        }
      }
      await NotificationWorkerState.upsert(
        {
          lane: 'scheduler',
          heartbeatAt: now,
          lastSuccessAt: now,
          errorCode: null,
          details: result,
        },
        { transaction }
      );
      return result;
    });
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
module.exports = { scheduleTick };
