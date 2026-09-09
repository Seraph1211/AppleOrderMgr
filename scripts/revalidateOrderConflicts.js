#!/usr/bin/env node

const { revalidateExpressionConflicts } = require('../src/services/crawler/orderComparison');
const MAX_ORDERS = 100;
const logger = require('../src/utils/logger');

/**
 * 重校验指定订单已有的表达冲突，默认只预览，执行时锁行并仅更新校验字段。
 * @param {Object} models - Sequelize 实例和 Order 模型
 * @param {string[]} orderNumbers - 明确指定的订单号，最多 100 个
 * @param {boolean} execute - 是否写入，默认 false
 * @returns {Promise<Object[]>} 仅含订单号及冲突数量的结果
 */
async function revalidateOrders({ sequelize, Order }, orderNumbers, execute = false) {
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
          attributes: [
            'id',
            'orderNumber',
            'validationIssues',
            'validationStatus',
            'anomalyDetectedAt',
          ],
          order: [['id', 'ASC']],
          transaction,
          ...(execute ? { lock: transaction.LOCK.UPDATE } : {}),
        });
        if (orders.length !== new Set(orderNumbers).size)
          throw new Error('部分订单不存在，未执行重校验');
        const results = [];
        for (const order of orders) {
          const patch = revalidateExpressionConflicts(order);
          if (execute && patch) {
            await order.update(patch, { transaction, fields: Object.keys(patch), silent: true });
          }
          results.push({
            orderNumber: order.orderNumber,
            changed: Boolean(patch),
            executed: execute && Boolean(patch),
            remainingIssues: (patch?.validationIssues || order.validationIssues || []).length,
          });
        }
        return results;
      } catch (error) {
        error.code = 'ORDER_REVALIDATION_TRANSACTION_FAILED';
        throw error;
      }
    });
  } catch (error) {
    logger.error('订单表达冲突重校验未完成', {
      stage: error.code === 'ORDER_REVALIDATION_TRANSACTION_FAILED' ? 'transaction' : 'validation',
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
    const results = await revalidateOrders(models, orderNumbers, execute);
    logger.info('订单表达冲突重校验完成', { mode: execute ? 'execute' : 'preview', results });
  } catch (_error) {
    logger.error('订单表达冲突重校验失败，请检查订单参数与数据库连接；事务已回滚');
    process.exitCode = 1;
  } finally {
    if (models) {
      try {
        await models.sequelize.close();
      } catch (_error) {
        logger.error('关闭重校验数据库连接失败');
        process.exitCode = 1;
      }
    }
  }
}

if (require.main === module) void main();

module.exports = { revalidateOrders };
