const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  MonitorNotificationDelivery: Delivery,
  MonitorNotificationEvent: Event,
  NotificationWorkerState,
} = require('../models');
const ApiError = require('../utils/ApiError');
const p = require('./monitorPolicy');
const service = require('./monitorNotificationService');
const state = require('./monitorNotificationState');
const content = require('./monitorNotificationContent');

function deliveryDto(row, events = []) {
  const value = row.toJSON ? row.toJSON() : row;
  return {
    id: value.id,
    channel: value.channel,
    targetName: value.targetName,
    targetVersion: value.targetVersion,
    category: value.category,
    severity: value.severity,
    status: value.status === 'sent' ? 'accepted' : value.status,
    notBefore: value.notBefore,
    attempts: value.attempts,
    errorCode: value.errorCode,
    lastError: value.lastError,
    sentAt: value.sentAt,
    createdAt: value.createdAt,
    version: value.version,
    eventCount: events.length,
    eventIds: [...new Set(events.map(event => event.payload?.alertId).filter(Boolean))],
    waitReason: value.waitReason,
    recipientResults: value.recipientResults,
  };
}
/** 游标分页，无原文，最多100项。 @param {Object} query 查询 @returns {Promise<Object>} 页面 */
async function deliveries(query = {}) {
  try {
    p.fields(query, [
      'channel',
      'status',
      'deviceId',
      'eventId',
      'dateFrom',
      'dateTo',
      'cursor',
      'limit',
    ]);
    const limit = Number(query.limit || 30);
    p.integer(limit, 1, 100);
    const where = {};
    if (query.channel) {
      if (!['email', 'wecom'].includes(query.channel)) throw ApiError.badRequest('通道无效');
      where.channel = query.channel;
    }
    if (query.status) {
      if (
        !['pending', 'sending', 'accepted', 'unknown', 'failed', 'skipped'].includes(query.status)
      )
        throw ApiError.badRequest('状态无效');
      where.status = query.status;
    }
    if (query.deviceId) {
      p.uuid(query.deviceId);
      where.deviceId = query.deviceId;
    }
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      for (const [key, op] of [
        ['dateFrom', Op.gte],
        ['dateTo', Op.lt],
      ])
        if (query[key]) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(query[key])) throw ApiError.badRequest('日期无效');
          const date = new Date(`${query[key]}T00:00:00+08:00`);
          if (!Number.isFinite(+date) || new Date(+date + 28800000).toISOString().slice(0, 10) !== query[key]) throw ApiError.badRequest('日期无效');
          where.createdAt[op] = key === 'dateTo' ? new Date(+date + 86400000) : date;
        }
      if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) throw ApiError.badRequest('开始日期不能晚于结束日期');
    }
    if (query.cursor) {
      try {
        if (query.cursor.length > 300) throw new Error();
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        p.uuid(cursor.id);
        const at = new Date(cursor.at);
        if (!Number.isFinite(+at)) throw new Error();
        where[Op.or] = [
          { createdAt: { [Op.lt]: at } },
          { createdAt: at, id: { [Op.lt]: cursor.id } },
        ];
      } catch (_error) {
        throw ApiError.badRequest('游标无效');
      }
    }
    if (query.eventId) {
      p.uuid(query.eventId);
      where.id = {
        [Op.in]: sequelize.literal(
          `(SELECT delivery_id FROM monitor_notification_events WHERE payload->>'alertId'=${sequelize.escape(query.eventId)})`
        ),
      };
    }
    const rows = await Delivery.findAll({
      where,
      limit: limit + 1,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    const page = rows.slice(0, limit);
    const stats = page.length ? await sequelize.query('SELECT delivery_id, count(*)::int AS event_count, (array_agg(DISTINCT payload->>\'alertId\') FILTER(WHERE payload->>\'alertId\' IS NOT NULL))[1:100] AS event_ids FROM monitor_notification_events WHERE delivery_id IN (:ids) GROUP BY delivery_id', { replacements: { ids: page.map(row => row.id) }, type: require('sequelize').QueryTypes.SELECT }) : [];
    const last = page.at(-1);
    return {
      rows: page.map(row => { const stat = stats.find(item => item.delivery_id === row.id); return { ...deliveryDto(row), eventCount: stat?.event_count || 0, eventIds: stat?.event_ids || [] }; }),
      nextCursor:
        rows.length > limit
          ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString('base64url')
          : null,
    };
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 安全投递详情与同告警跨通道结果。 @param {string} id UUID @returns {Promise<Object>} DTO */
async function detail(id) {
  try {
    p.uuid(id);
    const row = await Delivery.findByPk(id);
    if (!row) throw ApiError.notFound();
    const events = await Event.findAll({ where: { deliveryId: id }, limit: 1000 });
    const ids = events.map(item => item.payload?.alertId).filter(Boolean);
    const related = ids.length
      ? await Delivery.findAll({
        where: {
          id: {
            [Op.in]: sequelize.literal(
              `(SELECT delivery_id FROM monitor_notification_events WHERE payload->>'alertId' IN (${ids.map(value => sequelize.escape(value)).join(',')}))`
            ),
          },
        },
        order: [['createdAt', 'DESC']],
        limit: 100,
      })
      : [];
    return {
      ...deliveryDto(row, events),
      events: events.map(({ payload }) => ({
        eventId: payload.alertId || null,
        category: payload.category,
        at: payload.at,
        instanceLabel: content.safeName(payload.instanceLabel),
        ruleName: content.safeName(payload.ruleName),
        hitCount: payload.hitCount,
        originalUnknown: Boolean(payload.originalUnknown),
      })),
      relatedDeliveries: related.map(item => deliveryDto(item)),
    };
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 版本保护人工操作。 @param {number} actor 用户 @param {string} id UUID @param {Object} body 输入 @param {boolean} cancel 取消 @returns {Promise<Object>} DTO */
async function mutate(actor, id, body, cancel = false) {
  try {
    p.uuid(id);
    p.fields(
      body,
      cancel ? ['expectedVersion', 'reason'] : ['expectedVersion', 'acknowledgeUnknown']
    );
    const found = await Delivery.findByPk(id);
    if (!found) throw ApiError.notFound();
    return await sequelize.transaction(async transaction => {
      const channel = await service.lockedChannel(found.channel, transaction);
      const row = await Delivery.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (row.version !== body.expectedVersion) throw service.conflict();
      if (cancel) {
        if (!['pending', 'sending'].includes(row.status) || row.dispatchStartedAt)
          throw service.scopeError();
        if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 200)
          throw ApiError.badRequest('请输入200字内取消原因');
        await row.update(
          {
            status: 'skipped',
            errorCode: 'MANUAL_CANCEL',
            completedAt: new Date(),
            cancelledBy: actor,
            cancelReason: content.safeName(body.reason),
            version: row.version + 1,
          },
          { transaction }
        );
      } else {
        if (
          !['failed', 'unknown'].includes(row.status) ||
          row.targetVersion !== channel.targetVersion ||
          (!channel.enabled && row.category !== 'test') ||
          channel.pausedReason
        )
          throw service.scopeError();
        if (row.status === 'unknown' && body.acknowledgeUnknown !== true)
          throw ApiError.badRequest(
            '请先确认重试可能导致重复通知',
            undefined,
            'UNKNOWN_ACK_REQUIRED'
          );
        const valid = await state.validEvents(row, new Date(), transaction);
        if (!valid.length) throw service.scopeError();
        // 已接受地址不再重发；unknown地址只在人工确认后重新登记。
        const results = { ...row.recipientResults };
        for (const [email, result] of Object.entries(results))
          if (result.status !== 'accepted')
            results[email] = { status: 'pending', attempts: result.attempts || 0 };
        await row.update(
          {
            status: 'pending',
            notBefore: new Date(),
            expiresAt: new Date(Date.now() + (row.channel === 'email' ? 86400000 : 600000)),
            recipientResults: results,
            dispatchStartedAt: null,
            leaseToken: null,
            leaseUntil: null,
            errorCode: null,
            waitReason: null,
            completedAt: null,
            version: row.version + 1,
          },
          { transaction }
        );
      }
      return deliveryDto(row);
    });
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 当前异常只读预览或幂等入队。 @param {string} channel 通道 @param {Object} body 输入 @param {Date} now 时间 @returns {Promise<Object>} 结果 */
async function currentSummary(channel, body, now = new Date()) {
  try {
    p.fields(body, ['preview', 'requestKey', 'expectedVersion']);
    if (typeof body.preview !== 'boolean') throw ApiError.badRequest('请选择预览或发送');
    if (!body.preview) p.uuid(body.requestKey);
    await service.lockedChannel(channel);
    const payloads = await sequelize.query('SELECT \'summary\' AS category,a.id AS "alertId",i.id AS "instanceId",i.device_id AS "deviceId",d.name AS "deviceName",i.label AS "instanceLabel",a.rule_name AS "ruleName",a.severity,a.hit_count AS "hitCount",a.last_seen_at AS at,a.first_seen_at AS "firstSeenAt" FROM monitor_alerts a JOIN monitor_instances i ON i.id=a.instance_id JOIN aos_devices d ON d.id=i.device_id JOIN monitor_rules r ON r.id=a.rule_id WHERE a.status=\'active\' AND i.active AND d.enabled AND r.config->>\'enabled\'=\'true\' AND r.version=a.rule_version AND i.snapshot->>\'state\'=\'ready\' AND i.observed_at BETWEEN :fresh AND :future AND d.heartbeat_at>=:heartbeat AND (i.handling->>\'until\' IS NULL OR i.handling->>\'until\'<=:nowText) ORDER BY CASE a.severity WHEN \'critical\' THEN 0 WHEN \'warning\' THEN 1 ELSE 2 END,a.first_seen_at LIMIT 1000', { replacements: { fresh: new Date(+now - 120000), future: new Date(+now + 30000), heartbeat: new Date(+now - 180000), nowText: now.toISOString() }, type: require('sequelize').QueryTypes.SELECT });
    if (body.preview)
      return {
        preview: {
          text: content.build({ category: 'summary' }, payloads).text,
          eventCount: payloads.length,
        },
      };
    return await sequelize.transaction(async transaction => {
      const row = await service.lockedChannel(channel, transaction);
      if (row.version !== body.expectedVersion) throw service.conflict();
      if (!row.enabled || row.pausedReason) throw service.scopeError();
      if (!payloads.length) return { deliveryId: null, status: 'skipped', eventCount: 0 };
      const key = `summary:${body.requestKey}`;
      const existing = await Event.findOne({
        where: { sourceKey: `${channel}:${row.targetVersion}:${key}:0` },
        transaction,
      });
      if (existing) {
        const batch = await Delivery.findByPk(existing.deliveryId, { transaction });
        return {
          deliveryId: batch.id,
          status: batch.status,
          eventCount: await Event.count({ where: { deliveryId: batch.id }, transaction }),
        };
      }
      let first;
      for (let index = 0; index < payloads.length; index++) {
        if (!first)
          first = await service.enqueueForChannel(
            row,
            payloads[index],
            `${key}:${index}`,
            transaction,
            now
          );
        else
          await Event.create(
            {
              id: randomUUID(),
              deliveryId: first.id,
              sourceKey: `${channel}:${row.targetVersion}:${key}:${index}`,
              eventKey: `${key}:${index}`,
              channel,
              targetVersion: row.targetVersion,
              payload: payloads[index],
              outcome: 'pending',
            },
            { transaction }
          );
      }
      return { deliveryId: first.id, status: first.status, eventCount: payloads.length };
    });
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 有界聚合两通道健康，不加载日志正文。 @returns {Promise<Object>} 状态 */
async function health() {
  try {
    const [settings, workers, stats] = await Promise.all([
      service.channels(),
      NotificationWorkerState.findAll(),
      sequelize.query(
        'SELECT channel, count(*) FILTER(WHERE status=\'pending\')::int AS pending_count, count(*) FILTER(WHERE status=\'pending\' AND not_before<=now())::int AS overdue_count, min(not_before) FILTER(WHERE status=\'pending\' AND not_before<=now()) AS oldest_due_at, count(*) FILTER(WHERE status=\'failed\')::int AS failed_count, count(*) FILTER(WHERE status=\'unknown\')::int AS unknown_count FROM monitor_notification_deliveries GROUP BY channel',
        { type: require('sequelize').QueryTypes.SELECT }
      ),
    ]);
    return {
      channels: settings.channels.map(row => {
        const stat = stats.find(item => item.channel === row.channel) || {};
        const heartbeatAt = workers.find(item => item.lane === row.channel)?.heartbeatAt || null;
        const heartbeatStale = !heartbeatAt || Date.now() - +new Date(heartbeatAt) > 90000;
        const backlog = stat.oldest_due_at && Date.now() - +new Date(stat.oldest_due_at) > 120000;
        return {
          channel: row.channel,
          heartbeatAt,
          heartbeatStale,
          staleAfterSeconds: 90,
          state: row.pausedReason ? 'paused' : !heartbeatAt ? 'not_started' : heartbeatStale ? 'stale' : backlog ? 'backlog' : 'healthy',
          lastAcceptedAt: row.lastAcceptedAt,
          pausedReason: row.pausedReason,
          pendingCount: stat.pending_count || 0,
          overdueCount: stat.overdue_count || 0,
          oldestDueAt: stat.oldest_due_at || null,
          failedCount: stat.failed_count || 0,
          unknownCount: stat.unknown_count || 0,
        };
      }),
      coverage: { healthEvents: false, noNewLogs: false, externalWatchdog: false },
    };
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/** 旧邮件历史分页兼容。 @param {number} page 页码 @returns {Promise<Object>} 页面 */
async function history(page = 1) {
  try {
    p.integer(page, 1, 100000);
    const result = await Delivery.findAndCountAll({
      where: { channel: 'email' },
      order: [['createdAt', 'DESC']],
      limit: 30,
      offset: (page - 1) * 30,
    });
    return { count: result.count, page, rows: result.rows.map(row => deliveryDto(row)) };
  } catch (error) {
    require('../utils/logger').debug('监控通知操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
module.exports = { deliveries, detail, mutate, currentSummary, health, history, deliveryDto };
