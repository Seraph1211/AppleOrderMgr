/* eslint-disable no-magic-numbers -- 仅允许有界的详情成功、收据跳转失败关闭合同。 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {
  decrypt,
  hash,
  proxyFingerprint,
  safePath,
  detailUrl,
} = require('../../src/services/officialOrderSupport');
const {
  parseOfficialOrderDetail,
  isOfficialOrderResponse,
} = require('../../src/services/officialOrderParser');
const { extractOfficialReceiptUrl } = require('../../src/services/officialOrderReceipt');
const MAX_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const MD5 = /^[a-f0-9]{32}$/;
const PHASE = 'DETAIL_READY_RECEIPT_FAILED';
const FAILURE = 'RECEIPT_SESSION_REDIRECT';
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
  assert(intent.runId < proof.detailRunId && MD5.test(intent.attemptId));
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
  for (const key of [
    'statusAction',
    'dateAction',
    'previousDate',
    'proposedDate',
    'proposedOfficialStatus',
    'proposedObservedAt',
    'statusSaved',
    'dateFilled',
    'sha256',
  ]) {
    assert(Object.hasOwn(applied, key) === Object.hasOwn(result, key));
    if (Object.hasOwn(result, key)) assert.deepEqual(applied[key], result[key]);
  }
  return { result, preview };
}

function verifyResearch(proof, audit, sample, history, at) {
  keys(proof.business, 'queriedAt database row');
  keys(proof.business.row, 'id orderNumber fullRowHash actualPickupDate devices');
  keys(proof.research, 'queriedAt database runs attempts loginPause');
  assert(proof.research.database === 'apple_account_research');
  assert(
    typeof proof.business.database === 'string' &&
      proof.business.database.length &&
      !/research|study/i.test(proof.business.database)
  );
  assert(Array.isArray(proof.research.runs) && proof.research.runs.length === 2);
  const [detail, receipt] = proof.research.runs;
  for (const [index, run] of proof.research.runs.entries()) {
    keys(run, 'id sampleId mode outcome requests startedAt finishedAt');
    assert(
      run.id === (index ? proof.receiptRunId : proof.detailRunId) &&
        run.sampleId === proof.orderId &&
        run.mode === 'collect' &&
        run.outcome === (index ? FAILURE : 'SUCCEEDED')
    );
    assert(positive(run.requests) && run.requests <= 300);
    assert(
      audit.startedAt <= seconds(run.startedAt) &&
        seconds(run.startedAt) <= seconds(run.finishedAt) &&
        seconds(run.finishedAt) <= audit.finishedAt
    );
  }
  assert(seconds(detail.finishedAt) <= seconds(receipt.startedAt));
  assert(seconds(audit.leaseContext.startedAt) <= seconds(detail.startedAt));
  assert(detail.requests + receipt.requests <= 300);
  for (const part of [proof.business, proof.research])
    assert(
      finite(part.queriedAt) &&
        audit.finishedAt <= part.queriedAt &&
        part.queriedAt <= proof.observedAt &&
        at - part.queriedAt >= 0 &&
        at - part.queriedAt <= 300
    );
  const row = proof.business.row;
  assert(
    row.id === proof.orderId &&
      row.orderNumber === sample.orderNumber &&
      row.fullRowHash === history.result.afterHash &&
      row.actualPickupDate === history.result.proposedDate
  );
  assert.deepEqual(row.devices, history.preview.snapshot.devices);
  assert(Array.isArray(proof.research.attempts) && proof.research.attempts.length === 2);
  for (const [index, attempt] of proof.research.attempts.entries()) {
    keys(attempt, 'runId orderHash accountHash proxyHash loginAt');
    assert(
      attempt.runId === proof.research.runs[index].id &&
        attempt.orderHash === hash(sample.orderNumber) &&
        attempt.accountHash === sample.accountHash &&
        attempt.proxyHash === audit.proxyHash
    );
    if (index) assert(attempt.loginAt === null);
    else
      assert(
        seconds(detail.startedAt) <= seconds(attempt.loginAt) &&
          seconds(attempt.loginAt) <= seconds(detail.finishedAt)
      );
  }
  const pause = proof.research.loginPause;
  keys(pause, 'scope key reason untilAt');
  assert(
    pause.scope === 'login' &&
      pause.key === sample.accountHash &&
      pause.reason === 'LOGIN_SUBMITTED'
  );
  // pause 在 login_at 之前提交：保留真实时间，不凭空把两次 SQL 时间设成同一毫秒。
  assert(
    seconds(pause.untilAt) >= seconds(detail.startedAt) + 1800 &&
      seconds(pause.untilAt) > seconds(proof.research.attempts[0].loginAt)
  );
  return { detail, receipt };
}

function verifyNativeEvidence(root, read, json, proof, audit, sample, runs) {
  const directory = `evidence/run-${proof.detailRunId}`;
  const names = fs.readdirSync(path.join(root, directory));
  assert(
    names.length >= 7 &&
      names.length <= 1000 &&
      names.includes('events.jsonl') &&
      names.includes('state.json')
  );
  const cipherName = new RegExp(
    '^(?:body-[1-9]\\d*|official-result|order-list-result|receipt-dom|' +
      'receipt-(?:initial-request|redirect-response|blocked-document)-' +
      '[1-9]\\d*)-[a-f0-9]{16}\\.enc$'
  );
  assert(
    names.every(name => ['state.json', 'events.jsonl'].includes(name) || cipherName.test(name))
  );
  const key = read('private/evidence.key');
  assert(key.length === 32);
  const decoded = new Map();
  try {
    for (const name of names.filter(name => name.endsWith('.enc'))) {
      const bytes = decrypt(read(`${directory}/${name}`), key);
      assert(hash(bytes).slice(0, 16) === /-([a-f0-9]{16})\.enc$/.exec(name)[1]);
      decoded.set(name, bytes);
    }
  } finally {
    key.fill(0);
  }
  const rawEvents = read(`${directory}/events.jsonl`);
  assert(rawEvents.at(-1) === 10);
  const events = rawEvents
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map(value => strictJson(Buffer.from(value)));
  assert(events.length > 0 && events.length <= 10000);
  let previous = seconds(runs.detail.startedAt);
  for (const event of events) {
    assert(event.level === 'info' && typeof event.message === 'string');
    if (Object.hasOwn(event, 'sampleId')) assert(event.sampleId === proof.orderId);
    if (Object.hasOwn(event, 'collectorRunId')) assert(event.collectorRunId === proof.detailRunId);
    const stamp = seconds(event.timestamp);
    assert(stamp >= previous && stamp <= audit.finishedAt);
    previous = stamp;
    assert(
      !['handler_error', 'run_error', 'permit_error', 'receipt_diagnostic_unavailable'].includes(
        event.message
      )
    );
  }
  const group = name => events.filter(event => event.message === name);
  const one = name => {
    const values = group(name);
    assert(values.length === 1);
    return values[0];
  };
  assert(events[0].message === 'started' && events.at(-1).message === 'finished');
  assert(
    one('started').sampleId === proof.orderId && one('started').accountHash === sample.accountHash
  );
  const password = one('password_submitted');
  assert(
    password.accountHash === sample.accountHash &&
      seconds(proof.research.attempts[0].loginAt) <= seconds(password.timestamp)
  );
  one('session_persistence_disabled');
  const state = json(`${directory}/state.json`);
  const receiptState = {
    orderId: proof.orderId,
    detailRun: proof.detailRunId,
    runId: proof.receiptRunId,
    outcome: FAILURE,
  };
  assert.deepEqual(audit.receipt, receiptState);
  const resultPath =
    '/research/private/results/' + `order-${proof.orderId}-run-${proof.detailRunId}.json`;
  assert.deepEqual(state, {
    runId: proof.detailRunId,
    systemOrderId: proof.orderId,
    outcome: FAILURE,
    results: [
      {
        orderId: proof.orderId,
        runId: proof.detailRunId,
        outcome: 'SUCCEEDED',
        attempted: true,
        resultFile: resultPath,
        receipt: receiptState,
      },
    ],
    requests: runs.detail.requests + runs.receipt.requests,
    passwordSubmitted: true,
    serverSessionRestored: false,
  });
  const finished = { ...one('finished') };
  for (const name of ['level', 'message', 'timestamp']) delete finished[name];
  assert.deepEqual(finished, state);
  assert(seconds(one('finished').timestamp) >= seconds(runs.receipt.finishedAt));
  const detailResult = json(`private/results/order-${proof.orderId}-run-${proof.detailRunId}.json`);
  const source = detailResult.source;
  assert(
    detailResult.systemOrderId === proof.orderId &&
      source &&
      source.runId === proof.detailRunId &&
      source.sampleId === proof.orderId &&
      source.collectorRunId === proof.detailRunId &&
      source.phase === 'post-login' &&
      source.cached === false &&
      isOfficialOrderResponse(source) &&
      /^(?:text\/html|application\/json)(?:\s*;|$)/i.test(source.contentType) &&
      SHA256.test(source.urlHash)
  );
  const body = decoded.get(source.file);
  assert(body && hash(body) === source.sha256);
  assert(
    seconds(password.timestamp) <= seconds(source.observedAt) &&
      seconds(source.observedAt) <= seconds(runs.detail.finishedAt)
  );
  const parsed = parseOfficialOrderDetail(body.toString('utf8'), sample.orderNumber);
  const stored = { ...detailResult };
  delete stored.systemOrderId;
  delete stored.source;
  assert(parsed && parsed.identityMatched === true);
  assert.deepEqual(parsed, stored);
  const officialFiles = names.filter(name => name.startsWith('official-result-'));
  assert(officialFiles.length === 1);
  assert.deepEqual(strictJson(decoded.get(officialFiles[0])), detailResult);
  const bodies = group('body');
  assert(bodies.length === names.filter(name => name.startsWith('body-')).length);
  assert(new Set(bodies.map(event => event.file)).size === bodies.length);
  for (const event of bodies) {
    const bytes = decoded.get(event.file);
    assert(
      bytes &&
        hash(bytes) === event.sha256 &&
        bytes.length === event.bytes &&
        event.sampleId === proof.orderId &&
        event.collectorRunId === proof.detailRunId &&
        event.phase !== 'receipt'
    );
  }
  const matchingBody = bodies.filter(event => event.file === source.file);
  assert(matchingBody.length === 1);
  for (const name of [
    'sampleId',
    'collectorRunId',
    'status',
    'type',
    'host',
    'path',
    'action',
    'urlHash',
    'cached',
    'contentType',
    'phase',
    'frameId',
    'loaderId',
    'sessionId',
    'sha256',
  ])
    assert(matchingBody[0][name] === source[name]);
  assert(seconds(matchingBody[0].timestamp) <= seconds(source.observedAt));
  const invoice = extractOfficialReceiptUrl(body.toString('utf8'), sample.orderNumber, source.host);
  assert(!group('response').some(event => event.phase === 'receipt' && event.status === 200));
  const domFiles = names.filter(name => name.startsWith('receipt-dom-'));
  assert(domFiles.length <= 1);
  for (const file of domFiles) {
    const dom = strictJson(decoded.get(file));
    assert(
      dom.orderId === proof.orderId &&
        dom.runId === proof.detailRunId &&
        dom.detailSha256 === source.sha256 &&
        dom.detailUrlHash === source.urlHash &&
        ['LINK_OBSERVED', 'DOM_TIMEOUT', 'LINK_UNAVAILABLE'].includes(dom.outcome)
    );
    assert(
      seconds(dom.startedAt) <= seconds(dom.finishedAt) &&
        seconds(dom.finishedAt) <= seconds(runs.detail.finishedAt)
    );
    if (Object.hasOwn(dom, 'invoiceUrl')) assert(dom.invoiceUrl === invoice.href);
  }
  const diagEvents = group('receipt_diagnostic');
  assert(diagEvents.length === 3);
  const diagnostics = {};
  for (const kind of ['initial-request', 'redirect-response', 'blocked-document']) {
    const values = diagEvents.filter(event => event.kind === kind);
    assert(values.length === 1);
    const event = values[0];
    const raw = decoded.get(event.file);
    assert(
      raw &&
        event.sha256 === hash(raw) &&
        event.bytes === raw.length &&
        event.truncated === false &&
        event.detailRunId === proof.detailRunId &&
        event.receiptRunId === proof.receiptRunId
    );
    const value = strictJson(raw);
    keys(
      value,
      'version kind systemOrderId detailRunId receiptRunId observedAt ' +
        'originalUrl originalUrlHash ' +
        'sessionId frameId requestId networkId request redirectResponse initiator truncated'
    );
    assert(
      value.version === 1 &&
        value.kind === kind &&
        value.systemOrderId === proof.orderId &&
        value.detailRunId === proof.detailRunId &&
        value.receiptRunId === proof.receiptRunId &&
        !value.truncated &&
        value.originalUrl === invoice.href &&
        value.originalUrlHash === hash(invoice.href)
    );
    keys(value.request, 'url urlHash method headers');
    assert(value.request.method === 'GET' && value.request.urlHash === hash(value.request.url));
    assert(
      value.sessionId &&
        value.frameId &&
        value.requestId &&
        seconds(runs.receipt.startedAt) <= seconds(value.observedAt) &&
        seconds(value.observedAt) <= seconds(event.timestamp) &&
        seconds(event.timestamp) <= audit.finishedAt
    );
    const referer = value.request.headers.referer;
    assert(
      typeof referer === 'string' &&
        hash(referer) === source.urlHash &&
        detailUrl(referer, source.host, sample.orderNumber) === referer &&
        safePath(new URL(referer).pathname) === source.path
    );
    assert(
      !Object.keys(value.request.headers).some(name =>
        ['cookie', 'authorization', 'proxy-authorization'].includes(name.toLowerCase())
      )
    );
    diagnostics[kind] = { value, event };
  }
  assert(
    names.filter(name =>
      /^receipt-(?:initial-request|redirect-response|blocked-document)-/.test(name)
    ).length === 3
  );
  const initial = diagnostics['initial-request'].value;
  const redirect = diagnostics['redirect-response'].value;
  const blocked = diagnostics['blocked-document'].value;
  assert(
    initial.request.url === invoice.href &&
      initial.redirectResponse === null &&
      blocked.redirectResponse === null
  );
  assert(
    initial.networkId &&
      initial.networkId === redirect.requestId &&
      redirect.requestId === blocked.networkId
  );
  assert(
    initial.sessionId === redirect.sessionId &&
      redirect.sessionId === blocked.sessionId &&
      initial.frameId === redirect.frameId &&
      redirect.frameId === blocked.frameId
  );
  assert(initial.frameId === source.frameId && initial.sessionId === source.sessionId);
  keys(redirect.redirectResponse, 'url urlHash status location');
  const response = redirect.redirectResponse;
  assert(
    response.url === invoice.href &&
      response.urlHash === hash(invoice.href) &&
      [301, 302, 303, 307, 308].includes(response.status) &&
      typeof response.location === 'string'
  );
  const target = new URL(response.location, response.url);
  assert(
    target.href === redirect.request.url &&
      target.href === blocked.request.url &&
      target.href !== invoice.href
  );
  assert(
    seconds(initial.observedAt) <= seconds(redirect.observedAt) &&
      seconds(redirect.observedAt) <= seconds(blocked.observedAt) &&
      seconds(blocked.observedAt) <= seconds(runs.receipt.finishedAt)
  );
  const stops = group('stopped');
  assert(stops.length === 2 && stops[0].code === 'SUCCEEDED' && stops[1].code === FAILURE);
  assert(seconds(stops[0].timestamp) <= seconds(runs.detail.finishedAt));
  assert(
    seconds(redirect.observedAt) <= seconds(stops[1].timestamp) &&
      seconds(stops[1].timestamp) <= seconds(diagnostics['blocked-document'].event.timestamp)
  );
  const blockedRequests = group('request_blocked').filter(
    event => event.urlHash === hash(target.href)
  );
  assert(
    blockedRequests.length >= 1 &&
      blockedRequests.every(
        event =>
          event.code === 'REQUEST_STOPPED' &&
          event.type === 'Document' &&
          seconds(event.timestamp) >= seconds(stops[1].timestamp)
      )
  );
  const permits = group('permit');
  assert(permits.length === state.requests);
  for (const [index, event] of permits.entries()) {
    assert(
      event.index === index + 1 &&
        SHA256.test(event.urlHash) &&
        seconds(event.timestamp) <= seconds(stops[1].timestamp) &&
        event.urlHash !== hash(target.href)
    );
  }
  const receiptPermits = permits.filter(
    event => seconds(event.timestamp) >= seconds(runs.receipt.startedAt)
  );
  assert(
    receiptPermits.length === runs.receipt.requests &&
      permits.length - receiptPermits.length === runs.detail.requests &&
      receiptPermits.every(
        event => event.urlHash === hash(invoice.href) && event.type === 'Document'
      )
  );
  assert(
    receiptPermits.length > 0 && seconds(receiptPermits[0].timestamp) >= seconds(initial.observedAt)
  );
  return {
    detailSha256: source.sha256,
    receiptUrlHash: hash(invoice.href),
    redirectUrlHash: hash(target.href),
    requestCount: state.requests,
    detailRequestCount: runs.detail.requests,
    receiptRequestCount: runs.receipt.requests,
    loginPauseUntil: proof.research.loginPause.untilAt,
  };
}

/** 仅关闭可证实未回写的收据导航失败；不会补造退出证明或将失败证据用于写入。 */
function verifyBrowserFailureClose(root, proofName, proofSha, at) {
  try {
    assert(
      path.isAbsolute(root) &&
        /^browser-failure-close-proof-[1-9]\d*-[a-f0-9]{32}\.json$/.test(proofName)
    );
    assert(SHA256.test(proofSha) && finite(at) && at > 0 && at <= Date.now() / 1000);
    const files = {};
    const read = relative => {
      const filename = path.join(root, relative);
      const info = fs.lstatSync(filename);
      assert(
        info.isFile() &&
          !(info.mode & 0o077) &&
          info.size <= MAX_BYTES &&
          fs.realpathSync(filename) === path.join(fs.realpathSync(root), relative)
      );
      const bytes = fs.readFileSync(filename);
      files[relative] = hash(bytes);
      return bytes;
    };
    const json = relative => strictJson(read(relative));
    const proof = json(`private/${proofName}`);
    assert(files[`private/${proofName}`] === proofSha);
    keys(
      proof,
      'version kind phase planSha256 orderId detailRunId receiptRunId ' +
        'batchAttemptId sampleAttemptId ' +
        'sampleAuditSha256 httpSourceAuditSha256 httpResultSha256 observedAt business research'
    );
    assert(
      proof.version === 1 &&
        proof.kind === 'BROWSER_FAILURE_CLOSE' &&
        proof.phase === PHASE &&
        positive(proof.orderId) &&
        positive(proof.detailRunId) &&
        positive(proof.receiptRunId) &&
        proof.receiptRunId > proof.detailRunId &&
        MD5.test(proof.batchAttemptId) &&
        MD5.test(proof.sampleAttemptId)
    );
    assert(
      proofName === `browser-failure-close-proof-${proof.orderId}-${proof.sampleAttemptId}.json`
    );
    for (const name of [
      'planSha256',
      'sampleAuditSha256',
      'httpSourceAuditSha256',
      'httpResultSha256',
    ])
      assert(SHA256.test(proof[name]));
    assert(finite(proof.observedAt) && at >= proof.observedAt && at - proof.observedAt <= 300);
    const plan = json('private/plan.json');
    assert(
      files['private/plan.json'] === proof.planSha256 &&
        plan.schemaVersion === 3 &&
        plan.scope === 'missing-fields' &&
        plan.cutoff === null
    );
    assert.deepEqual(plan.policy, { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 });
    assert(
      at >= seconds(plan.startedAt) &&
        at - seconds(plan.startedAt) <= 86400 &&
        Array.isArray(plan.entries) &&
        new Set(plan.entries.map(value => value.id)).size === plan.entries.length
    );
    const entry = plan.entries.find(value => value.id === proof.orderId);
    assert(
      entry &&
        /^W\d{10}$/.test(entry.orderNumber) &&
        MD5.test(entry.rowHash) &&
        entry.serialsMissing === true &&
        Array.isArray(entry.previousDevices) &&
        entry.previousDevices.length === 0 &&
        typeof entry.dateMissing === 'boolean' &&
        entry.dateMissing === (entry.previousDate === null)
    );
    const auditName = `browser-sample-${proof.orderId}-${proof.sampleAttemptId}.json`;
    const audit = json(`private/${auditName}`);
    assert(files[`private/${auditName}`] === proof.sampleAuditSha256);
    keys(
      audit,
      'attemptId auditFile bootstrapMode businessWrites cleanup containerName detailRunId ' +
        'egressAfterHash egressHash egressVerifiedAfter finishedAt leaseContext orderId outcome ' +
        'passwordSubmitted persistSessions proxyHash proxyIndex receipt ' +
        'receiptEgressVerifiedAfter ' +
        'receiptOutcome receiptRunId resultFile runId serverSessionRestored startedAt targetOrderId'
    );
    assert(
      audit.attemptId === proof.sampleAttemptId &&
        audit.auditFile === auditName &&
        audit.outcome === FAILURE &&
        audit.receiptOutcome === FAILURE &&
        audit.orderId === proof.orderId &&
        audit.targetOrderId === proof.orderId &&
        audit.runId === proof.detailRunId &&
        audit.detailRunId === proof.detailRunId &&
        audit.receiptRunId === proof.receiptRunId &&
        audit.bootstrapMode === 'native-browser' &&
        audit.persistSessions === false &&
        audit.passwordSubmitted === true &&
        audit.serverSessionRestored === false &&
        audit.businessWrites === 0 &&
        audit.receiptEgressVerifiedAfter === false &&
        audit.egressVerifiedAfter === true &&
        SHA256.test(audit.egressHash) &&
        audit.egressAfterHash === audit.egressHash &&
        SHA256.test(audit.proxyHash) &&
        Number.isSafeInteger(audit.proxyIndex) &&
        audit.proxyIndex >= 0
    );
    assert(
      audit.resultFile ===
        `/research/private/results/order-${proof.orderId}-run-${proof.detailRunId}.json` &&
        audit.containerName === `apple-official-browser-sample-${proof.sampleAttemptId}`
    );
    assert.deepEqual(audit.cleanup, { attempted: true, removed: true, outcome: 'REMOVED' });
    assert(
      finite(audit.startedAt) &&
        finite(audit.finishedAt) &&
        seconds(plan.startedAt) <= audit.startedAt &&
        audit.startedAt <= audit.finishedAt &&
        audit.finishedAt <= proof.observedAt &&
        audit.finishedAt - audit.startedAt <= 360
    );
    keys(audit.leaseContext, 'provider startedAt proxyHash egressHash');
    assert(
      audit.leaseContext.provider === 'iproyal' &&
        audit.leaseContext.proxyHash === audit.proxyHash &&
        audit.leaseContext.egressHash === audit.egressHash &&
        seconds(audit.leaseContext.startedAt) <= audit.finishedAt &&
        audit.finishedAt - seconds(audit.leaseContext.startedAt) <= 86400 - 30
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
    const proxies = json('private/iproyal-cn.json');
    assert(
      proxyFingerprint({ ...proxies.entries[audit.proxyIndex], provider: 'iproyal' }) ===
        audit.proxyHash
    );
    delete files['private/iproyal-cn.json'];
    const history = verifyHttpHistory(json, files, proof, plan, entry, audit);
    const runs = verifyResearch(proof, audit, sample, history, at);
    const evidence = verifyNativeEvidence(root, read, json, proof, audit, sample, runs);
    delete files['private/evidence.key'];
    for (const name of fs.readdirSync(path.join(root, 'private')))
      assert(
        !new RegExp(
          `^(?:receipt-probe-${entry.id}|http-receipt-${entry.id}-run-.*|` +
            `browser-receipt-bind-${entry.id}-.*|browser-receipt-bind-intent-${entry.id})\\.json$`
        ).test(name)
      );
    const resultNames = fs
      .readdirSync(path.join(root, 'private/results'))
      .filter(name => new RegExp(`^order-${entry.id}-run-.*\\.json$`).test(name));
    const allowedResults = [
      `order-${entry.id}-run-${proof.detailRunId}.json`,
      `order-${entry.id}-run-${history.result.runId}.json`,
    ];
    assert(resultNames.every(name => allowedResults.includes(name)));
    assert(
      !fs
        .readdirSync(path.join(root, 'evidence'))
        .includes(`receipt-probe-${proof.receiptRunId}.enc`)
    );
    return {
      outcome: 'BROWSER_FAILURE_CLOSE_VERIFIED',
      phase: PHASE,
      processExitVerified: false,
      orderId: proof.orderId,
      detailRunId: proof.detailRunId,
      receiptRunId: proof.receiptRunId,
      batchAttemptId: proof.batchAttemptId,
      sampleAttemptId: proof.sampleAttemptId,
      sampleAuditSha256: proof.sampleAuditSha256,
      httpSourceAuditSha256: proof.httpSourceAuditSha256,
      httpResultSha256: proof.httpResultSha256,
      proofSha256: proofSha,
      planSha256: proof.planSha256,
      proxyHash: audit.proxyHash,
      egressHash: audit.egressHash,
      egressAfterHash: audit.egressAfterHash,
      ...evidence,
      files,
    };
  } catch (_error) {
    throw Object.assign(new Error('BROWSER_FAILURE_CLOSE_EVIDENCE_INVALID'), {
      code: 'BROWSER_FAILURE_CLOSE_EVIDENCE_INVALID',
    });
  }
}
if (require.main === module) {
  try {
    const [root, name, sha, at, ...extra] = process.argv.slice(2);
    assert(extra.length === 0);
    process.stdout.write(
      `${JSON.stringify(verifyBrowserFailureClose(root, name, sha, Number(at)))}\n`
    );
  } catch (_error) {
    process.stderr.write('{"outcome":"BROWSER_FAILURE_CLOSE_EVIDENCE_INVALID"}\n');
    process.exitCode = 1;
  }
}
module.exports = { verifyBrowserFailureClose };
