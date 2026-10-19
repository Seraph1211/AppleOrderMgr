const { Op } = require('sequelize');
const {
  MonitorNotificationEvent: Event,
  MonitorNotificationLink: Link,
  MonitorAlert,
  MonitorInstance,
  AosDevice,
  MonitorRule,
} = require('../models');

/** 有界批量复核真实告警／实例／规则／心跳，禁止用陈旧关键词假冒异常。 @param {Object} delivery 批次 @param {Date} now 时间 @param {Object} transaction 事务 @returns {Promise<Object[]>} 有效事件 */
async function validEvents(delivery, now, transaction) {
  try {
    const events = await Event.findAll({
      where: { deliveryId: delivery.id },
      order: [['createdAt', 'ASC']],
      limit: 1001,
      transaction,
    });
    if (events.length > 1000) throw new Error('NOTIFICATION_BATCH_TOO_LARGE');
    const payloads = events.map(event => ({ ...event.payload, notificationEventId: event.id }));
    const instanceIds = [...new Set(payloads.map(item => item.instanceId).filter(Boolean))];
    const ids = [...new Set(payloads.map(item => item.alertId).filter(Boolean))];
    const [instances, alerts] = await Promise.all([
      instanceIds.length
        ? MonitorInstance.findAll({ where: { id: { [Op.in]: instanceIds } }, transaction })
        : [],
      ids.length || instanceIds.length
        ? MonitorAlert.findAll({
          where: {
            [Op.or]: [
              ...(ids.length ? [{ id: { [Op.in]: ids } }] : []),
              ...(instanceIds.length
                ? [{ instanceId: { [Op.in]: instanceIds }, status: 'active' }]
                : []),
            ],
          },
          attributes: { exclude: ['samples'] },
          transaction,
        })
        : [],
    ]);
    const [devices, rules, links] = await Promise.all([
      instances.length
        ? AosDevice.findAll({
          where: { id: { [Op.in]: [...new Set(instances.map(item => item.deviceId))] } },
          attributes: ['id', 'name', 'enabled', 'heartbeatAt'],
          transaction,
        })
        : [],
      alerts.length
        ? MonitorRule.findAll({
          where: { id: { [Op.in]: [...new Set(alerts.map(item => item.ruleId))] } },
          transaction,
        })
        : [],
      delivery.category === 'recovery' && ids.length
        ? Link.findAll({
          where: {
            alertId: { [Op.in]: ids },
            channel: delivery.channel,
            targetVersion: delivery.targetVersion,
          },
          transaction,
        })
        : [],
    ]);
    const instanceById = new Map(instances.map(item => [item.id, item]));
    const alertById = new Map(alerts.map(item => [item.id, item]));
    const deviceById = new Map(devices.map(item => [item.id, item]));
    const ruleById = new Map(rules.map(item => [item.id, item]));
    const valid = [];
    for (const payload of payloads) {
      if (['test', 'daily'].includes(payload.category) || (payload.systemNotice && !payload.alertId)) {
        valid.push(payload);
        continue;
      }
      const instance = instanceById.get(payload.instanceId);
      const device = deviceById.get(instance?.deviceId);
      const alert =
        alertById.get(payload.alertId) ||
        (payload.category === 'reminder' &&
          alerts.find(item => item.instanceId === payload.instanceId && item.status === 'active'));
      const rule = ruleById.get(alert?.ruleId);
      if (
        !instance?.active ||
        !device?.enabled ||
        !rule?.config?.enabled ||
        rule.version !== alert?.ruleVersion
      )
        continue;
      if (new Date(instance.handling?.until || 0) > now) continue;
      if (
        !device.heartbeatAt ||
        +now - +new Date(device.heartbeatAt) > 180000 ||
        +now - +new Date(instance.observedAt || 0) > 120000 ||
        +new Date(instance.observedAt) > +now + 30000 ||
        instance.snapshot?.state !== 'ready'
      )
        continue;
      if (payload.category === 'recovery') {
        const link = links.find(item => item.alertId === payload.alertId);
        const observed = instance.snapshot?.results?.find(item => item.ruleId === alert.ruleId);
        if (
          alert.status !== 'recovered' ||
          !alert.recoveredAt ||
          !['accepted', 'unknown'].includes(link?.initialStatus) ||
          +now - +new Date(alert.recoveredAt) < 120000 ||
          !observed?.clearSince ||
          observed.ruleVersion !== alert.ruleVersion ||
          +now - +new Date(observed.clearSince) < 120000 ||
          +now - +new Date(instance.observedAt) > 90000 ||
          alerts.some(
            item =>
              item.instanceId === instance.id &&
              item.ruleId === alert.ruleId &&
              item.status === 'active'
          )
        )
          continue;
        payload.originalUnknown = link.initialStatus === 'unknown';
      } else if (alert.status !== 'active') continue;
      if (
        payload.until &&
        (instance.handling?.until !== payload.until || new Date(payload.until) > now)
      )
        continue;
      valid.push({
        ...payload,
        alertId: alert.id,
        deviceName: device.name,
        instanceLabel: instance.label,
        ruleName: alert.ruleName,
        hitCount: alert.hitCount,
        firstSeenAt: alert.firstSeenAt,
        at: payload.category === 'recovery' ? alert.recoveredAt : alert.lastSeenAt,
      });
    }
    return valid;
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
module.exports = { validEvents };
