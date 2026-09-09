#!/usr/bin/env node

const { getRestorableOrderTime } = require('../src/utils/orderTime');
const MAX_ORDERS = 100;
const logger = require('../src/utils/logger');

/**
 * 恢复明确指定订单被日期覆盖的来源时间；默认预览，执行时锁行并仅更新 orderDate。
 * @param {Object} models - Sequelize 实例和 Order 模型
 * @param {string[]} orderNumbers - 明确指定的订单号，最多 100 个
 * @param {boolean} execute - 是否写入，默认 false
 * @returns {Promise<Object[]>} 仅含订单号及是否恢复的结果
 */
async function restoreOrderTimes({ sequelize, Order }, orderNumbers, execute = false) {
  try {
    if (
      !Array.isArray(orderNumbers) ||
      !orderNumbers.length ||
      orderNumbers.length > MAX_ORDERS ||
      orderNumbers.some(number => !/^W\d{10}$/.test(number)) ||
      typeof execute !== 'boolean'
    ) {
      throw new Error('必须指定 1–100 个合法订单号');
    }
    return await sequelize.transaction(async transaction => {
      try {
        const orders = await Order.findAll({
          where: { orderNumber: [...new Set(orderNumbers)] },
          attributes: ['id', 'orderNumber', 'orderDate', 'sourceSnapshot'],
          order: [['id', 'ASC']],
          transaction,
          ...(execute ? { lock: transaction.LOCK.UPDATE } : {}),
        });
        if (orders.length !== new Set(orderNumbers).size)
          throw new Error('部分订单不存在，未执行时间恢复');
        const results = [];
        for (const order of orders) {
          const restored = getRestorableOrderTime(order);
          const patch = restored ? { orderDate: restored } : null;
          if (execute && patch) {
            await order.update(patch, { transaction, fields: Object.keys(patch), silent: true });
          }
          results.push({
            orderNumber: order.orderNumber,
            changed: Boolean(patch),
            executed: execute && Boolean(patch),
          });
        }
        return results;
      } catch (error) {
        error.code = 'ORDER_TIME_RESTORE_TRANSACTION_FAILED';
        throw error;
      }
    });
  } catch (error) {
    logger.error('订单来源时间恢复未完成', {
      stage: error.code === 'ORDER_TIME_RESTORE_TRANSACTION_FAILED' ? 'transaction' : 'validation',
    });
    throw error;
  }
}

async function main() {
  let models;
  try {
    const args = process.argv.slice(2);
    const execute = args.includes('--execute');
    const orderNumbers = args.filter(arg => arg !== '--execute');
    models = require('../src/models');
    const results = await restoreOrderTimes(models, orderNumbers, execute);
    logger.info('订单来源时间恢复完成', { mode: execute ? 'execute' : 'preview', results });
  } catch (_error) {
    logger.error('订单来源时间恢复失败，请检查订单参数与数据库连接；事务已回滚');
    process.exitCode = 1;
  } finally {
    if (models) {
      try {
        await models.sequelize.close();
      } catch (_error) {
        logger.error('关闭时间恢复数据库连接失败');
        process.exitCode = 1;
      }
    }
  }
}

if (require.main === module) void main();

module.exports = { restoreOrderTimes };
