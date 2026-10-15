/** 用法：node scripts/standardizeProductNames.js dry-run|apply|verify [--batch-id UUID] [--report PATH] */
const fs = require('node:fs');
const { sequelize } = require('../src/models');
const { runProductNameBatch } = require('../src/services/productNameBatchService');
const logger = require('../src/utils/logger');

async function main() {
  try {
    const args = process.argv.slice(2);
    const option = key => (args.includes(key) ? args[args.indexOf(key) + 1] : undefined);
    const allowed = new Set(['--batch-id', '--report', '--batch-size']);
    for (let index = 1; index < args.length; index += 2) {
      if (!allowed.has(args[index]) || !args[index + 1]) throw new Error('未知参数或缺少参数值');
    }
    if (args[0] === 'verify' && !option('--batch-id'))
      throw new Error('verify 必须提供 --batch-id');
    const report = await runProductNameBatch(sequelize, {
      mode: args[0] || 'dry-run',
      ...(option('--batch-id') ? { batchId: option('--batch-id') } : {}),
      ...(option('--batch-size') ? { batchSize: Number(option('--batch-size')) } : {}),
    });
    if (option('--report'))
      fs.writeFileSync(option('--report'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify(report) + '\n');
    if (
      report.batchFound === false ||
      report.invalid ||
      report.currentMismatches ||
      report.pending ||
      report.ruleMismatches ||
      report.protectedUnchanged === false ||
      report.conflicts
    )
      process.exitCode = 1;
  } catch (error) {
    logger.error('商品名称批处理失败', { code: error.code || error.name });
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}
main();
