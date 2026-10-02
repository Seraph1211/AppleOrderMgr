require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../src/models');
const logger = require('../src/utils/logger');
const InventoryValidationGate = require('../src/services/inventoryValidationGate');
const { readProxy, requestOnce } = require('../src/services/inventoryValidationClient');

/** 仅在专用验证库中执行一次受限探测，禁止误指向生产或原开发库。 */
async function main() {
  try {
    if (
      !['apple_inventory_dev', 'test_inventory_validation'].includes(process.env.DB_NAME) ||
      !['postgres', '127.0.0.1', 'localhost'].includes(process.env.DB_HOST) ||
      process.env.DATABASE_URL
    )
      throw new Error('ISOLATED_DATABASE_REQUIRED');
    const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const proxy = readProxy(input.proxyFile);
    const result = await requestOnce({
      ...input,
      proxy,
      gate: new InventoryValidationGate(sequelize),
    });
    const { evidence, ...summary } = result;
    const output = '/app/inventory-evidence';
    fs.mkdirSync(output, { recursive: true });
    if (result.id)
      fs.writeFileSync(
        path.join(output, `${result.id}.json`),
        JSON.stringify({ ...summary, evidence }, null, 2)
      );
    logger.info('库存数据源单次验证', summary);
    if (!['PROXY_CONNECTED', 'CATALOG_RECEIVED', 'INVENTORY_VALID'].includes(result.outcome))
      process.exitCode = 2;
  } catch (error) {
    logger.error('库存数据源验证失败', { errorType: error.name });
    process.exitCode = 1;
  } finally {
    try {
      await sequelize.close();
    } catch (_error) {
      process.exitCode = 1;
    }
  }
}
main();
