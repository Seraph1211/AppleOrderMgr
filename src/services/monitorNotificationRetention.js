const { sequelize, NotificationWorkerState } = require('../models');
const { QueryTypes } = require('sequelize');
const logger = require('../utils/logger');

/** 独立锁与五秒预算清理终态，保护活动/未知关联；不读取日志正文。 @param {Date} now 时间 @returns {Promise<Object>} 删除数 */
async function cleanup(now = new Date()) {
  const start = Date.now();
  const counts = {};
  try {
    await sequelize.transaction(async transaction => {
      await sequelize.query("SET LOCAL statement_timeout='4500ms'", { transaction });
      const [lock] = await sequelize.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('monitor-notification-retention-v2')) AS locked",
        { type: QueryTypes.SELECT, transaction }
      );
      if (!lock.locked) return;
      const statements = [
        [
          'deliveries',
          'DELETE FROM monitor_notification_deliveries WHERE id IN (SELECT d.id FROM monitor_notification_deliveries d WHERE d.status IN (\'accepted\',\'failed\',\'skipped\') AND d.completed_at < :before AND NOT EXISTS (SELECT 1 FROM monitor_notification_events e JOIN monitor_alerts a ON a.id::text=e.payload->>\'alertId\' WHERE e.delivery_id=d.id AND (a.status=\'active\' OR EXISTS (SELECT 1 FROM monitor_notification_events related JOIN monitor_notification_deliveries unresolved ON unresolved.id=related.delivery_id WHERE related.payload->>\'alertId\'=a.id::text AND unresolved.status IN (\'pending\',\'sending\',\'unknown\')))) ORDER BY d.completed_at LIMIT 1000) RETURNING id',
        ],
        [
          'links',
          'DELETE FROM monitor_notification_links WHERE id IN (SELECT l.id FROM monitor_notification_links l JOIN monitor_alerts a ON a.id=l.alert_id WHERE a.status<>\'active\' AND l.updated_at< :before AND NOT EXISTS(SELECT 1 FROM monitor_notification_events e JOIN monitor_notification_deliveries d ON d.id=e.delivery_id WHERE e.payload->>\'alertId\'=a.id::text AND d.status IN (\'pending\',\'sending\',\'unknown\')) LIMIT 1000) RETURNING id',
        ],
        [
          'alerts',
          'DELETE FROM monitor_alerts WHERE id IN (SELECT a.id FROM monitor_alerts a WHERE a.status<>\'active\' AND a.last_seen_at< :before AND NOT EXISTS(SELECT 1 FROM monitor_notification_links l WHERE l.alert_id=a.id) AND NOT EXISTS(SELECT 1 FROM monitor_notification_events e WHERE e.payload->>\'alertId\'=a.id::text) LIMIT 1000) RETURNING id',
        ],
        [
          'actions',
          'DELETE FROM monitor_actions WHERE id IN (SELECT id FROM monitor_actions WHERE created_at< :before LIMIT 1000) RETURNING id',
        ],
        [
          'traffic',
          'DELETE FROM monitor_traffic WHERE id IN (SELECT id FROM monitor_traffic WHERE ended_at< :before LIMIT 1000) RETURNING id',
        ],
        [
          'instances',
          'UPDATE monitor_instances SET snapshot=\'{}\'::jsonb,handling=\'{}\'::jsonb WHERE id IN (SELECT id FROM monitor_instances WHERE observed_at < :before AND snapshot<>\'{}\'::jsonb LIMIT 1000) RETURNING id',
        ],
        [
          'audits',
          'DELETE FROM operation_logs WHERE id IN (SELECT id FROM operation_logs WHERE created_at< :auditBefore ORDER BY created_at LIMIT 1000) RETURNING id',
        ],
        [
          'orders',
          'DELETE FROM wecom_notification_deliveries WHERE id IN (SELECT id FROM wecom_notification_deliveries WHERE status IN (\'accepted\',\'failed\',\'skipped\') AND updated_at< :before ORDER BY updated_at LIMIT 1000) RETURNING id',
        ],
      ];
      for (const [name, sql] of statements) {
        if (Date.now() - start > 4500) break;
        await sequelize.query(`SET LOCAL statement_timeout='${Math.max(1, 4500 - (Date.now() - start))}ms'`, { transaction });
        const [rows] = await sequelize.query(sql, {
          replacements: {
            before: new Date(+now - 90 * 86400000),
            auditBefore: new Date(+now - 180 * 86400000),
          },
          transaction,
        });
        counts[name] = rows.length;
      }
      const oldest = await sequelize.query(
        "SELECT min(completed_at) AS oldest_remaining_at FROM monitor_notification_deliveries WHERE status IN ('accepted','failed','skipped')",
        { type: QueryTypes.SELECT, transaction }
      );
      await NotificationWorkerState.upsert(
        {
          lane: 'cleanup',
          heartbeatAt: now,
          lastSuccessAt: now,
          details: {
            counts,
            oldestRemainingAt: oldest[0].oldest_remaining_at,
            budgetExhausted: Date.now() - start >= 4500,
          },
        },
        { transaction }
      );
    });
    return counts;
  } catch (error) {
    try {
      await NotificationWorkerState.upsert({ lane: 'cleanup', heartbeatAt: now, errorCode: error.original?.code === '57014' ? 'CLEANUP_BUDGET_EXHAUSTED' : 'CLEANUP_FAILED', details: { counts: {}, rolledBack: true, budgetExhausted: Date.now() - start >= 4500 } });
    } catch (_stateError) { logger.warn('通知清理心跳无法保存', { errorCode: 'CLEANUP_HEARTBEAT_FAILED' }); }
    logger.warn('通知历史清理未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
module.exports = { cleanup };
