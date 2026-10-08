const path = require('path');
const fs = require('fs');
const OfficialOrderCollector = require('../src/services/officialOrderCollector');
const { readPrivate } = require('../src/services/officialOrderSupport');

const CLI_ARGUMENT_OFFSET = 2;

/** 单笔受限入口：参数只有目录、系统 ID 和可选的服务器历史会话编号。 */
async function main() {
  try {
    const [root, id, resumeRun] = process.argv.slice(CLI_ARGUMENT_OFFSET);
    if (!root || !path.isAbsolute(root) || !/^[1-9]\d*$/.test(id || '')) {
      throw new Error('ARGUMENTS_INVALID');
    }
    const settingsFile = `${root}/private/collectorConfig.json`;
    const settings = fs.existsSync(settingsFile) ? readPrivate(settingsFile) : {};
    const proxyName = settings.proxyFile || 'fan-1.json';
    if (typeof proxyName !== 'string' || path.basename(proxyName) !== proxyName) {
      throw new Error('PROXY_FILE_INVALID');
    }
    if (['account', 'backfill'].includes(resumeRun)) {
      const input = readPrivate(`${root}/private/request-${id}.json`);
      if (!input.samples.length) {
        process.stdout.write(
          `${JSON.stringify({ outcome: 'INPUT_INVALID', results: input.failures })}\n`
        );
        process.exitCode = 2;
        return;
      }
    }
    if (resumeRun === 'backfill') {
      const plan = readPrivate(`${root}/private/plan.json`);
      const input = readPrivate(`${root}/private/request-${id}.json`);
      const fullScope =
        plan.schemaVersion === 2 && plan.scope === 'all-picked-up' && plan.cutoff === null;
      const missingScope =
        plan.schemaVersion === 3 &&
        plan.scope === 'missing-fields' &&
        plan.cutoff === null &&
        plan.policy?.loginCooldown === true &&
        plan.policy?.apiHealthCheck === true &&
        plan.policy?.proxy541Limit === 3;
      if (
        (!fullScope && !missingScope && (plan.scope || plan.cutoff !== '2026-09-23')) ||
        (fullScope &&
          (plan.policy?.loginCooldown !== false ||
            plan.policy?.apiHealthCheck !== false ||
            plan.policy?.proxy541Limit !== 3)) ||
        !Number.isFinite(Date.parse(plan.startedAt)) ||
        Date.parse(plan.startedAt) > Date.now() ||
        Date.now() - Date.parse(plan.startedAt) > 86400000 ||
        input.samples.some(
          sample =>
            !plan.entries.some(
              entry => entry.id === sample.id && entry.orderNumber === sample.orderNumber
            )
        ) ||
        settings.captureReceipt !== true ||
        !settings.leaseContext ||
        readPrivate(`${root}/private/${proxyName}`).maxConnections !== 16
      )
        throw new Error('BACKFILL_SCOPE_INVALID');
      settings.batchPolicy = fullScope || missingScope ? plan.policy : {};
    }
    const collector = new OfficialOrderCollector({
      root,
      inputFile: `${root}/private/request-${id}.json`,
      orderId: Number(id),
      proxyFile: `${root}/private/${proxyName}`,
      totalRequestLimit: settings.maxTotalRequests,
      runRequestLimit: settings.maxRunRequests,
      resumeRun: ['account', 'backfill'].includes(resumeRun) ? undefined : resumeRun,
      accountMode: ['account', 'backfill'].includes(resumeRun),
      captureReceipt: settings.captureReceipt === true,
      browserMode: settings.browserMode || 'headed',
      leaseContext: settings.leaseContext,
      batchPolicy: resumeRun === 'backfill' ? settings.batchPolicy : {},
      httpBootstrap: settings.httpBootstrap === true,
      httpPythonPath: settings.httpPythonPath,
      persistSessions: settings.persistSessions,
    });
    const result = await collector.run();
    // 普通输出隐藏 Apple 订单号；完整 JSON 仅保存到受限 resultFile。
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.outcome !== 'SUCCEEDED') process.exitCode = 2;
  } catch (error) {
    const code = /^[A-Z_0-9]+$/.test(error.code || error.message)
      ? error.code || error.message
      : 'CLI_FAILED';
    process.stderr.write(`${JSON.stringify({ outcome: code })}\n`);
    process.exitCode = 1;
  }
}

main();
