const path = require('path');
const fs = require('fs');
const {
  OfficialOrderHttpCollector,
  validateReadUrl,
} = require('../src/services/officialOrderHttpCollector');
const { OfficialOrderHttpTransport } = require('../src/services/officialOrderHttpTransport');
const OfficialOrderGate = require('../src/services/officialOrderGate');
const {
  readPrivate,
  writePrivate,
  hash,
  proxyFingerprint,
  fault,
} = require('../src/services/officialOrderSupport');

/** 服务器独立 HTTP 读取入口；不连接业务库、不提交密码、不执行回写。 */
async function main() {
  let gate;
  let transport;
  let outcome = 'HTTP_COLLECTOR_FAILED';
  let summary;
  let retryAfter;
  try {
    const [root, id, attemptId] = process.argv.slice(2);
    if (attemptId !== undefined && !/^[a-f0-9]{32}$/.test(attemptId)) throw fault('INPUT_INVALID');
    if (!root || !path.isAbsolute(root) || !/^[1-9]\d*$/.test(id || ''))
      throw fault('INPUT_INVALID');
    if (fs.existsSync(`${root}/private/STOP`)) throw fault('REQUEST_STOPPED');
    const plan = readPrivate(`${root}/private/plan.json`);
    const entry = plan.entries.find(row => row.id === Number(id));
    if (
      !entry ||
      plan.schemaVersion !== 3 ||
      plan.scope !== 'missing-fields' ||
      !Number.isFinite(Date.parse(plan.startedAt)) ||
      plan.policy?.loginCooldown !== true ||
      plan.policy?.apiHealthCheck !== true ||
      Date.now() - Date.parse(plan.startedAt) > 86400000 ||
      Date.parse(plan.startedAt) > Date.now()
    )
      throw fault('BACKFILL_SCOPE_INVALID');
    const sample = readPrivate(`${root}/private/request-${id}.json`).samples.find(
      row => row.id === Number(id)
    );
    if (
      !sample ||
      sample.orderNumber !== entry.orderNumber ||
      !/^[a-f0-9]{64}$/.test(sample.accountHash)
    )
      throw fault('INPUT_INVALID');
    const initial = validateReadUrl(sample.url);
    if (!initial.pathname.split('/').map(decodeURIComponent).includes(sample.orderNumber))
      throw fault('LINK_IDENTITY_MISMATCH');
    sample.orderHash = hash(sample.orderNumber);
    const isolated = attemptId
      ? readPrivate(`${root}/private/http-config-${attemptId}.json`)
      : null;
    if (isolated && (isolated.orderId !== Number(id) || isolated.attemptId !== attemptId))
      throw fault('INPUT_INVALID');
    const settings = isolated ? isolated.settings : readPrivate(`${root}/private/httpConfig.json`);
    const proxy = isolated ? isolated.proxy : readPrivate(`${root}/private/httpProxy.json`);
    const isStopped = () => fs.existsSync(`${root}/private/STOP`);
    gate = new OfficialOrderGate(
      readPrivate(`${root}/private/db.json`),
      settings.maxTotalRequests,
      settings.maxRunRequests || 40
    );
    const runId = Number(await gate.open(sample, proxyFingerprint(proxy)));
    transport = new OfficialOrderHttpTransport({
      gate,
      proxy,
      pythonPath: settings.pythonPath || '/usr/bin/python3',
      isStopped,
    });
    await transport.start();
    const collector = new OfficialOrderHttpCollector({
      transport,
      sample,
      root,
      key: readPrivate(`${root}/private/evidence.key`, false),
      runId,
      collectReceipt: false,
    });
    summary = await collector.collect();
    outcome = summary.outcome;
  } catch (error) {
    retryAfter = error.retryAfter;
    outcome = /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'HTTP_COLLECTOR_FAILED';
    summary = {
      outcome,
      runId: gate?.id ? Number(gate.id) : null,
      requests: gate?.requests || 0,
      detailResultFile: error.detailResultFile || null,
    };
    process.exitCode = 2;
  } finally {
    if (transport) await transport.close();
    if (gate) {
      try {
        await gate.recordFailure(outcome, retryAfter);
      } catch (_error) {
        summary = { outcome: 'STATE_WRITE_FAILED' };
        process.exitCode = 2;
      } finally {
        await gate.close(outcome).catch(() => {
          summary = { outcome: 'STATE_WRITE_FAILED' };
          process.exitCode = 2;
        });
      }
    }
  }
  const root = process.argv[2];
  const summaryId = /^[a-f0-9]{32}$/.test(process.argv[4] || '')
    ? process.argv[4]
    : /^[1-9]\d*$/.test(process.argv[3] || '')
      ? process.argv[3]
      : null;
  if (root && path.isAbsolute(root) && summaryId)
    writePrivate(`${root}/private/http-last-summary-${summaryId}.json`, JSON.stringify(summary));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch(() => {
  process.stderr.write('{"outcome":"HTTP_COLLECTOR_FAILED"}\n');
  process.exitCode = 2;
});
