const { OfficialReceiptCollector } = require('../src/services/officialReceiptCollector');
const { readPrivate, writePrivate, fault } = require('../src/services/officialOrderSupport');

/** 私密配置驱动的一次完整收据采集；stdout 仅返回不含凭据与 SN 的运行摘要。 */
async function main() {
  try {
    const [root] = process.argv.slice(2);
    if (root !== '/research') throw fault('RECEIPT_ROOT_INVALID');
    const settings = readPrivate(`${root}/private/settings.json`);
    if (
      !Number.isSafeInteger(settings.orderId) ||
      settings.orderId <= 0 ||
      !Number.isSafeInteger(settings.totalRequestLimit) ||
      settings.totalRequestLimit <= 0
    )
      throw fault('RECEIPT_SETTINGS_INVALID');
    const collector = new OfficialReceiptCollector({
      root,
      orderId: settings.orderId,
      inputFile: `${root}/private/input.json`,
      proxyFile: `${root}/private/proxy.json`,
      totalRequestLimit: settings.totalRequestLimit,
      runRequestLimit: settings.runRequestLimit || 200,
      leaseContext: settings.leaseContext,
      httpPythonPath: '/runtime/venv/bin/python',
      batchPolicy: { loginCooldown: true, proxy541Limit: 3 },
    });
    const result = await collector.run();
    const summary = {
      systemOrderId: result.systemOrderId,
      runId: result.runId,
      outcome: result.outcome,
      requests: result.requests,
      passwordSubmitted: result.passwordSubmitted,
      receipt: result.receipt,
    };
    writePrivate(`${root}/private/result.json`, JSON.stringify(summary));
    process.stdout.write(JSON.stringify(summary) + '\n');
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        outcome: /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'RECEIPT_RUN_FAILED',
      }) + '\n'
    );
    process.exitCode = 1;
  }
}

main().catch(() => {
  process.exitCode = 1;
});
