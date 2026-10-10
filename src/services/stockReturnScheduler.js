const { QueryTypes } = require('sequelize');
const db = require('../models');
const logger = require('../utils/logger');
const { lockStock } = require('./stockCommandService');
const lifecycle = require('./stockLifecycleService');
const { PICKED_SQL } = require('./stockLifecycleRules');
const TICK_MS = 60_000;
let timer = null;
let active = null;

/** 只读取系统保存的官网订单状态；无状态时保留成功事实，不推断退货撤销。 */
function localObservation(row) {
  const statuses = [
    ...new Set(
      String(row.status || '')
        .split('|')
        .map(s => s.trim())
        .filter(Boolean)
    ),
  ].sort();
  if (!statuses.length || statuses.includes('UNKNOWN')) return null;
  const savedStatuses = [...new Set((row.items || []).map(item => item.rawStatus))].sort();
  const sameObservation =
    row.observed &&
    row.savedObserved &&
    new Date(row.observed).getTime() === new Date(row.savedObserved).getTime();
  const items =
    sameObservation && JSON.stringify(statuses) === JSON.stringify(savedStatuses)
      ? row.items
      : statuses.map(rawStatus => ({
        key: `system:${rawStatus}`,
        name: '系统官网订单状态',
        quantity: 0,
        rawStatus,
        serialNumbers: [],
      }));
  return { items, observedAt: row.observed || null };
}

/** 在库存事务锁内核对到期历史订单；不调用官网、不创建采集任务。 */
async function scheduleReturns(transaction) {
  try {
    await lockStock(transaction);
    const settings = await db.StockSetting.findByPk(1, { transaction });
    if (!settings?.enabled) return 0;
    const rows = await db.sequelize.query(
      `SELECT o.id,o.official_raw_status AS status,o.official_status_observed_at AS observed,
      c.items,c.observed_at AS "savedObserved"
      FROM orders o LEFT JOIN pickup_records pr ON pr.order_id=o.id
      LEFT JOIN stock_order_checks c ON c.order_id=o.id
      WHERE (${PICKED_SQL} OR c.pickup_verified) AND EXISTS (SELECT 1 FROM pickup_devices d WHERE d.order_id=o.id AND d.stock_unit_id IS NOT NULL)
      AND (c.checked_at IS NULL OR c.checked_at<=now()-interval '30 minutes')
      ORDER BY c.checked_at NULLS FIRST,o.id LIMIT 100`,
      { transaction, type: QueryTypes.SELECT }
    );
    for (const row of rows) {
      await lifecycle.observe(
        transaction,
        row.id,
        localObservation(row),
        'SYSTEM_STATUS_MISSING',
        'PICKED_UP'
      );
    }
    return rows.length;
  } catch (error) {
    logger.warn('库存系统状态核对失败', { code: error.code || error.name });
    throw error;
  }
}

/** 每分钟扫描到期订单；数据库保存每单30分钟间隔，多实例共用库存锁。 */
function start() {
  if (timer || process.env.STOCK_RETURN_CHECK_ENABLED === 'false') return;
  const tick = () => {
    if (active) return;
    active = db.sequelize
      .transaction(transaction => scheduleReturns(transaction))
      .catch(error => logger.warn('库存定时核对未完成', { code: error.code || error.name }))
      .finally(() => {
        active = null;
      });
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  tick();
}

/** 停止领取并等待当前本地事务结束。 */
function stop() {
  clearInterval(timer);
  timer = null;
  return active || Promise.resolve();
}
module.exports = { localObservation, scheduleReturns, start, stop };
