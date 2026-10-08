/* eslint-disable no-magic-numbers -- 离线合成浏览器失败、历史提交与篡改边界。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  encrypt,
  hash,
  proxyFingerprint,
  safePath,
} = require('../src/services/officialOrderSupport');
const { parseOfficialOrderDetail } = require('../src/services/officialOrderParser');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const {
  verifyBrowserFailureClose,
} = require('../scripts/officialPickupBackfill/verifyBrowserFailureClose');

let root;
let now;
let plan;
let audit;
let proof;
let state;
let events;
let key;
let bodyFile;
let proofName;
let httpResult;
let preview;
const ID = 17;
const RUN = 52;
const HTTP_RUN = 48;
const ATTEMPT = 'a'.repeat(32);
const HTTP_ATTEMPT = 'b'.repeat(32);
const APPLY_ATTEMPT = 'c'.repeat(32);
const ORDER = 'W1234567890';
const AUDIT_NAME = `browser-sample-${ID}-${ATTEMPT}.json`;
const HTTP_AUDIT_NAME = `http-sample-${ID}-${HTTP_ATTEMPT}.json`;
const PREFIX = `http-apply-${ID}-${APPLY_ATTEMPT}`;
const save = (relative, value) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
    { mode: 0o600 }
  );
};
const fileHash = relative => hash(fs.readFileSync(path.join(root, relative)));
const iso = offset => new Date((now + offset) * 1000).toISOString();
const event = (message, data = {}, at = -15) => ({
  level: 'info',
  message,
  timestamp: iso(at),
  ...data,
});
const saveAudit = () => {
  save(`private/${AUDIT_NAME}`, audit);
  proof.sampleAuditSha256 = fileHash(`private/${AUDIT_NAME}`);
};
const saveEvents = () =>
  save(
    `evidence/run-${RUN}/events.jsonl`,
    events.map(value => JSON.stringify(value)).join('\n') + '\n'
  );
const verify = () => {
  save(`private/${proofName}`, proof);
  return verifyBrowserFailureClose(root, proofName, fileHash(`private/${proofName}`), now);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-failure-close-'));
  now = Math.floor(Date.now() / 1000);
  key = Buffer.alloc(32, 9);
  plan = {
    schemaVersion: 3,
    scope: 'missing-fields',
    cutoff: null,
    startedAt: iso(-1000),
    policy: { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 },
    entries: [
      {
        id: ID,
        orderNumber: ORDER,
        rowHash: 'd'.repeat(32),
        accountKey: 'e'.repeat(32),
        dateMissing: true,
        serialsMissing: true,
        previousDate: null,
        previousDevices: [],
      },
    ],
  };
  save('private/plan.json', plan);
  const proxy = {
    host: 'synthetic.test',
    port: 1234,
    username: 'test-user',
    password: 'test-secret',
  };
  const proxyHash = proxyFingerprint({ ...proxy, provider: 'iproyal' });
  save('private/iproyal-cn.json', { entries: [proxy] });
  save(`private/request-${ID}.json`, {
    samples: [{ id: ID, orderNumber: ORDER, accountHash: 'f'.repeat(64) }],
    failures: [],
  });
  save('private/evidence.key', key);
  audit = {
    attemptId: ATTEMPT,
    auditFile: AUDIT_NAME,
    bootstrapMode: 'native-browser',
    businessWrites: 0,
    cleanup: { attempted: true, removed: true, outcome: 'REMOVED' },
    containerName: `apple-official-browser-sample-${ATTEMPT}`,
    detailRunId: RUN,
    egressAfterHash: '2'.repeat(64),
    egressHash: '1'.repeat(64),
    egressVerifiedAfter: false,
    finishedAt: now - 2,
    leaseContext: {
      provider: 'iproyal',
      proxyHash,
      egressHash: '1'.repeat(64),
      startedAt: iso(-30),
    },
    orderId: ID,
    originalOutcome: 'PROXY_CONNECTION_FAILED',
    outcome: 'EGRESS_CHANGED_OR_UNVERIFIED',
    passwordSubmitted: false,
    persistSessions: false,
    proxyHash,
    proxyIndex: 0,
    receiptEgressVerifiedAfter: false,
    runId: RUN,
    serverSessionRestored: false,
    startedAt: now - 20,
    targetOrderId: ID,
  };
  save(`private/${AUDIT_NAME}`, audit);
  const http = {
    outcome: 'SUCCEEDED',
    orderId: ID,
    targetOrderId: ID,
    runId: HTTP_RUN,
    attemptId: HTTP_ATTEMPT,
    egressHash: '3'.repeat(64),
    egressAfterHash: '3'.repeat(64),
    egressVerifiedAfter: true,
    cleanup: { removed: true },
    businessWrites: 0,
    startedAt: now - 100,
    finishedAt: now - 80,
  };
  save(`private/${HTTP_AUDIT_NAME}`, http);
  const basis = {
    version: 1,
    planSha256: fileHash('private/plan.json'),
    orderId: ID,
    originalRowHash: plan.entries[0].rowHash,
    stableRowHash: '4'.repeat(32),
    runId: HTTP_RUN,
    auditSha256: fileHash(`private/${HTTP_AUDIT_NAME}`),
  };
  const basisName = `http-apply-basis-${ID}-run-${HTTP_RUN}.json`;
  save(`private/${basisName}`, basis);
  const payload = {
    version: 1,
    planSha256: basis.planSha256,
    plan,
    entry: plan.entries[0],
    audit: http,
    evidence: { auditSha256: basis.auditSha256 },
    result: { systemOrderId: ID, orderNumber: ORDER, source: { runId: HTTP_RUN } },
  };
  save(`private/${PREFIX}-payload.json`, payload);
  preview = {
    version: 1,
    mode: 'dry-run',
    businessWrites: 0,
    orderId: ID,
    runId: HTTP_RUN,
    payloadSha256: hash(JSON.stringify(payload)),
    stableRowHash: basis.stableRowHash,
    beforeHash: '5'.repeat(32),
    devicesHash: hash('[]'),
    snapshot: { devices: [] },
    basis,
  };
  httpResult = {
    ...preview,
    mode: 'apply',
    businessWrites: 1,
    afterHash: '6'.repeat(32),
    proposedDate: '2026-09-30',
  };
  save(`private/${PREFIX}-preview.json`, preview);
  save(`private/${PREFIX}-result.json`, httpResult);
  save(`private/${PREFIX}-audit.json`, {
    ...httpResult,
    outcome: 'SUCCEEDED',
    basisFile: basisName,
    resultFile: `${PREFIX}-result.json`,
    auditFile: `${PREFIX}-audit.json`,
  });
  save(`private/http-apply-intent-${ID}.json`, {
    state: 'APPLIED',
    orderId: ID,
    runId: HTTP_RUN,
    attemptId: APPLY_ATTEMPT,
    sourceAudit: HTTP_AUDIT_NAME,
    payloadFile: `${PREFIX}-payload.json`,
    previewFile: `${PREFIX}-preview.json`,
    resultFile: `${PREFIX}-result.json`,
    auditFile: `${PREFIX}-audit.json`,
  });
  proofName = `browser-failure-proof-${ID}-${ATTEMPT}.json`;
  proof = {
    version: 1,
    kind: 'BROWSER_FAILURE_QUARANTINE',
    planSha256: basis.planSha256,
    orderId: ID,
    runId: RUN,
    batchAttemptId: '7'.repeat(32),
    sampleAttemptId: ATTEMPT,
    sampleAuditSha256: fileHash(`private/${AUDIT_NAME}`),
    httpSourceAuditSha256: basis.auditSha256,
    httpResultSha256: fileHash(`private/${PREFIX}-result.json`),
    observedAt: now - 1,
    business: {
      queriedAt: now - 1.5,
      database: 'business',
      row: {
        id: ID,
        orderNumber: ORDER,
        fullRowHash: httpResult.afterHash,
        actualPickupDate: httpResult.proposedDate,
        devices: [],
      },
    },
    research: {
      queriedAt: now - 1.2,
      database: 'apple_account_research',
      run: {
        id: RUN,
        sampleId: ID,
        mode: 'collect',
        outcome: 'PROXY_CONNECTION_FAILED',
        requests: 3,
        startedAt: iso(-19),
        finishedAt: iso(-5),
      },
      attempts: [
        {
          runId: RUN,
          orderHash: hash(ORDER),
          accountHash: 'f'.repeat(64),
          proxyHash,
          loginAt: null,
        },
      ],
    },
  };
  state = {
    runId: RUN,
    systemOrderId: ID,
    outcome: 'PROXY_CONNECTION_FAILED',
    results: [{ orderId: ID, outcome: 'PROXY_CONNECTION_FAILED', runId: RUN, attempted: true }],
    requests: 3,
    passwordSubmitted: false,
    serverSessionRestored: false,
  };
  save(`evidence/run-${RUN}/state.json`, state);
  const body = Buffer.from('<html><title>登录</title>synthetic-only</html>');
  bodyFile = `body-1-${hash(body).slice(0, 16)}.enc`;
  save(`evidence/run-${RUN}/${bodyFile}`, encrypt(body, key));
  const meta = {
    sampleId: ID,
    collectorRunId: RUN,
    status: 200,
    cached: false,
    phase: 'pre-login',
    type: 'Document',
    host: 'secure9.www.apple.com.cn',
    path: '/shop/signIn/account',
    action: null,
    urlHash: hash('https://secure9.www.apple.com.cn/shop/signIn/account?synthetic-token'),
    contentType: 'text/html',
    protocol: 'h2',
    tlsVersion: 'TLS 1.3',
    frameId: 'main-frame',
    loaderId: 'loader',
    sessionId: 'session',
  };
  events = [
    event('started', { sampleId: ID, accountHash: 'f'.repeat(64) }),
    event('proxy_preemptive_auth', { loopbackOnly: true }),
    event('target', { type: 'page' }),
    event('browser'),
    event('runtime_properties'),
  ];
  for (let index = 1; index <= 3; index++)
    events.push(
      event('permit', {
        index,
        host: meta.host,
        urlHash: index === 1 ? meta.urlHash : hash(`resource-${index}`),
        type: index === 1 ? 'Document' : 'Script',
      })
    );
  events.push(
    event('response', meta),
    event('body', { ...meta, file: bodyFile, sha256: hash(body), bytes: body.length }),
    event('request_failed', {
      type: 'Script',
      canceled: false,
      code: 'net::ERR_TUNNEL_CONNECTION_FAILED',
    }),
    event('stopped', { code: 'PROXY_CONNECTION_FAILED' }),
    event('request_failed', { type: 'Script', canceled: true, code: 'net::ERR_ABORTED' }),
    event('request_blocked', {
      code: 'REQUEST_STOPPED',
      phase: 'pre-login',
      type: 'Script',
      urlHash: hash('blocked'),
    }),
    event('session_persistence_disabled', {}, -4),
    event('finished', state, -3)
  );
  saveEvents();
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const RECEIPT_RUN = RUN + 1;
const DETAIL_URL = `https://secure9.www.apple.com.cn/shop/order/detail/Synthetic/${ORDER}`;
const INVOICE_URL = 'https://secure9.www.apple.com.cn/shop/order/print/invoice/Synthetic/Token';
const TARGET_URL = 'https://secure9.www.apple.com.cn/shop/order/sorry';
let source;
let detailResult;
let diagnosticValues;
const seal = (label, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const file = `${label}-${hash(bytes).slice(0, 16)}.enc`;
  save(`evidence/run-${RUN}/${file}`, encrypt(bytes, key));
  return { file, sha256: hash(bytes), bytes: bytes.length };
};
function saveDiagnostic(kind, value, at) {
  const prefix = `receipt-${kind}-1-`;
  for (const name of fs.readdirSync(path.join(root, `evidence/run-${RUN}`)))
    if (name.startsWith(prefix)) fs.unlinkSync(path.join(root, `evidence/run-${RUN}`, name));
  const sealed = seal(`receipt-${kind}-1`, value);
  const replacement = event(
    'receipt_diagnostic',
    { kind, detailRunId: RUN, receiptRunId: RECEIPT_RUN, ...sealed, truncated: false },
    at
  );
  const index = events.findIndex(e => e.message === 'receipt_diagnostic' && e.kind === kind);
  if (index < 0) events.push(replacement);
  else events[index] = replacement;
  saveEvents();
}

beforeEach(() => {
  fs.rmSync(path.join(root, `evidence/run-${RUN}`), { recursive: true });
  delete audit.originalOutcome;
  Object.assign(audit, {
    outcome: 'RECEIPT_SESSION_REDIRECT',
    egressAfterHash: audit.egressHash,
    egressVerifiedAfter: true,
    passwordSubmitted: true,
    receiptOutcome: 'RECEIPT_SESSION_REDIRECT',
    receiptRunId: RECEIPT_RUN,
    resultFile: `/research/private/results/order-${ID}-run-${RUN}.json`,
    receipt: {
      orderId: ID,
      detailRun: RUN,
      runId: RECEIPT_RUN,
      outcome: 'RECEIPT_SESSION_REDIRECT',
    },
  });
  proofName = `browser-failure-close-proof-${ID}-${ATTEMPT}.json`;
  delete proof.runId;
  Object.assign(proof, {
    kind: 'BROWSER_FAILURE_CLOSE',
    phase: 'DETAIL_READY_RECEIPT_FAILED',
    detailRunId: RUN,
    receiptRunId: RECEIPT_RUN,
  });
  const priorRun = proof.research.run;
  delete proof.research.run;
  proof.research.runs = [
    { ...priorRun, outcome: 'SUCCEEDED', requests: 2, finishedAt: iso(-8) },
    {
      ...priorRun,
      id: RECEIPT_RUN,
      outcome: 'RECEIPT_SESSION_REDIRECT',
      requests: 1,
      startedAt: iso(-7),
      finishedAt: iso(-5),
    },
  ];
  const attempt = proof.research.attempts[0];
  proof.research.attempts = [
    { ...attempt, loginAt: iso(-18) },
    { ...attempt, runId: RECEIPT_RUN },
  ];
  proof.research.loginPause = {
    scope: 'login',
    key: attempt.accountHash,
    reason: 'LOGIN_SUBMITTED',
    untilAt: iso(1782),
  };
  const model = buildLifecycleJson('PICKED_UP');
  model.orderDetail.orderHeader.d.invoiceUrl = INVOICE_URL;
  const body = Buffer.from(JSON.stringify(model));
  const sealed = seal('body-1', body);
  source = {
    provider: 'Apple official website',
    runId: RUN,
    collectorRunId: RUN,
    sampleId: ID,
    status: 200,
    type: 'Document',
    host: 'secure9.www.apple.com.cn',
    path: safePath(new URL(DETAIL_URL).pathname),
    action: null,
    cached: false,
    phase: 'post-login',
    contentType: 'application/json',
    urlHash: hash(DETAIL_URL),
    observedAt: iso(-9.9),
    file: sealed.file,
    sha256: sealed.sha256,
    frameId: 'frame',
    loaderId: 'loader',
    sessionId: 'session',
  };
  detailResult = { systemOrderId: ID, ...parseOfficialOrderDetail(body.toString(), ORDER), source };
  save(`private/results/order-${ID}-run-${RUN}.json`, detailResult);
  seal('official-result', detailResult);
  state = {
    runId: RUN,
    systemOrderId: ID,
    outcome: 'RECEIPT_SESSION_REDIRECT',
    results: [
      {
        orderId: ID,
        runId: RUN,
        outcome: 'SUCCEEDED',
        attempted: true,
        resultFile: audit.resultFile,
        receipt: audit.receipt,
      },
    ],
    requests: 3,
    passwordSubmitted: true,
    serverSessionRestored: false,
  };
  save(`evidence/run-${RUN}/state.json`, state);
  events = [
    event('started', { sampleId: ID, accountHash: attempt.accountHash }, -19),
    event('password_submitted', { accountHash: attempt.accountHash }, -17.9),
    event('permit', { index: 1, urlHash: hash('login'), type: 'Document' }, -17),
    event('permit', { index: 2, urlHash: source.urlHash, type: 'Document' }, -11),
    event('body', { ...source, ...sealed }, -10),
    event('stopped', { code: 'SUCCEEDED' }, -9),
  ];
  const diagnostic = (kind, url, at) => ({
    version: 1,
    kind,
    systemOrderId: ID,
    detailRunId: RUN,
    receiptRunId: RECEIPT_RUN,
    observedAt: iso(at),
    originalUrl: INVOICE_URL,
    originalUrlHash: hash(INVOICE_URL),
    sessionId: 'session',
    frameId: 'frame',
    requestId: kind === 'redirect-response' ? 'network' : 'fetch-' + kind,
    networkId: kind === 'redirect-response' ? null : 'network',
    request: { url, urlHash: hash(url), method: 'GET', headers: { referer: DETAIL_URL } },
    redirectResponse: null,
    initiator: null,
    truncated: false,
  });
  diagnosticValues = {
    initial: diagnostic('initial-request', INVOICE_URL, -6.9),
    redirect: diagnostic('redirect-response', TARGET_URL, -6),
    blocked: diagnostic('blocked-document', TARGET_URL, -5.9),
  };
  diagnosticValues.redirect.redirectResponse = {
    url: INVOICE_URL,
    urlHash: hash(INVOICE_URL),
    status: 303,
    location: TARGET_URL,
  };
  saveDiagnostic('initial-request', diagnosticValues.initial, -6.9);
  events.push(event('permit', { index: 3, urlHash: hash(INVOICE_URL), type: 'Document' }, -6.8));
  saveDiagnostic('redirect-response', diagnosticValues.redirect, -6);
  events.push(event('stopped', { code: 'RECEIPT_SESSION_REDIRECT' }, -5.9));
  saveDiagnostic('blocked-document', diagnosticValues.blocked, -5.9);
  events.push(
    event(
      'request_blocked',
      { code: 'REQUEST_STOPPED', type: 'Document', urlHash: hash(TARGET_URL) },
      -5.8
    ),
    event('session_persistence_disabled', {}, -4),
    event('finished', state, -3)
  );
  saveEvents();
  saveAudit();
});

test('关闭保留详情与HTTP来源，声明退出未验证且绝不生成收据', () => {
  const result = verify();
  expect(result).toMatchObject({
    outcome: 'BROWSER_FAILURE_CLOSE_VERIFIED',
    phase: 'DETAIL_READY_RECEIPT_FAILED',
    orderId: ID,
    detailRunId: RUN,
    receiptRunId: RECEIPT_RUN,
    processExitVerified: false,
    requestCount: 3,
    detailRequestCount: 2,
    receiptRequestCount: 1,
    egressHash: audit.egressHash,
    egressAfterHash: audit.egressHash,
  });
  expect(JSON.stringify(result)).not.toMatch(/W1234567890|example|Token|test-secret|https:/);
  expect(fs.existsSync(path.join(root, `private/receipt-probe-${ID}.json`))).toBe(false);
});
test('历史失败超过五分钟仍可用新鲜双库proof关闭，不能恢复写入资格', () => {
  const later = now + 600;
  jest.spyOn(Date, 'now').mockReturnValue((later + 1) * 1000);
  proof.observedAt = later - 1;
  proof.business.queriedAt = later - 2;
  proof.research.queriedAt = later - 2;
  save(`private/${proofName}`, proof);
  try {
    expect(
      verifyBrowserFailureClose(root, proofName, fileHash(`private/${proofName}`), later)
        .processExitVerified
    ).toBe(false);
  } finally {
    jest.restoreAllMocks();
  }
});
test.each([
  'phase',
  'proof-stale',
  'business-stale',
  'run',
  'attempts',
  'password',
  'pause',
  'devices',
  'row',
  'http-sha',
  'same-db',
])('proof边界拒绝：%s', kind => {
  if (kind === 'phase') proof.phase = 'PRE_LOGIN_FAILED';
  if (kind === 'proof-stale') proof.observedAt = now - 301;
  if (kind === 'business-stale') proof.business.queriedAt = now - 301;
  if (kind === 'run') proof.research.runs[1].outcome = 'SUCCEEDED';
  if (kind === 'attempts') proof.research.attempts.push({ ...proof.research.attempts[0] });
  if (kind === 'password') proof.research.attempts[0].loginAt = null;
  if (kind === 'pause') proof.research.loginPause.untilAt = iso(-1);
  if (kind === 'devices') proof.business.row.devices = [{ id: 'unexpected' }];
  if (kind === 'row') proof.business.row.fullRowHash = '0'.repeat(32);
  if (kind === 'http-sha') proof.httpResultSha256 = '0'.repeat(64);
  if (kind === 'same-db') proof.business.database = proof.research.database;
  expect(verify).toThrow('BROWSER_FAILURE_CLOSE_EVIDENCE_INVALID');
});
test.each([
  'outcome',
  'exit-claim',
  'egress',
  'cleanup',
  'receipt-success',
  'session',
  'password',
  'extra-key',
])('原审计边界拒绝：%s', kind => {
  if (kind === 'outcome') audit.outcome = 'STATE_WRITE_FAILED';
  if (kind === 'exit-claim') audit.processExitVerified = true;
  if (kind === 'egress') audit.egressAfterHash = '9'.repeat(64);
  if (kind === 'cleanup') audit.cleanup.removed = false;
  if (kind === 'receipt-success') audit.receipt.outcome = 'RECEIPT_CAPTURED';
  if (kind === 'session') audit.serverSessionRestored = true;
  if (kind === 'password') audit.passwordSubmitted = false;
  if (kind === 'extra-key') audit.unknown = true;
  saveAudit();
  expect(verify).toThrow('BROWSER_FAILURE_CLOSE_EVIDENCE_INVALID');
});
test.each([
  'post',
  'referer',
  'frame',
  'network',
  'location',
  'status',
  'truncated',
  'invoice',
  'origin-hash',
])('跳转原始诊断拒绝：%s', kind => {
  const value = diagnosticValues.redirect;
  if (kind === 'post') value.request.method = 'POST';
  if (kind === 'referer') value.request.headers.referer = INVOICE_URL;
  if (kind === 'frame') value.frameId = 'other';
  if (kind === 'network') value.requestId = 'other';
  if (kind === 'location') value.redirectResponse.location = INVOICE_URL;
  if (kind === 'status') value.redirectResponse.status = 200;
  if (kind === 'truncated') value.truncated = true;
  if (kind === 'invoice') value.originalUrl = DETAIL_URL;
  if (kind === 'origin-hash') value.originalUrlHash = '0'.repeat(64);
  saveDiagnostic('redirect-response', value, -6);
  expect(verify).toThrow('BROWSER_FAILURE_CLOSE_EVIDENCE_INVALID');
});
test.each([
  'state',
  'permit-after',
  'permit-target',
  'no-block',
  'body',
  'cipher',
  'extra-file',
  'result',
  'receipt-cipher',
  'receipt-metadata',
  'intent',
])('原文件或运行链不明必须阻断：%s', kind => {
  if (kind === 'state') {
    state.outcome = 'SUCCEEDED';
    save(`evidence/run-${RUN}/state.json`, state);
  }
  if (kind === 'permit-after') {
    const row = events.find(e => e.message === 'permit' && e.index === 3);
    row.timestamp = iso(-5.7);
    events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    saveEvents();
  }
  if (kind === 'permit-target') {
    events.find(e => e.message === 'permit' && e.index === 3).urlHash = hash(TARGET_URL);
    saveEvents();
  }
  if (kind === 'no-block') {
    events = events.filter(e => e.message !== 'request_blocked');
    saveEvents();
  }
  if (kind === 'body') {
    events.find(e => e.message === 'body').sha256 = '0'.repeat(64);
    saveEvents();
  }
  if (kind === 'cipher') {
    const p = path.join(root, `evidence/run-${RUN}`, source.file);
    const bytes = fs.readFileSync(p);
    bytes[12] ^= 1;
    fs.writeFileSync(p, bytes);
  }
  if (kind === 'extra-file') seal('session', {});
  if (kind === 'result') {
    detailResult.products[0].quantity += 1;
    save(`private/results/order-${ID}-run-${RUN}.json`, detailResult);
  }
  if (kind === 'receipt-cipher')
    save(`evidence/receipt-probe-${RECEIPT_RUN}.enc`, encrypt(Buffer.from('receipt'), key));
  if (kind === 'receipt-metadata') save(`private/receipt-probe-${ID}.json`, {});
  if (kind === 'intent')
    save(`private/browser-receipt-bind-intent-${ID}.json`, { state: 'APPLY_STARTED' });
  expect(verify).toThrow('BROWSER_FAILURE_CLOSE_EVIDENCE_INVALID');
});
