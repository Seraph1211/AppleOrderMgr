const inventoryFailure = require('../utils/inventoryFailure');
require('dotenv').config();
const models = require('../models');
const logger = require('../utils/logger');
const { validateEncryptionConfiguration } = require('../utils/fieldEncryption');
const InventoryService = require('../services/inventoryService');
const InventoryCollector = require('../services/inventoryCollector');
const InventoryNotifier = require('../services/inventoryNotifier');
const InventoryValidationGate = require('../services/inventoryValidationGate');
const InventoryDriver = require('../services/inventoryDriver');
const InventoryMaintenance = require('../services/inventoryMaintenance');
const { REQUEST_CONCURRENCY } = require('../services/inventoryConcurrency');
const service = new InventoryService(models);
const gate = new InventoryValidationGate(models.sequelize, { production: true });
const collector = new InventoryCollector(service);
const notifier = new InventoryNotifier(service);
const driver = new InventoryDriver(gate);
const maintenance = new InventoryMaintenance(service, driver, gate);
let stopping = false;
let timer;
const collecting = new Set();
let dispatching;
let notifying;
async function collect(claim) {
  try {
    const result = await driver.request('inventory', {
      skus: claim.task.skus,
      location: claim.task.location,
    });
    const applied = await collector.settle(claim, result);
    if (applied.pause)
      await gate.locked(async (state, _now, transaction) => {
        try {
          state.pausedReason = applied.pause;
          await gate.save(state, transaction);
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
  } catch (error) {
    logger.error('库存采集周期失败', { errorType: error.name });
  }
}
async function dispatch() {
  try {
    await notifier.health();
    while (!stopping && collecting.size < REQUEST_CONCURRENCY) {
      const claim = await collector.claim();
      if (!claim) break;
      const pending = collect(claim).finally(() => collecting.delete(pending));
      collecting.add(pending);
    }
    if (!collecting.size && !stopping) await maintenance.catalogTick();
    await maintenance.retain();
  } catch (error) {
    logger.error('库存并发调度失败', { errorType: error.name });
  }
}
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  try {
    await dispatching;
    await Promise.allSettled([...collecting, notifying]);
    await models.sequelize.close();
  } catch (error) {
    logger.error('库存 Worker 关闭失败', { errorType: error.name });
    process.exitCode = 1;
  }
}
async function main() {
  try {
    validateEncryptionConfiguration();
    await models.sequelize.authenticate();
    await service.catalog();
    timer = setInterval(() => {
      if (stopping) return;
      if (!dispatching)
        dispatching = dispatch().finally(() => {
          dispatching = null;
        });
      if (!notifying)
        notifying = notifier
          .tick()
          .catch(error => {
            logger.error('库存通知周期失败', { errorType: error.name });
          })
          .finally(() => {
            notifying = null;
          });
    }, 1000);
    logger.info('库存 Worker 已启动，采集和通知分别遵守数据库开关');
  } catch (error) {
    logger.error('库存 Worker 启动失败', { errorType: error.name });
    await models.sequelize.close();
    process.exitCode = 1;
  }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
main();
