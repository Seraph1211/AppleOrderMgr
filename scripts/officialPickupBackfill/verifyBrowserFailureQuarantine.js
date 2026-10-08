/* eslint-disable no-magic-numbers -- 有界登录前失败证据合同及时间窗口。 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { decrypt, hash, proxyFingerprint } = require('../../src/services/officialOrderSupport');

const MAX_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const MD5 = /^[a-f0-9]{32}$/;
const OFFICIAL_HOST = new RegExp(
  '^(?:[a-z0-9-]+\\.)*(?:apple\\.com\\.cn|apple\\.com|' +
    'cdn-apple\\.com|aaplimg\\.com|mzstatic\\.com)$'
);
const TYPES = ['Document', 'Script', 'Stylesheet'];
const EVENTS = new Set([
  'started',
  'proxy_preemptive_auth',
  'target',
  'browser',
  'runtime_properties',
  'permit',
  'response',
  'body',
  'stopped',
  'request_failed',
  'request_blocked',
  'session_persistence_disabled',
  'finished',
]);
const keys = (value, expected) => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), expected.split(' ').sort());
};
const seconds = value => {
  assert(typeof value === 'string');
  const result = Date.parse(value) / 1000;
  assert(Number.isFinite(result));
  return result;
};
const positive = value => Number.isSafeInteger(value) && value > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);

// JSON.parse 会接受重复键以及溢出为 Infinity 的数值；先逐层检查词法与键集合。
function strictJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let cursor = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[cursor] || '\0')) cursor += 1;
  };
  const string = () => {
    const start = cursor;
    assert(text[cursor++] === '"');
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '\\') cursor += 1;
      else if (char === '"') return JSON.parse(text.slice(start, cursor));
    }
    throw Error();
  };
  const value = depth => {
    assert(depth <= 128);
    whitespace();
    const char = text[cursor];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      cursor += 1;
      const end = char === '{' ? '}' : ']';
      const seen = new Set();
      whitespace();
      if (text[cursor] === end) {
        cursor += 1;
        return;
      }
      for (;;) {
        whitespace();
        if (char === '{') {
          const key = string();
          assert(!seen.has(key));
          seen.add(key);
          whitespace();
          assert(text[cursor++] === ':');
        }
        value(depth + 1);
        whitespace();
        const separator = text[cursor++];
        if (separator === end) return;
        assert(separator === ',');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(cursor)
    );
    assert(token);
    if (/^-?\d/.test(token[0])) assert(Number.isFinite(Number(token[0])));
    cursor += token[0].length;
  };
  value(0);
  whitespace();
  assert(cursor === text.length);
  return JSON.parse(text);
}

function verifyHttpHistory(json, files, proof, plan, entry, browserAudit) {
  const intent = json(`private/http-apply-intent-${entry.id}.json`);
  assert(intent.state === 'APPLIED' && intent.orderId === entry.id && positive(intent.runId));
  assert(intent.runId < proof.runId && MD5.test(intent.attemptId));
  const prefix = `http-apply-${entry.id}-${intent.attemptId}`;
  for (const part of ['payload', 'preview', 'result', 'audit'])
    assert(intent[`${part}File`] === `${prefix}-${part}.json`);
  assert(new RegExp(`^http-sample-${entry.id}-[a-f0-9]{32}\\.json$`).test(intent.sourceAudit));
  const source = json(`private/${intent.sourceAudit}`);
  assert(files[`private/${intent.sourceAudit}`] === proof.httpSourceAuditSha256);
  assert(
    source.outcome === 'SUCCEEDED' &&
      source.orderId === entry.id &&
      source.targetOrderId === entry.id
  );
  assert(source.runId === intent.runId && SHA256.test(source.egressHash));
  assert(source.egressVerifiedAfter === true && source.egressAfterHash === source.egressHash);
  assert(source.cleanup?.removed === true && source.businessWrites === 0);
  assert(
    intent.sourceAudit === `http-sample-${entry.id}-${source.attemptId}.json` &&
      MD5.test(source.attemptId)
  );
  assert(finite(source.startedAt) && finite(source.finishedAt));
  assert(seconds(plan.startedAt) <= source.startedAt && source.startedAt <= source.finishedAt);
  assert(source.finishedAt <= browserAudit.startedAt);
  const basisName = `http-apply-basis-${entry.id}-run-${intent.runId}.json`;
  const basis = json(`private/${basisName}`);
  keys(basis, 'version planSha256 orderId originalRowHash stableRowHash runId auditSha256');
  assert(
    basis.version === 1 && basis.planSha256 === proof.planSha256 && basis.orderId === entry.id
  );
  assert(basis.originalRowHash === entry.rowHash && MD5.test(basis.stableRowHash));
  assert(basis.runId === intent.runId && basis.auditSha256 === proof.httpSourceAuditSha256);
  const payload = json(`private/${intent.payloadFile}`);
  const preview = json(`private/${intent.previewFile}`);
  const result = json(`private/${intent.resultFile}`);
  const applied = json(`private/${intent.auditFile}`);
  assert(files[`private/${intent.resultFile}`] === proof.httpResultSha256);
  assert(payload.version === 1 && payload.planSha256 === proof.planSha256);
  assert.deepEqual(payload.plan, plan);
  assert.deepEqual(payload.entry, entry);
  assert.deepEqual(payload.audit, source);
  assert(payload.evidence?.auditSha256 === proof.httpSourceAuditSha256);
  assert(
    payload.result?.systemOrderId === entry.id && payload.result?.orderNumber === entry.orderNumber
  );
  assert(payload.result?.source?.runId === intent.runId);
  const payloadHash = hash(JSON.stringify(payload));
  for (const record of [preview, result]) {
    assert(record.version === 1 && record.orderId === entry.id && record.runId === intent.runId);
    assert(record.payloadSha256 === payloadHash && record.stableRowHash === basis.stableRowHash);
    assert(MD5.test(record.beforeHash));
    assert.deepEqual(record.basis, basis);
  }
  assert(preview.mode === 'dry-run' && preview.businessWrites === 0);
  assert(result.mode === 'apply' && [0, 1].includes(result.businessWrites));
  assert(MD5.test(result.afterHash) && result.beforeHash === preview.beforeHash);
  assert(SHA256.test(result.devicesHash) && result.devicesHash === preview.devicesHash);
  assert(Array.isArray(preview.snapshot?.devices));
  assert(hash(JSON.stringify(preview.snapshot.devices)) === result.devicesHash);
  assert(
    applied.outcome === 'SUCCEEDED' && applied.mode === 'apply' && applied.basisFile === basisName
  );
  assert(applied.resultFile === intent.resultFile && applied.auditFile === intent.auditFile);
  for (const key of ['orderId', 'runId', 'beforeHash', 'afterHash', 'businessWrites'])
    assert(applied[key] === result[key]);
  return { result, preview };
}

function verifyEvents(read, directory, state, sample, audit, runStart, runEnd, bodyFile, key) {
  const bytes = read(`${directory}/events.jsonl`);
  assert(bytes.at(-1) === 10);
  const events = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map(line => strictJson(Buffer.from(line)));
  const grouped = {};
  let previous = runStart;
  for (const event of events) {
    assert(EVENTS.has(event.message) && event.level === 'info');
    const timestamp = seconds(event.timestamp);
    assert(previous <= timestamp && timestamp <= audit.finishedAt);
    previous = timestamp;
    (grouped[event.message] ||= []).push(event);
  }
  for (const name of [
    'started',
    'proxy_preemptive_auth',
    'browser',
    'runtime_properties',
    'body',
    'stopped',
    'session_persistence_disabled',
    'finished',
  ])
    assert(grouped[name]?.length === 1);
  assert(grouped.permit?.length === state.requests);
  for (const name of ['target', 'response', 'request_failed'])
    assert(grouped[name]?.length >= 1 && grouped[name].length <= 300);
  assert((grouped.request_blocked?.length || 0) <= 300);
  assert(events[0].message === 'started' && events.at(-1).message === 'finished');
  assert(
    grouped.started[0].sampleId === sample.id &&
      grouped.started[0].accountHash === sample.accountHash
  );
  assert(grouped.proxy_preemptive_auth[0].loopbackOnly === true);
  assert(grouped.stopped[0].code === 'PROXY_CONNECTION_FAILED');
  const stoppedAt = seconds(grouped.stopped[0].timestamp);
  const finished = { ...grouped.finished[0] };
  for (const name of ['timestamp', 'level', 'message']) delete finished[name];
  assert.deepEqual(finished, state);
  assert(seconds(grouped.finished[0].timestamp) >= runEnd);
  const host = value => assert(typeof value === 'string' && OFFICIAL_HOST.test(value));
  for (const [index, event] of grouped.permit.entries()) {
    assert(event.index === index + 1 && SHA256.test(event.urlHash) && TYPES.includes(event.type));
    host(event.host);
    assert(seconds(event.timestamp) <= stoppedAt);
  }
  const documents = [];
  for (const response of grouped.response) {
    assert(response.status === 200 && response.cached === false && response.phase === 'pre-login');
    assert(
      response.sampleId === sample.id &&
        response.collectorRunId === state.runId &&
        TYPES.includes(response.type)
    );
    assert(SHA256.test(response.urlHash));
    host(response.host);
    assert(
      grouped.permit.some(
        permit => permit.urlHash === response.urlHash && permit.type === response.type
      )
    );
    if (response.type === 'Document') documents.push(response);
  }
  assert(documents.length === 1);
  const response = documents[0];
  assert(/^secure\d*\.www\.apple\.com\.cn$/.test(response.host));
  assert(response.path === '/shop/signIn/account' && response.action === null);
  assert(/^(?:text\/html)(?:;|$)/i.test(response.contentType));
  const event = grouped.body[0];
  assert(event.file === bodyFile && SHA256.test(event.sha256));
  const metadata = { ...event };
  for (const name of ['file', 'sha256', 'bytes', 'timestamp', 'level', 'message'])
    delete metadata[name];
  const responseMetadata = { ...response };
  for (const name of ['timestamp', 'level', 'message']) delete responseMetadata[name];
  assert.deepEqual(metadata, responseMetadata);
  assert(
    seconds(response.timestamp) <= seconds(event.timestamp) && seconds(event.timestamp) <= stoppedAt
  );
  const body = decrypt(read(`${directory}/${bodyFile}`), key);
  assert(body.length > 0 && body.length === event.bytes && hash(body) === event.sha256);
  assert(bodyFile === `body-1-${event.sha256.slice(0, 16)}.enc`);
  // 隧道 onFailure 可先触发 stop，Chromium 的 loadingFailed 随后才到达；
  // 两者已绑定同次审计窗口及原终态，不能要求 CDP 日志先于停止日志。
  assert(grouped.request_failed.some(event => event.code === 'net::ERR_TUNNEL_CONNECTION_FAILED'));
  for (const failure of grouped.request_failed) {
    assert(['net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_ABORTED'].includes(failure.code));
    const canceledImage =
      failure.type === 'Image' &&
      failure.code === 'net::ERR_ABORTED' &&
      failure.canceled === true &&
      seconds(failure.timestamp) >= stoppedAt;
    assert(
      (TYPES.includes(failure.type) || canceledImage) && typeof failure.canceled === 'boolean'
    );
    if (failure.code === 'net::ERR_ABORTED') assert(seconds(failure.timestamp) >= stoppedAt);
  }
  for (const blocked of grouped.request_blocked || [])
    assert(
      blocked.code === 'REQUEST_STOPPED' &&
        blocked.phase === 'pre-login' &&
        (TYPES.includes(blocked.type) ||
          (blocked.type === 'Image' && seconds(blocked.timestamp) >= stoppedAt)) &&
        SHA256.test(blocked.urlHash)
    );
}

/** 只读证明唯一已批准的登录前代理失败形状；不清除风控或制造成功结果。 */
function verifyBrowserFailureQuarantine(root, proofName, proofSha, at) {
  try {
    assert(
      path.isAbsolute(root) && /^browser-failure-proof-[1-9]\d*-[a-f0-9]{32}\.json$/.test(proofName)
    );
    assert(SHA256.test(proofSha) && finite(at) && at > 0 && at <= Date.now() / 1000);
    const files = {};
    const read = relative => {
      const filename = path.join(root, relative);
      const info = fs.lstatSync(filename);
      assert(info.isFile() && !(info.mode & 0o077) && info.size <= MAX_BYTES);
      assert(fs.realpathSync(filename) === path.join(fs.realpathSync(root), relative));
      const bytes = fs.readFileSync(filename);
      assert(bytes.length <= MAX_BYTES);
      files[relative] = hash(bytes);
      return bytes;
    };
    const json = relative => strictJson(read(relative));
    const proof = json(`private/${proofName}`);
    assert(files[`private/${proofName}`] === proofSha);
    keys(
      proof,
      'version kind planSha256 orderId runId batchAttemptId sampleAttemptId sampleAuditSha256 ' +
        'httpSourceAuditSha256 httpResultSha256 observedAt business research'
    );
    assert(proof.version === 1 && proof.kind === 'BROWSER_FAILURE_QUARANTINE');
    assert(
      positive(proof.orderId) &&
        positive(proof.runId) &&
        MD5.test(proof.batchAttemptId) &&
        MD5.test(proof.sampleAttemptId)
    );
    for (const name of [
      'planSha256',
      'sampleAuditSha256',
      'httpSourceAuditSha256',
      'httpResultSha256',
    ])
      assert(SHA256.test(proof[name]));
    assert(proofName === `browser-failure-proof-${proof.orderId}-${proof.sampleAttemptId}.json`);
    assert(finite(proof.observedAt) && at >= proof.observedAt && at - proof.observedAt <= 300);
    const plan = json('private/plan.json');
    assert(
      files['private/plan.json'] === proof.planSha256 &&
        plan.schemaVersion === 3 &&
        plan.scope === 'missing-fields' &&
        plan.cutoff === null
    );
    assert.deepEqual(plan.policy, { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 });
    assert(0 <= at - seconds(plan.startedAt) && at - seconds(plan.startedAt) <= 86400);
    assert(
      Array.isArray(plan.entries) &&
        plan.entries.length &&
        new Set(plan.entries.map(entry => entry.id)).size === plan.entries.length
    );
    const entry = plan.entries.find(item => item.id === proof.orderId);
    assert(entry && /^W\d{10}$/.test(entry.orderNumber) && MD5.test(entry.rowHash));
    assert(
      entry.serialsMissing === true &&
        Array.isArray(entry.previousDevices) &&
        entry.previousDevices.length === 0
    );
    assert(
      typeof entry.dateMissing === 'boolean' && entry.dateMissing === (entry.previousDate === null)
    );
    const auditName = `browser-sample-${proof.orderId}-${proof.sampleAttemptId}.json`;
    const audit = json(`private/${auditName}`);
    assert(files[`private/${auditName}`] === proof.sampleAuditSha256);
    keys(
      audit,
      'attemptId auditFile bootstrapMode businessWrites cleanup containerName detailRunId ' +
        'egressAfterHash egressHash egressVerifiedAfter finishedAt leaseContext orderId ' +
        'originalOutcome outcome passwordSubmitted persistSessions proxyHash proxyIndex ' +
        'receiptEgressVerifiedAfter runId serverSessionRestored startedAt targetOrderId'
    );
    assert(
      audit.outcome === 'EGRESS_CHANGED_OR_UNVERIFIED' &&
        audit.originalOutcome === 'PROXY_CONNECTION_FAILED'
    );
    assert(
      audit.bootstrapMode === 'native-browser' &&
        audit.persistSessions === false &&
        audit.passwordSubmitted === false &&
        audit.serverSessionRestored === false
    );
    assert(
      audit.orderId === entry.id &&
        audit.targetOrderId === entry.id &&
        audit.runId === proof.runId &&
        audit.detailRunId === proof.runId
    );
    assert(
      audit.attemptId === proof.sampleAttemptId &&
        audit.auditFile === auditName &&
        audit.businessWrites === 0
    );
    assert(audit.receiptEgressVerifiedAfter === false && audit.egressVerifiedAfter === false);
    assert(
      SHA256.test(audit.egressHash) &&
        SHA256.test(audit.egressAfterHash) &&
        audit.egressHash !== audit.egressAfterHash
    );
    assert(audit.containerName === `apple-official-browser-sample-${proof.sampleAttemptId}`);
    assert(
      Number.isSafeInteger(audit.proxyIndex) &&
        audit.proxyIndex >= 0 &&
        SHA256.test(audit.proxyHash)
    );
    assert.deepEqual(audit.cleanup, { attempted: true, removed: true, outcome: 'REMOVED' });
    assert(
      finite(audit.startedAt) &&
        finite(audit.finishedAt) &&
        seconds(plan.startedAt) <= audit.startedAt
    );
    assert(
      audit.startedAt <= audit.finishedAt &&
        audit.finishedAt <= proof.observedAt &&
        audit.finishedAt - audit.startedAt <= 360
    );
    const input = json(`private/request-${entry.id}.json`);
    assert(
      Array.isArray(input.samples) &&
        input.samples.length === 1 &&
        (!Object.hasOwn(input, 'failures') ||
          (Array.isArray(input.failures) && input.failures.length === 0))
    );
    const sample = input.samples[0];
    assert(
      sample.id === entry.id &&
        sample.orderNumber === entry.orderNumber &&
        SHA256.test(sample.accountHash)
    );
    const proxy = json('private/iproyal-cn.json').entries[audit.proxyIndex];
    assert(proxy);
    delete files['private/iproyal-cn.json'];
    const proxyHash = proxyFingerprint({ ...proxy, provider: 'iproyal' });
    assert(proxyHash === audit.proxyHash);
    assert(
      audit.leaseContext.provider === 'iproyal' &&
        audit.leaseContext.proxyHash === proxyHash &&
        audit.leaseContext.egressHash === audit.egressHash
    );
    assert(audit.finishedAt - seconds(audit.leaseContext.startedAt) <= 86400);
    const history = verifyHttpHistory(json, files, proof, plan, entry, audit);
    keys(proof.business, 'queriedAt database row');
    keys(proof.business.row, 'id orderNumber fullRowHash actualPickupDate devices');
    keys(proof.research, 'queriedAt database run attempts');
    const run = proof.research.run;
    keys(run, 'id sampleId mode outcome requests startedAt finishedAt');
    assert(
      run.id === proof.runId &&
        run.sampleId === entry.id &&
        run.mode === 'collect' &&
        run.outcome === audit.originalOutcome &&
        positive(run.requests) &&
        run.requests <= 300
    );
    const runStart = seconds(run.startedAt);
    const runEnd = seconds(run.finishedAt);
    assert(audit.startedAt <= runStart && runStart <= runEnd && runEnd <= audit.finishedAt);
    assert(seconds(audit.leaseContext.startedAt) <= runStart);
    assert(proof.research.database === 'apple_account_research');
    assert(
      typeof proof.business.database === 'string' &&
        proof.business.database.length &&
        !/research|study/i.test(proof.business.database)
    );
    for (const part of [proof.business, proof.research])
      assert(
        finite(part.queriedAt) &&
          runEnd <= part.queriedAt &&
          part.queriedAt <= proof.observedAt &&
          at - part.queriedAt <= 300
      );
    const row = proof.business.row;
    assert(
      row.id === entry.id &&
        row.orderNumber === entry.orderNumber &&
        row.fullRowHash === history.result.afterHash &&
        row.actualPickupDate === history.result.proposedDate
    );
    assert.deepEqual(row.devices, history.preview.snapshot.devices);
    assert(Array.isArray(proof.research.attempts) && proof.research.attempts.length === 1);
    const attempt = proof.research.attempts[0];
    keys(attempt, 'runId orderHash accountHash proxyHash loginAt');
    assert(
      attempt.runId === proof.runId &&
        attempt.orderHash === hash(entry.orderNumber) &&
        attempt.accountHash === sample.accountHash &&
        attempt.proxyHash === proxyHash &&
        attempt.loginAt === null
    );
    const directory = `evidence/run-${proof.runId}`;
    const names = fs.readdirSync(path.join(root, directory)).sort();
    assert(names.length === 3 && names.includes('events.jsonl') && names.includes('state.json'));
    const bodyFile = names.find(name => /^body-1-[a-f0-9]{16}\.enc$/.test(name));
    assert(bodyFile);
    const state = json(`${directory}/state.json`);
    assert.deepEqual(state, {
      runId: proof.runId,
      systemOrderId: entry.id,
      outcome: audit.originalOutcome,
      results: [
        { orderId: entry.id, outcome: audit.originalOutcome, runId: proof.runId, attempted: true },
      ],
      requests: run.requests,
      passwordSubmitted: false,
      serverSessionRestored: false,
    });
    for (const relative of [
      `private/results/order-${entry.id}-run-${proof.runId}.json`,
      `private/receipt-probe-${entry.id}.json`,
      `private/browser-receipt-bind-intent-${entry.id}.json`,
    ])
      assert(!fs.existsSync(path.join(root, relative)));
    const key = read('private/evidence.key');
    delete files['private/evidence.key'];
    assert(key.length === 32);
    try {
      verifyEvents(read, directory, state, sample, audit, runStart, runEnd, bodyFile, key);
    } finally {
      key.fill(0);
    }
    return {
      outcome: 'BROWSER_FAILURE_QUARANTINE_VERIFIED',
      orderId: proof.orderId,
      runId: proof.runId,
      batchAttemptId: proof.batchAttemptId,
      sampleAttemptId: proof.sampleAttemptId,
      sampleAuditSha256: proof.sampleAuditSha256,
      httpSourceAuditSha256: proof.httpSourceAuditSha256,
      httpResultSha256: proof.httpResultSha256,
      proofSha256: proofSha,
      planSha256: proof.planSha256,
      proxyHash,
      egressHash: audit.egressHash,
      egressAfterHash: audit.egressAfterHash,
      files,
    };
  } catch (_error) {
    throw Object.assign(new Error('BROWSER_QUARANTINE_EVIDENCE_INVALID'), {
      code: 'BROWSER_QUARANTINE_EVIDENCE_INVALID',
    });
  }
}

if (require.main === module) {
  try {
    const [root, proofName, proofSha, at, ...extra] = process.argv.slice(2);
    assert(extra.length === 0);
    process.stdout.write(
      `${JSON.stringify(verifyBrowserFailureQuarantine(root, proofName, proofSha, Number(at)))}\n`
    );
  } catch (_error) {
    process.stderr.write('{"outcome":"BROWSER_QUARANTINE_EVIDENCE_INVALID"}\n');
    process.exitCode = 1;
  }
}
module.exports = { verifyBrowserFailureQuarantine };
