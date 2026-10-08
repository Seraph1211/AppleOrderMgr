/* eslint-disable no-magic-numbers -- 离线合成浏览器失败、历史提交与篡改边界。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encrypt, hash, proxyFingerprint } = require('../src/services/officialOrderSupport');
const {
  verifyBrowserFailureQuarantine,
} = require('../scripts/officialPickupBackfill/verifyBrowserFailureQuarantine');

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
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
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
  return verifyBrowserFailureQuarantine(root, proofName, fileHash(`private/${proofName}`), now);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-failure-quarantine-'));
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

test('动态身份、三次许可及单登录页失败可只读隔离，输出不泄露私密字段', () => {
  const result = verify();
  expect(result.outcome).toBe('BROWSER_FAILURE_QUARANTINE_VERIFIED');
  expect(result.runId).toBe(RUN);
  expect(result.files[`evidence/run-${RUN}/${bodyFile}`]).toBe(
    fileHash(`evidence/run-${RUN}/${bodyFile}`)
  );
  expect(result.files['private/evidence.key']).toBeUndefined();
  const encoded = JSON.stringify(result);
  for (const secret of [ORDER, 'test-user', 'test-secret', 'synthetic-token', '登录'])
    expect(encoded).not.toContain(secret);
});

test('首次租约在wrapper输入读取后登记且早于研究run，结束日志可晚于DB终态', () => {
  audit.leaseContext.startedAt = iso(-19.5);
  saveAudit();
  expect(verify().outcome).toBe('BROWSER_FAILURE_QUARANTINE_VERIFIED');
  audit.leaseContext.startedAt = iso(-18);
  saveAudit();
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

test('隧道先停止、19毫秒后CDP才记录连接失败的真实顺序可隔离', () => {
  const failedIndex = events.findIndex(value => value.message === 'request_failed');
  const stoppedIndex = events.findIndex(value => value.message === 'stopped');
  const failed = events[failedIndex];
  events[failedIndex] = events[stoppedIndex];
  events[stoppedIndex] = failed;
  failed.timestamp = iso(-15 + 0.019);
  for (const value of events.slice(stoppedIndex + 1)) {
    if (Date.parse(value.timestamp) < Date.parse(failed.timestamp))
      value.timestamp = failed.timestamp;
  }
  saveEvents();
  expect(verify().outcome).toBe('BROWSER_FAILURE_QUARANTINE_VERIFIED');
});

test('仅有停止后的取消事件仍不能证明代理隧道连接失败', () => {
  for (const value of events.filter(item => item.message === 'request_failed')) {
    value.code = 'net::ERR_ABORTED';
    value.canceled = true;
  }
  saveEvents();
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

function canceledImageEvents() {
  const failure = events.find(value => value.message === 'request_failed' && value.canceled);
  failure.type = 'Image';
  failure.timestamp = iso(-10);
  const blocked = events.find(value => value.message === 'request_blocked');
  blocked.type = 'Image';
  blocked.timestamp = iso(-10);
  return { failure, blocked };
}

test('停止后的Image取消及拦截可留作终止证据，不产生新许可', () => {
  canceledImageEvents();
  const failedIndex = events.findIndex(value => value.message === 'request_failed');
  const stoppedIndex = events.findIndex(value => value.message === 'stopped');
  const failed = events[failedIndex];
  events[failedIndex] = events[stoppedIndex];
  events[stoppedIndex] = failed;
  failed.timestamp = iso(-15 + 0.019);
  saveEvents();
  expect(verify().outcome).toBe('BROWSER_FAILURE_QUARANTINE_VERIFIED');
  expect(events.filter(value => value.message === 'permit')).toHaveLength(3);
});

test.each([
  [
    'not-canceled',
    ({ failure }) => {
      failure.canceled = false;
    },
  ],
  [
    'tunnel-error',
    ({ failure }) => {
      failure.code = 'net::ERR_TUNNEL_CONNECTION_FAILED';
    },
  ],
  [
    'not-stopped',
    ({ blocked }) => {
      blocked.code = 'DESTINATION_DENIED';
    },
  ],
  [
    'post-login',
    ({ blocked }) => {
      blocked.phase = 'post-login';
    },
  ],
  [
    'permit-image',
    () => {
      events.find(value => value.message === 'permit').type = 'Image';
    },
  ],
  [
    'response-image',
    () => {
      events.find(value => value.message === 'response').type = 'Image';
    },
  ],
])('Image例外不得扩展到其他形状 %s', (_name, change) => {
  change(canceledImageEvents());
  saveEvents();
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

test.each(['failure', 'blocked'])('停止前Image %s 即使错误码一致也拒绝', type => {
  const selected = canceledImageEvents()[type];
  selected.timestamp = iso(-15);
  events.find(value => value.message === 'stopped').timestamp = iso(-14);
  events.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  saveEvents();
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

test.each([
  ['outcome', 'SUCCEEDED'],
  ['originalOutcome', 'HTTP_541'],
  ['bootstrapMode', 'http-bootstrap'],
  ['passwordSubmitted', true],
  ['serverSessionRestored', true],
  ['persistSessions', true],
  ['receiptEgressVerifiedAfter', true],
  ['egressVerifiedAfter', true],
  ['egressAfterHash', null],
  ['egressAfterHash', '1'.repeat(64)],
  ['detailRunId', RUN + 1],
  ['runId', RUN + 1],
  ['orderId', ID + 1],
  ['targetOrderId', ID + 1],
  ['businessWrites', 1],
  ['proxyHash', '0'.repeat(64)],
  ['receipt', {}],
  ['cleanup', { attempted: true, removed: false, outcome: 'FAILED' }],
])('拒绝审计异常 %s', (field, value) => {
  audit[field] = value;
  saveAudit();
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

test.each([
  [
    'expired',
    () => {
      proof.observedAt = now - 301;
    },
  ],
  [
    'query-old',
    () => {
      proof.business.queriedAt = now - 301;
    },
  ],
  [
    'query-before-run-end',
    () => {
      proof.research.queriedAt = now - 6;
    },
  ],
  [
    'database',
    () => {
      proof.business.database = 'apple_account_research';
    },
  ],
  [
    'row',
    () => {
      proof.business.row.fullRowHash = '0'.repeat(32);
    },
  ],
  [
    'date',
    () => {
      proof.business.row.actualPickupDate = null;
    },
  ],
  [
    'devices',
    () => {
      proof.business.row.devices = [{}];
    },
  ],
  [
    'attempt-count',
    () => {
      proof.research.attempts.push(proof.research.attempts[0]);
    },
  ],
  [
    'login',
    () => {
      proof.research.attempts[0].loginAt = iso(-10);
    },
  ],
  [
    'account',
    () => {
      proof.research.attempts[0].accountHash = '0'.repeat(64);
    },
  ],
  [
    'requests',
    () => {
      proof.research.run.requests = 4;
    },
  ],
  [
    'requests-bound',
    () => {
      proof.research.run.requests = 301;
    },
  ],
  [
    'run-outcome',
    () => {
      proof.research.run.outcome = 'SUCCEEDED';
    },
  ],
])('拒绝数据库证明异常 %s', (_name, change) => {
  change();
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

test.each([
  ['password-event', () => events.push(event('password_submitted'))],
  ['duplicate-body', () => events.push(events.find(value => value.message === 'body'))],
  [
    'missing-permit',
    () => {
      events = events.filter(value => value.message !== 'permit' || value.index !== 3);
    },
  ],
  [
    'permit-index',
    () => {
      events.find(value => value.message === 'permit').index = 2;
    },
  ],
  [
    'post-login',
    () => {
      events.find(value => value.message === 'response').phase = 'post-login';
    },
  ],
  [
    'response-status',
    () => {
      events.find(value => value.message === 'response').status = 541;
    },
  ],
  [
    'body-digest',
    () => {
      events.find(value => value.message === 'body').sha256 = '0'.repeat(64);
    },
  ],
  [
    'body-path',
    () => {
      events.find(value => value.message === 'body').path = '/shop/order/detail/x';
    },
  ],
  [
    'finished',
    () => {
      events.find(value => value.message === 'finished').outcome = 'SUCCEEDED';
    },
  ],
  [
    'failed-code',
    () => {
      events.find(value => value.message === 'request_failed').code = 'net::ERR_FAILED';
    },
  ],
])('拒绝事件链异常 %s', (_name, change) => {
  change();
  saveEvents();
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

test.each([
  [
    'intent-state',
    `private/http-apply-intent-${ID}.json`,
    value => {
      value.state = 'APPLY_STARTED';
    },
  ],
  [
    'intent-target',
    `private/http-apply-intent-${ID}.json`,
    value => {
      value.orderId++;
    },
  ],
  [
    'basis',
    `private/http-apply-basis-${ID}-run-${HTTP_RUN}.json`,
    value => {
      value.originalRowHash = '0'.repeat(32);
    },
  ],
  [
    'payload',
    `private/${PREFIX}-payload.json`,
    value => {
      value.entry.id++;
    },
  ],
  [
    'preview',
    `private/${PREFIX}-preview.json`,
    value => {
      value.snapshot.devices = [{}];
    },
  ],
  [
    'result',
    `private/${PREFIX}-result.json`,
    value => {
      value.afterHash = '0'.repeat(32);
    },
  ],
  [
    'applied',
    `private/${PREFIX}-audit.json`,
    value => {
      value.outcome = 'FAILED';
    },
  ],
  [
    'state',
    `evidence/run-${RUN}/state.json`,
    value => {
      value.passwordSubmitted = true;
    },
  ],
])('拒绝已提交链或状态文件异常 %s', (_name, relative, change) => {
  const value = read(relative);
  change(value);
  save(relative, value);
  if (relative.endsWith('-result.json')) proof.httpResultSha256 = fileHash(relative);
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

test.each([
  '{"state":"APPLY_STARTED","state":"APPLIED"}',
  '{"state":"APPLIED","meta":{"k":1,"k":2}}',
  '{"state":"APPLIED","at":NaN}',
  '{"state":"APPLIED","at":Infinity}',
  '{"state":"APPLIED","at":1e400}',
])('拒绝歧义JSON %s', raw => {
  save(`private/http-apply-intent-${ID}.json`, raw);
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

test('拒绝密文认证失败，不把不可解密正文算作证据', () => {
  const relative = `evidence/run-${RUN}/${bodyFile}`;
  const bytes = fs.readFileSync(path.join(root, relative));
  bytes[12] ^= 1;
  save(relative, bytes);
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

test.each([
  `evidence/run-${RUN}/receipt.enc`,
  `private/results/order-${ID}-run-${RUN}.json`,
  `private/receipt-probe-${ID}.json`,
  `private/browser-receipt-bind-intent-${ID}.json`,
])('任何成功或额外文件拒绝 %s', relative => {
  save(relative, {});
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});

test('文件逃逸和过宽权限拒绝', () => {
  fs.chmodSync(path.join(root, `evidence/run-${RUN}/state.json`), 0o644);
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
  fs.chmodSync(path.join(root, `evidence/run-${RUN}/state.json`), 0o600);
  const target = path.join(root, 'other.json');
  fs.renameSync(path.join(root, `evidence/run-${RUN}/state.json`), target);
  fs.symlinkSync(target, path.join(root, `evidence/run-${RUN}/state.json`));
  expect(verify).toThrow('BROWSER_QUARANTINE_EVIDENCE_INVALID');
});
