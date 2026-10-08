const { verifyRefreshEvidence } = require('../src/services/officialRefreshEvidence');
const path = require('path');
const fs = require('fs');
const OfficialOrderGate = require('../src/services/officialOrderGate');
const { OfficialOrderHttpTransport } = require('../src/services/officialOrderHttpTransport');
const {
  OfficialOrderHttpCollector,
  validateReadUrl,
} = require('../src/services/officialOrderHttpCollector');
const {
  readPrivate,
  writePrivate,
  hash,
  proxyFingerprint,
  fault,
} = require('../src/services/officialOrderSupport');

/** 管理台单次 HTTP 执行入口；只读输入与加密证据，不持有业务库写权限。 */
async function collect(root, attemptId) {
  let gate;
  let transport;
  let summary = { outcome: 'HTTP_COLLECTOR_FAILED' };
  let retryAfter;
  try {
    if (!path.isAbsolute(root || '') || !/^[a-f0-9]{32}$/.test(attemptId || ''))
      throw fault('INPUT_INVALID');
    const input = readPrivate(`${root}/private/refresh-${attemptId}.json`);
    const { sample, proxy, settings } = input;
    if (
      !Number.isSafeInteger(sample?.id) ||
      sample.id < 1 ||
      !/^W\d{10}$/.test(sample.orderNumber || '') ||
      !/^[a-f0-9]{64}$/.test(sample.accountHash || '') ||
      Date.now() - Date.parse(input.capturedAt) > 60000 ||
      Date.parse(input.capturedAt) > Date.now() ||
      !Number.isFinite(Date.parse(input.capturedAt))
    )
      throw fault('INPUT_INVALID');
    const url = validateReadUrl(sample.url);
    if (!url.pathname.split('/').map(decodeURIComponent).includes(sample.orderNumber))
      throw fault('LINK_IDENTITY_MISMATCH');
    const isStopped = () =>
      fs.existsSync(`${root}/private/STOP`) ||
      fs.existsSync(`${root}/private/http-cleanup-blocked.json`);
    if (isStopped()) throw fault('REQUEST_STOPPED');
    sample.orderHash = hash(sample.orderNumber);
    gate = new OfficialOrderGate(
      readPrivate(`${root}/private/db.json`),
      settings.maxTotalRequests,
      40
    );
    const runId = Number(await gate.open(sample, proxyFingerprint(proxy)));
    transport = new OfficialOrderHttpTransport({
      gate,
      proxy,
      pythonPath: '/runtime/venv/bin/python',
      isStopped,
    });
    await transport.start();
    summary = await new OfficialOrderHttpCollector({
      transport,
      sample,
      root,
      runId,
      key: readPrivate(`${root}/private/evidence.key`, false),
      collectReceipt: false,
    }).collect();
  } catch (error) {
    retryAfter = error.retryAfter;
    summary = {
      outcome: /^[A-Z_0-9]{1,80}$/.test(error.code || '') ? error.code : 'HTTP_COLLECTOR_FAILED',
      runId: gate?.id ? Number(gate.id) : null,
    };
  } finally {
    if (transport) await transport.close();
    if (gate) {
      try {
        if (gate.id) await gate.recordFailure(summary.outcome, retryAfter);
      } catch (_error) {
        summary = { outcome: 'STATE_WRITE_FAILED' };
      } finally {
        await gate.close(summary.outcome).catch(() => {
          summary = { outcome: 'STATE_WRITE_FAILED' };
        });
      }
    }
  }
  if (summary.outcome === 'SUCCEEDED') {
    try {
      const result = verifyRefreshEvidence(root, readPrivate(summary.resultFile));
      writePrivate(summary.resultFile, JSON.stringify(result));
    } catch (_error) {
      summary = { outcome: 'INVALID_OFFICIAL_RESULT' };
    }
  }
  return summary;
}

if (require.main === module) {
  collect(...process.argv.slice(2))
    .then(summary => {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      process.exitCode = summary.outcome === 'SUCCEEDED' ? 0 : 2;
    })
    .catch(() => {
      process.stderr.write('HTTP_COLLECTOR_FAILED\n');
      process.exitCode = 2;
    });
}
module.exports = { collect };
