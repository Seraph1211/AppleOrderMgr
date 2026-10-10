const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../models');
const logger = require('../utils/logger');
const { officialAccountKey } = require('./officialOrderAccount');
const { PICKED_SQL } = require('./stockLifecycleRules');

/** 在官网队列锁内分批加入全部历史已取货绑定订单；30 分钟持久间隔，不恢复暂停批次。 */
async function scheduleReturns(transaction) {
  try {
    const settings = await db.StockSetting.findByPk(1, { transaction });
    if (!settings?.enabled) return 0;
    const rows = await db.sequelize.query(
      `SELECT o.id,o.order_number AS "orderNumber",o.apple_id AS "appleId"
      FROM orders o LEFT JOIN pickup_records pr ON pr.order_id=o.id
      LEFT JOIN stock_order_checks c ON c.order_id=o.id
      WHERE (${PICKED_SQL} OR c.pickup_verified) AND EXISTS (SELECT 1 FROM pickup_devices d WHERE d.order_id=o.id AND d.stock_unit_id IS NOT NULL)
      AND (c.checked_at IS NULL OR c.checked_at<=now()-interval '30 minutes')
      AND (c.last_enqueued_at IS NULL OR c.last_enqueued_at<=now()-interval '30 minutes')
      AND NOT EXISTS (SELECT 1 FROM official_order_refresh_jobs j WHERE j.order_id=o.id AND j.state IN ('queued','running'))
      ORDER BY c.last_enqueued_at NULLS FIRST,o.id LIMIT 500`,
      { transaction, type: QueryTypes.SELECT }
    );
    if (!rows.length) return 0;
    const batchId = crypto.randomUUID();
    await db.sequelize.query(
      `INSERT INTO official_order_refresh_batches
      (id,requested_by,request_key,request_fingerprint,selection_mode,purpose,selected_count,submission_summary)
      VALUES(:id,NULL,:key,:hash,'ids','stock_returns',:count,CAST(:summary AS jsonb))`,
      {
        transaction,
        replacements: {
          id: batchId,
          key: crypto.randomUUID(),
          hash: crypto
            .createHash('sha256')
            .update(JSON.stringify(rows.map(row => row.id)))
            .digest('hex'),
          count: rows.length,
          summary: JSON.stringify({ source: 'stock_returns', total: rows.length }),
        },
      }
    );
    await db.sequelize.query(
      `INSERT INTO official_order_refresh_jobs(id,batch_id,order_id,order_number,account_key)
      SELECT x.id,:batch,x."orderId",x."orderNumber",x."accountKey" FROM jsonb_to_recordset(CAST(:jobs AS jsonb))
      AS x(id uuid,"orderId" integer,"orderNumber" text,"accountKey" text)`,
      {
        transaction,
        replacements: {
          batch: batchId,
          jobs: JSON.stringify(
            rows.map(row => ({
              id: crypto.randomUUID(),
              orderId: row.id,
              orderNumber: row.orderNumber,
              accountKey: officialAccountKey(row.appleId),
            }))
          ),
        },
      }
    );
    await db.sequelize.query(
      `INSERT INTO stock_order_checks(order_id,last_enqueued_at,pickup_verified)
      SELECT unnest(ARRAY[:ids]::integer[]),now(),true ON CONFLICT(order_id) DO UPDATE SET last_enqueued_at=EXCLUDED.last_enqueued_at,pickup_verified=true`,
      {
        transaction,
        replacements: { ids: rows.map(row => row.id) },
      }
    );
    return rows.length;
  } catch (error) {
    logger.warn('历史订单退货调度失败', { code: error.code || error.name });
    throw error;
  }
}
module.exports = { scheduleReturns };
