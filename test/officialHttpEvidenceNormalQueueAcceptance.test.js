/* eslint-disable no-magic-numbers -- 独立正常队列迁移故障注入使用固定合成编号。 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encrypt, hash, writePrivate } = require('../src/services/officialOrderSupport');
const {
  buildMigrationInventory,
  buildMigrationPlan,
  stageMigration,
} = require('../scripts/officialPickupBackfill/migrateHttpEvidenceV2');
const { makeOfficialHttpRefreshAudit } = require('./fixtures/officialHttpRefreshAudit');

const RUN_ID = 71;
const INDEX = 1;
const ATTEMPT = 'a'.repeat(32);
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = 501;
const AUDIT_FILE = `refresh-audit-${ATTEMPT}.json`;
const SELECTION_FILE = 'http-evidence-v2-selection.json';
const PLAN_FILE = 'http-evidence-v2-plan.json';
let root;
let key;
let bodyFile;
let bodySha256;

function save(relative, value) {
  writePrivate(
    path.join(root, relative),
    Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)
  );
}

function audit(overrides = {}) {
  return {
    ...makeOfficialHttpRefreshAudit({
      attemptId: ATTEMPT,
      jobId: JOB_ID,
      orderId: ORDER_ID,
      runId: RUN_ID,
      startedAt: 100,
      finishedAt: 110,
    }),
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    systemOrderId: ORDER_ID,
    orderNumber: 'SYNTHETIC',
    source: {
      cached: false,
      file: bodyFile,
      host: 'www.apple.com.cn',
      observedAt: '2026-10-30T00:00:00.000Z',
      runId: RUN_ID,
      sha256: bodySha256,
      status: 200,
      urlHash: hash('https://www.apple.com.cn/shop/order/detail/test/W1234567890'),
    },
    ...overrides,
  };
}

function finish(overrides = {}) {
  return {
    state: 'FINISHED',
    result: { state: 'succeeded', errorCode: null },
    ...overrides,
  };
}

function reasonCounts() {
  return buildMigrationInventory({ root }).summary.reasonCounts;
}

function expectEligible() {
  expect(buildMigrationInventory({ root }).selection.runs).toEqual([
    { runId: RUN_ID, auditFile: AUDIT_FILE },
  ]);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'normal-queue-acceptance-'));
  key = crypto.randomBytes(32);
  const body = Buffer.from('synthetic');
  bodySha256 = hash(body);
  bodyFile = `body-${INDEX}-${bodySha256.slice(0, 16)}.enc`;
  const request = {
    url: 'https://www.apple.com.cn/shop/order/detail/test/W1234567890',
    method: 'GET',
    headers: {},
    body: null,
    observedAt: '2026-10-30T00:00:00.000Z',
  };
  const response = {
    url: request.url,
    status: 200,
    headers: { 'content-type': 'text/plain' },
    rawHeaders: [['content-type', 'text/plain']],
    cookies: [],
    bodyBase64: body.toString('base64'),
  };
  save('private/evidence.key', key);
  save(`evidence/run-${RUN_ID}/request-${INDEX}.enc`, encrypt(request, key));
  save(`evidence/run-${RUN_ID}/response-${INDEX}.enc`, encrypt(response, key));
  save(`evidence/run-${RUN_ID}/${bodyFile}`, encrypt(body, key));
  save(
    `evidence/run-${RUN_ID}/events.jsonl`,
    `${JSON.stringify({
      message: 'http_response', runId: RUN_ID, file: bodyFile,
      sha256: hash(body), bytes: body.length,
      observedAt: '2026-10-30T00:00:00.000Z',
    })}\n`
  );
  save(`private/${AUDIT_FILE}`, audit());
  save(`private/results/order-${ORDER_ID}-run-${RUN_ID}.json`, result());
  save(`private/finish-${JOB_ID}.json`, finish());
  save(`private/${SELECTION_FILE}`, {
    version: 1,
    kind: 'OFFICIAL_HTTP_EVIDENCE_V2_SELECTION',
    runs: [{ runId: RUN_ID, auditFile: AUDIT_FILE }],
  });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('正常队列基线可进入selection和plan', () => {
  expectEligible();
  expect(buildMigrationPlan({ root, selectionFile: SELECTION_FILE }).plan.runs).toHaveLength(1);
});

test('refresh文件名必须绑定audit attemptId', () => {
  save(`private/${AUDIT_FILE}`, audit({ attemptId: 'b'.repeat(32) }));
  expect(reasonCounts()).toMatchObject({ AUDIT_INVALID: 1 });
});

test.each([
  ['run zero', { runId: 0 }],
  ['order zero', { orderId: 0 }],
  ['job invalid', { jobId: 'not-a-uuid' }],
  ['cleanup false', { cleanupVerified: false }],
  ['collector failed', { collectorOutcome: 'HTTP_541' }],
  ['audit failed', { outcome: 'HTTP_541' }],
  ['failed stage', { failedStage: 'collector' }],
  ['egress error', { egressAfterError: 'PROBE_FAILED' }],
])('%s不得进入候选', (_name, change) => {
  save(`private/${AUDIT_FILE}`, audit(change));
  expect(buildMigrationInventory({ root }).selection.runs).toHaveLength(0);
});

test('result缺失必须固定跳过', () => {
  fs.unlinkSync(path.join(root, `private/results/order-${ORDER_ID}-run-${RUN_ID}.json`));
  expect(reasonCounts()).toMatchObject({ COLLECTOR_RESULT_UNVERIFIED: 1 });
});

test('result换成非对象必须固定跳过', () => {
  save(`private/results/order-${ORDER_ID}-run-${RUN_ID}.json`, ['wrong']);
  expect(reasonCounts()).toMatchObject({ COLLECTOR_RESULT_UNVERIFIED: 1 });
});

test('result内容换成另一order不得通过', () => {
  save(`private/results/order-${ORDER_ID}-run-${RUN_ID}.json`, result({ systemOrderId: 999 }));
  expect(buildMigrationInventory({ root }).selection.runs).toHaveLength(0);
});

test('result内容换成另一run不得通过', () => {
  save(`private/results/order-${ORDER_ID}-run-${RUN_ID}.json`, result({
    source: { ...result().source, runId: 999 },
  }));
  expect(buildMigrationInventory({ root }).selection.runs).toHaveLength(0);
});

test('result source.file换成run内不存在的正文不得通过', () => {
  save(`private/results/order-${ORDER_ID}-run-${RUN_ID}.json`, result({
    source: { ...result().source, file: 'body-999-aaaaaaaaaaaaaaaa.enc' },
  }));
  expect(buildMigrationInventory({ root }).selection.runs).toHaveLength(0);
});

test.each([
  ['sha256', { sha256: 'f'.repeat(64) }],
  ['status', { status: 500 }],
  ['host', { host: 'example.invalid' }],
  ['urlHash', { urlHash: 'f'.repeat(64) }],
  ['observedAt', { observedAt: '2026-10-30T00:01:00.000Z' }],
])('result source.%s与原始response不一致不得通过', (_field, change) => {
  save(`private/results/order-${ORDER_ID}-run-${RUN_ID}.json`, result({
    source: { ...result().source, ...change },
  }));
  expect(buildMigrationInventory({ root }).selection.runs).toHaveLength(0);
});

test.each([
  ['missing', null],
  ['STARTED', { state: 'STARTED', payload: {} }],
  ['failed', { state: 'FINISHED', result: { state: 'failed', errorCode: 'FAILED' } }],
])('finish %s不得进入候选', (_name, value) => {
  const file = path.join(root, `private/finish-${JOB_ID}.json`);
  if (value === null) fs.unlinkSync(file);
  else save(`private/finish-${JOB_ID}.json`, value);
  expect(reasonCounts()).toMatchObject({ QUEUE_COMMIT_UNVERIFIED: 1 });
});

test('同job双成功和后续audit均失败关闭', () => {
  const laterAttempt = 'b'.repeat(32);
  save(`private/refresh-audit-${laterAttempt}.json`, audit({
    attemptId: laterAttempt,
    runId: RUN_ID + 1,
    startedAt: 120,
    finishedAt: 130,
  }));
  expect(reasonCounts()).toMatchObject({ DUPLICATE_JOB_SUCCESS: 2 });
  save(`private/refresh-audit-${laterAttempt}.json`, audit({
    attemptId: laterAttempt,
    runId: RUN_ID + 1,
    outcome: 'HTTP_541',
    collectorOutcome: 'HTTP_541',
    startedAt: 120,
    finishedAt: 130,
  }));
  expect(buildMigrationInventory({ root }).selection.runs).toHaveLength(0);
});

test.each(['audit', 'result', 'finish'])('plan后%s漂移固定PLAN_MISMATCH', kind => {
  const built = buildMigrationPlan({ root, selectionFile: SELECTION_FILE });
  save(`private/${PLAN_FILE}`, built.plan);
  const planSha256 = hash(fs.readFileSync(path.join(root, 'private', PLAN_FILE)));
  save('private/STOP', 'stopped');
  if (kind === 'audit') save(`private/${AUDIT_FILE}`, { ...audit(), harmless: true });
  if (kind === 'result') {
    save(`private/results/order-${ORDER_ID}-run-${RUN_ID}.json`, { ...result(), harmless: true });
  }
  if (kind === 'finish') save(`private/finish-${JOB_ID}.json`, { ...finish(), harmless: true });
  expect(() => stageMigration({
    root,
    planFile: PLAN_FILE,
    expectedPlanSha256: planSha256,
    quiescenceCheck: () => ({
      service: 'inactive', activeContainers: 0, activeProcesses: 0,
      sourceHostHash: 'e'.repeat(64),
    }),
    testOnlyAllowQuiescenceCheck: true,
  })).toThrow('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH');
});

test('sampler旧契约仍要求cleanup removed和businessWrites零', () => {
  fs.unlinkSync(path.join(root, `private/${AUDIT_FILE}`));
  fs.unlinkSync(path.join(root, `private/results/order-${ORDER_ID}-run-${RUN_ID}.json`));
  fs.unlinkSync(path.join(root, `private/finish-${JOB_ID}.json`));
  const sample = `http-sample-1-${'c'.repeat(32)}.json`;
  save(`private/${sample}`, {
    runId: RUN_ID,
    outcome: 'SUCCEEDED',
    finishedAt: 110,
    cleanup: { removed: true },
    businessWrites: 0,
  });
  expect(buildMigrationInventory({ root }).selection.runs).toEqual([
    { runId: RUN_ID, auditFile: sample },
  ]);
  save(`private/${sample}`, {
    runId: RUN_ID,
    outcome: 'SUCCEEDED',
    finishedAt: 110,
    cleanup: { removed: false },
    businessWrites: 0,
  });
  expect(reasonCounts()).toMatchObject({ CLEANUP_UNVERIFIED: 1 });
  save(`private/${sample}`, {
    runId: RUN_ID,
    outcome: 'SUCCEEDED',
    finishedAt: 110,
    cleanup: { removed: true },
    businessWrites: 1,
  });
  expect(reasonCounts()).toMatchObject({ BUSINESS_WRITE_PRESENT: 1 });
});
