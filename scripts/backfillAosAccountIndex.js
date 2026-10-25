require('dotenv').config();
const models = require('../src/models');
const Backfill = require('../src/services/aosAccountBackfill');
const logger = require('../src/utils/logger');

/** 只对明确实例重置当前3自然日或有界推进设置索引，不补发历史信号。 @returns {Promise<void>} 完成 */
async function main() {
  try {
    const args = process.argv.slice(2);
    const read = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const deviceId = read('--device');
    const localId = read('--instance');
    if (
      ![deviceId, localId].every(
        value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)
      )
    )
      throw new Error('EXPLICIT_SCOPE_REQUIRED');
    const steps = args.includes('--pages') ? Number(read('--pages')) : 1;
    if (!Number.isInteger(steps) || steps < 1 || steps > 1000)
      throw new Error('PAGES_OUT_OF_RANGE');
    const worker = new Backfill(models);
    if (args.includes('--reset')) await worker.reset(deviceId, localId);
    for (let index = 0; index < steps; index++) {
      const result = await worker.tick({ deviceId, localId });
      logger.info('AOS账号索引手动推进', { deviceId, localId, step: index + 1, ...result });
      if (result.completed || result.idle || result.failed || result.waitingCapture) break;
    }
  } catch (error) {
    logger.error('AOS账号索引命令失败', { errorCode: error.message });
    process.exitCode = 1;
  } finally {
    await models.sequelize.close();
  }
}
main();
