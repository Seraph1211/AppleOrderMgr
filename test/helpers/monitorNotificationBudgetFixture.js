const fs = require('fs');
const path = require('path');

/** 从正式迁移提取独立预算DDL，旧库存专项不需要初始化无关业务表。 @param {Object} db 隔离数据库 @returns {Promise<void>} 完成 */
async function up(db) {
  try {
    const migration = fs.readFileSync(path.join(__dirname, '../../migrations/20261019000002-monitor-dual-notifications.js'), 'utf8');
    const ddl = migration.match(/CREATE TABLE wecom_robot_budgets\s*\([\s\S]*?\n\s*\);/)?.[0];
    if (!ddl) throw new Error('正式共享机器人预算DDL缺失');
    await db.query(ddl);
  } catch (error) { throw new Error('隔离预算结构初始化失败', { cause: error }); }
}
/** 每个合成场景独立预约窗口。 @param {Object} db 隔离数据库 @returns {Promise<void>} 完成 */
async function reset(db) {
  try { await db.query('TRUNCATE wecom_robot_budgets'); } catch (error) { throw new Error('隔离预算重置失败', { cause: error }); }
}
/** 只清理测试专用预算表。 @param {Object} db 隔离数据库 @returns {Promise<void>} 完成 */
async function down(db) {
  try { await db.query('DROP TABLE IF EXISTS wecom_robot_budgets'); } catch (error) { throw new Error('隔离预算清理失败', { cause: error }); }
}
/** 合成时间推进时同样推进持久预算窗口，不绕过真实预约代码。 @param {Object} db 隔离数据库 @param {number} milliseconds 推进量 @returns {Promise<void>} 完成 */
async function elapse(db, milliseconds) {
  try {
    await db.query('UPDATE wecom_robot_budgets SET reservations=coalesce((SELECT jsonb_agg(jsonb_set(item,\'{at}\',to_jsonb((item->>\'at\')::bigint - :milliseconds))) FROM jsonb_array_elements(reservations) item),\'[]\'::jsonb), next_send_at=next_send_at - (:milliseconds * interval \'1 millisecond\'), waiters=coalesce((SELECT jsonb_object_agg(key,to_jsonb(value::bigint - :milliseconds)) FROM jsonb_each_text(waiters)),\'{}\'::jsonb)', { replacements: { milliseconds } });
  } catch (error) { throw new Error('隔离预算合成时间推进失败', { cause: error }); }
}
module.exports = { up, reset, down, elapse };
