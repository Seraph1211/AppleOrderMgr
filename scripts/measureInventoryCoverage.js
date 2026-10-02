require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { sequelize } = require('../src/models');
const Gate = require('../src/services/inventoryValidationGate');
const { acquireProxy } = require('../src/services/inventoryValidationProxy');
const { requestOnce } = require('../src/services/inventoryValidationClient');
const logger = require('../src/utils/logger');

/** 一次性全量预检，不循环、不自动恢复、不把未覆盖组合标记无货。 */
async function main() {
  const runId = crypto.randomUUID();
  const output = '/app/inventory-evidence';
  const report = {
    runId,
    status: 'running',
    startedAt: new Date().toISOString(),
    attempts: [],
    coveredPairs: 0,
  };
  const persist = () => {
    const file = `${output}/preflight-${runId}.json`;
    fs.writeFileSync(`${file}.new`, JSON.stringify(report, null, 2));
    fs.renameSync(`${file}.new`, file);
  };
  try {
    if (
      process.env.DB_NAME !== 'apple_inventory_dev' ||
      process.env.DB_HOST !== 'postgres' ||
      process.env.DATABASE_URL
    )
      throw new Error('ISOLATED_DATABASE_REQUIRED');
    const scope = JSON.parse(fs.readFileSync(`${output}/candidateScope.json`));
    const plan = JSON.parse(fs.readFileSync(`${output}/candidatePlan.json`));
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ products: scope.products, stores: scope.stores }))
      .digest('hex');
    if (
      hash !== plan.scopeHash ||
      plan.tasks.length !== 78 ||
      scope.products.length !== 65 ||
      scope.stores.length !== 49
    )
      throw new Error('PREFLIGHT_SCOPE_CHANGED');
    const apiUrl = JSON.parse(fs.readFileSync('/run/secrets/inventoryYiyouApi.json')).url;
    const gate = new Gate(sequelize);
    const targetStores = new Set(scope.stores.map(row => row.storeCode));
    const targetSkus = new Set(scope.products.map(row => row.sku));
    const expectedPairs = new Set(
      scope.products.flatMap(product =>
        scope.stores.map(store => `${product.sku}:${store.storeCode}`)
      )
    );
    const covered = new Set();
    report.scopeHash = hash;
    report.expectedPairs = expectedPairs.size;
    report.plannedRequests = plan.tasks.length;
    let proxy;
    let extractions = 0;
    let responseBytes = 0;
    persist();
    for (const [index, context] of plan.tasks.entries()) {
      if (context.skus.some(sku => !targetSkus.has(sku)) || !/^\d{6}$/.test(context.location))
        throw new Error('INVALID_PLAN_TASK');
      // 单轮最多4个端点；不靠无限换出口取得最终成功。
      if (!proxy || proxy.expiresAt <= Date.now()) {
        if (extractions >= 4) throw new Error('PROVIDER_EXTRACTION_BUDGET_EXHAUSTED');
        proxy = await acquireProxy({ apiUrl, gate });
        extractions += 1;
        report.extractions = extractions;
      }
      const result = await requestOnce({
        purpose: 'inventory',
        context: { ...context, preflightId: runId, taskIndex: index },
        proxy,
        gate,
      });
      const { evidence, ...summary } = result;
      report.attempts.push({ ...summary, taskIndex: index });
      responseBytes += result.bytes || 0;
      if (result.id)
        fs.writeFileSync(
          `${output}/${result.id}.json`,
          JSON.stringify({ ...result, context }, null, 2)
        );
      if (result.outcome !== 'INVENTORY_VALID') {
        report.status = 'stopped';
        report.stopReason = result.outcome;
        persist();
        break;
      }
      for (const row of evidence) {
        if (targetStores.has(row.storeCode) && targetSkus.has(row.sku) && row.status !== 'unknown')
          covered.add(`${row.sku}:${row.storeCode}`);
      }
      report.coveredPairs = covered.size;
      report.responseBytes = responseBytes;
      if (responseBytes > 30000000) throw new Error('PREFLIGHT_BYTES_EXHAUSTED');
      persist();
      logger.info('库存单轮预检进度', {
        runId,
        task: index + 1,
        planned: plan.tasks.length,
        coveredPairs: covered.size,
        expectedPairs: expectedPairs.size,
      });
    }
    report.missingPairs = [...expectedPairs].filter(key => !covered.has(key));
    if (report.status === 'running')
      report.status = covered.size === expectedPairs.size ? 'complete' : 'coverage_incomplete';
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - Date.parse(report.startedAt);
    report.withinCandidateInterval = report.elapsedMs <= 300000;
    persist();
    logger.info('库存单轮预检结束', {
      runId,
      status: report.status,
      attempts: report.attempts.length,
      coveredPairs: report.coveredPairs,
      elapsedMs: report.elapsedMs,
    });
    if (report.status !== 'complete') process.exitCode = 2;
  } catch (_error) {
    report.status = 'stopped';
    report.stopReason = 'PREFLIGHT_SETUP_OR_STORAGE_ERROR';
    report.finishedAt = new Date().toISOString();
    try {
      persist();
    } catch (_writeError) {
      /* 保持失败退出，数据库尝试记录仍为权威。 */
    }
    logger.error('库存单轮预检停止', { runId, stopReason: report.stopReason });
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
