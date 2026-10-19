const { createHmac } = require('crypto');
const { validateWebhook } = require('./wecomTransport');

/** 以真实机器人key生成大小写敏感HMAC；不输出key或URL。 @param {string} webhook 官方URL @returns {string} 指纹 */
function fingerprint(webhook) {
  const key = new URL(validateWebhook(webhook)).searchParams.get('key');
  const configured =
    process.env.WECOM_BUDGET_HMAC_KEY ||
    process.env.FIELD_BLIND_INDEX_KEY ||
    process.env.FIELD_ENCRYPTION_KEY;
  if (!configured) throw new Error('WECOM_BUDGET_KEY_REQUIRED');
  return createHmac('sha256', configured).update(`wecom-robot:${key}`).digest('hex');
}

/** 原子预约真实机器人预算；失败仅持久登记等待，不发外部请求。 @param {string} webhook URL @param {string} lane 业务 @param {Object} transaction 事务 @param {Date} now 时钟 @returns {Promise<Object>} 结果 */
async function reserve(webhook, lane, transaction, now = new Date()) {
  try {
    const { sequelize } = require('../models');
    const WecomRobotBudget = sequelize.models.WecomRobotBudget || require('../models/WecomRobotBudget')(sequelize);
    const id = fingerprint(webhook);
    await WecomRobotBudget.findOrCreate({
      where: { fingerprint: id },
      defaults: { reservations: [], waiters: {}, storm: {} },
      transaction,
    });
    const row = await WecomRobotBudget.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    const at = +now;
    const reservations = (row.reservations || []).filter(item => item.at > at - 60000);
    const waiters = Object.fromEntries(
      Object.entries(row.waiters || {}).filter(([, time]) => time > at - 30000)
    );
    waiters[lane] ||= at;
    const monitor = reservations.filter(item => item.lane === 'monitor');
    // 已耗尽自身配额的lane暂不参与公平优先级，避免阻塞仍可出站业务。
    const oldest = Object.entries(waiters).filter(([name]) => name !== 'monitor' || monitor.length < 6).sort((a, b) => a[1] - b[1])[0]?.[0];
    let retryAt = Math.max(at, +new Date(row.nextSendAt || 0));
    if (reservations.length >= 18) retryAt = Math.max(retryAt, reservations[0].at + 60000);
    if (lane === 'monitor' && monitor.length >= 6)
      retryAt = Math.max(retryAt, monitor[0].at + 60000);
    if (oldest !== lane && reservations.at(-1)?.lane === lane)
      retryAt = Math.max(retryAt, at + 3334);
    const allowed = retryAt <= at;
    if (allowed) {
      reservations.push({ at, lane });
      delete waiters[lane];
    }
    await row.update(
      { reservations, waiters, nextSendAt: allowed ? new Date(at + 3334) : row.nextSendAt },
      { transaction }
    );
    return { allowed, retryAt: new Date(retryAt), errorCode: allowed ? null : 'ROBOT_BUDGET' };
  } catch (error) {
    require('../utils/logger').debug('机器人预算事务未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
module.exports = { fingerprint, reserve };
