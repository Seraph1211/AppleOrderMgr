/* eslint-disable no-magic-numbers -- 合成运行编号、权限和终态时间。 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decrypt, encrypt, hash, writePrivate } = require('../src/services/officialOrderSupport');
const { readHttpResponseEvidence } = require('../src/services/officialHttpEvidence');
const {
  makeOfficialHttpRefreshAudit,
  makeOfficialHttpRefreshResult,
} = require('./fixtures/officialHttpRefreshAudit');
const {
  buildMigrationPlan,
  buildMigrationInventory,
  stageMigration,
  finalizeMigration,
  signOffhostAttestation,
  signQuiescenceProof,
  verifyBackupForAttestation,
} = require('../scripts/officialPickupBackfill/migrateHttpEvidenceV2');

const RUN_ID = 12;
const INDEX = 1;
const AUDIT_FILE = `http-sample-1-${'a'.repeat(32)}.json`;
const REFRESH_ATTEMPT_ID = 'b'.repeat(32);
const REFRESH_AUDIT_FILE = `refresh-audit-${REFRESH_ATTEMPT_ID}.json`;
const QUEUE_JOB_ID = '11111111-1111-4111-8111-111111111111';
const QUEUE_ORDER_ID = 23;
const SELECTION_FILE = 'http-evidence-v2-selection.json';
const PLAN_FILE = 'http-evidence-v2-plan.json';
const URL = 'https://www.apple.com.cn/shop/order/detail/test/W1234567890';
let root;
let key;
let body;
let bodyFile;
const quiescenceCheck = () => ({
  service: 'inactive',
  activeContainers: 0,
  activeProcesses: 0,
  sourceHostHash: 'e'.repeat(64),
});

function save(relative, value) {
  writePrivate(
    path.join(root, relative),
    Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)
  );
}

function readVersion(responseRelative = `evidence/run-${RUN_ID}/response-${INDEX}.enc`) {
  const directory = `evidence/run-${RUN_ID}`;
  return readHttpResponseEvidence({
    responseBytes: fs.readFileSync(path.join(root, responseRelative)),
    requestBytes: fs.readFileSync(path.join(root, directory, `request-${INDEX}.enc`)),
    key,
    runId: RUN_ID,
    index: INDEX,
    expectedBodyFile: bodyFile,
    readBody: file => decrypt(fs.readFileSync(path.join(root, directory, file)), key),
  }).version;
}

function useRefreshQueueAudit() {
  fs.unlinkSync(path.join(root, 'private', AUDIT_FILE));
  save(`private/${REFRESH_AUDIT_FILE}`, makeOfficialHttpRefreshAudit({
    attemptId: REFRESH_ATTEMPT_ID,
    jobId: QUEUE_JOB_ID,
    orderId: QUEUE_ORDER_ID,
    startedAt: Date.parse('2026-10-29T00:00:00.000Z') / 1000,
    runId: RUN_ID,
    finishedAt: Date.parse('2026-10-29T00:00:02.000Z') / 1000,
  }));
  save(
    `private/results/order-${QUEUE_ORDER_ID}-run-${RUN_ID}.json`,
    makeOfficialHttpRefreshResult({
      orderId: QUEUE_ORDER_ID,
      runId: RUN_ID,
      bodyFile,
      bodySha256: hash(body),
      urlHash: hash(URL),
      observedAt: '2026-10-29T00:00:01.000Z',
    })
  );
  save(`private/finish-${QUEUE_JOB_ID}.json`, {
    state: 'FINISHED',
    result: { state: 'succeeded', errorCode: null },
  });
  save(`private/${SELECTION_FILE}`, {
    version: 1,
    kind: 'OFFICIAL_HTTP_EVIDENCE_V2_SELECTION',
    runs: [{ runId: RUN_ID, auditFile: REFRESH_AUDIT_FILE }],
  });
}

function externalQuiescence(planSha256, overrides = {}) {
  const nonce = 'd'.repeat(64);
  const proofFile = `http-evidence-v2-quiescence-${nonce}.json`;
  const toolSha256 = hash(
    fs.readFileSync(require.resolve('../scripts/officialPickupBackfill/migrateHttpEvidenceV2'))
  );
  const common = {
    nonce,
    planSha256,
    rootPathHash: 'b'.repeat(64),
    sourceHostHash: 'e'.repeat(64),
    toolSha256,
  };
  fs.mkdirSync(path.join(root, 'private/http-evidence-v2-maintenance.lock'), { mode: 0o700 });
  save('private/http-evidence-v2-maintenance.lock/owner.json', common);
  const proof = {
    version: 1,
    kind: 'OFFICIAL_HTTP_EVIDENCE_V2_QUIESCENCE',
    ...common,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    service: 'apple-official-order-queue.service',
    serviceInactive: true,
    activeContainers: 0,
    activeProcesses: 0,
    stopPresent: true,
    ...overrides,
  };
  proof.signature = signQuiescenceProof(key, proof);
  save(`private/${proofFile}`, proof);
  return { quiescenceProofFile: proofFile, maintenanceNonce: nonce };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'official-evidence-migration-'));
  key = crypto.randomBytes(32);
  body = Buffer.from('synthetic historical body');
  bodyFile = `body-${INDEX}-${hash(body).slice(0, 16)}.enc`;
  const request = {
    url: URL,
    method: 'GET',
    headers: {},
    body: null,
    observedAt: '2026-10-29T00:00:00.000Z',
  };
  const response = {
    url: URL,
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
      message: 'http_response',
      runId: RUN_ID,
      file: bodyFile,
      sha256: hash(body),
      bytes: body.length,
      observedAt: '2026-10-29T00:00:01.000Z',
    })}\n`
  );
  save(`private/${AUDIT_FILE}`, {
    runId: RUN_ID,
    outcome: 'SUCCEEDED',
    finishedAt: Date.parse('2026-10-29T00:00:02.000Z') / 1000,
    cleanup: { removed: true },
    businessWrites: 0,
  });
  save(`private/${SELECTION_FILE}`, {
    version: 1,
    kind: 'OFFICIAL_HTTP_EVIDENCE_V2_SELECTION',
    runs: [{ runId: RUN_ID, auditFile: AUDIT_FILE }],
  });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('默认计划只读，staging 双读对照后仍保留在线 v1', () => {
  const before = fs.readdirSync(path.join(root, 'private')).sort();
  const built = buildMigrationPlan({ root, selectionFile: SELECTION_FILE, now: 1_793_318_400_000 });
  expect(fs.readdirSync(path.join(root, 'private')).sort()).toEqual(before);
  save(`private/${PLAN_FILE}`, built.plan);
  const planSha256 = hash(fs.readFileSync(path.join(root, 'private', PLAN_FILE)));
  save('private/STOP', 'stopped');
  const staged = stageMigration({
    root,
    planFile: PLAN_FILE,
    expectedPlanSha256: planSha256,
    quiescenceCheck,
    testOnlyAllowQuiescenceCheck: true,
  });
  expect(staged).toMatchObject({ outcome: 'HTTP_EVIDENCE_V2_STAGED', files: 1 });
  expect(readVersion()).toBe(1);
  expect(
    readVersion(`private/http-evidence-v2-staging/${planSha256}/run-${RUN_ID}/response-1.enc`)
  ).toBe(2);
});

test('离机 v1 完整恢复通过后才替换响应，正文原件不删除', () => {
  const built = buildMigrationPlan({ root, selectionFile: SELECTION_FILE });
  save(`private/${PLAN_FILE}`, built.plan);
  const planSha256 = hash(fs.readFileSync(path.join(root, 'private', PLAN_FILE)));
  save('private/STOP', 'stopped');
  stageMigration({
    root,
    planFile: PLAN_FILE,
    expectedPlanSha256: planSha256,
    quiescenceCheck,
    testOnlyAllowQuiescenceCheck: true,
  });
  const offline = fs.mkdtempSync(path.join(os.tmpdir(), 'official-evidence-offline-'));
  try {
    fs.cpSync(root, offline, { recursive: true });
    const contentManifestSha256 = verifyBackupForAttestation({
      root: offline,
      planFile: PLAN_FILE,
      expectedPlanSha256: planSha256,
    }).contentManifestSha256;
    const attestation = {
      version: 1,
      kind: 'OFFICIAL_HTTP_EVIDENCE_OFFHOST_ATTESTATION',
      planSha256,
      sourceHostHash: 'e'.repeat(64),
      storageHostHash: 'f'.repeat(64),
      contentManifestSha256,
      verifiedAt: new Date().toISOString(),
    };
    attestation.signature = signOffhostAttestation(key, attestation);
    writePrivate(
      path.join(offline, 'private/http-evidence-offhost-attestation.json'),
      JSON.stringify(attestation)
    );
    const result = finalizeMigration({
      root,
      offlineRoot: offline,
      planFile: PLAN_FILE,
      expectedPlanSha256: planSha256,
      quiescenceCheck,
      testOnlyAllowQuiescenceCheck: true,
    });
    expect(result).toMatchObject({ outcome: 'HTTP_EVIDENCE_V2_FINALIZED', replacedResponses: 1 });
    expect(readVersion()).toBe(2);
    expect(fs.existsSync(path.join(root, `evidence/run-${RUN_ID}/${bodyFile}`))).toBe(true);
    const intent = JSON.parse(fs.readFileSync(path.join(root, result.intentFile), 'utf8'));
    expect(intent).toMatchObject({ state: 'APPLIED', planSha256, completed: [{ runId: RUN_ID }] });
  } finally {
    fs.rmSync(offline, { recursive: true, force: true });
  }
});

test('未停队列、unknown intent 或计划漂移均在写 staging 前拒绝', () => {
  const built = buildMigrationPlan({ root, selectionFile: SELECTION_FILE });
  save(`private/${PLAN_FILE}`, built.plan);
  const planSha256 = hash(fs.readFileSync(path.join(root, 'private', PLAN_FILE)));
  expect(() =>
    stageMigration({
      root,
      planFile: PLAN_FILE,
      expectedPlanSha256: planSha256,
      quiescenceCheck,
      testOnlyAllowQuiescenceCheck: true,
    })
  ).toThrow('HTTP_EVIDENCE_MIGRATION_NOT_STOPPED');
  save('private/STOP', 'stopped');
  save('private/http-apply-intent-1.json', { state: 'APPLY_STARTED' });
  expect(() =>
    stageMigration({
      root,
      planFile: PLAN_FILE,
      expectedPlanSha256: planSha256,
      quiescenceCheck,
      testOnlyAllowQuiescenceCheck: true,
    })
  ).toThrow('HTTP_EVIDENCE_MIGRATION_UNKNOWN_INTENT');
});

test('正式 staging 只接受锁 owner 与短效 HMAC proof 一致的静止证明', () => {
  const built = buildMigrationPlan({ root, selectionFile: SELECTION_FILE });
  save(`private/${PLAN_FILE}`, built.plan);
  const planSha256 = hash(fs.readFileSync(path.join(root, 'private', PLAN_FILE)));
  save('private/STOP', 'stopped');
  const maintenance = externalQuiescence(planSha256);
  expect(
    stageMigration({
      root,
      planFile: PLAN_FILE,
      expectedPlanSha256: planSha256,
      ...maintenance,
    })
  ).toMatchObject({ outcome: 'HTTP_EVIDENCE_V2_STAGED' });
  const proof = JSON.parse(
    fs.readFileSync(path.join(root, 'private', maintenance.quiescenceProofFile), 'utf8')
  );
  proof.activeContainers = 1;
  save(`private/${maintenance.quiescenceProofFile}`, proof);
  expect(() =>
    stageMigration({
      root,
      planFile: PLAN_FILE,
      expectedPlanSha256: planSha256,
      ...maintenance,
    })
  ).toThrow('HTTP_EVIDENCE_MIGRATION_QUIESCENCE_INVALID');
});

test('引用索引只扫描一次并支持嵌套目录与多行 JSONL', () => {
  save(
    'private/results/nested/references.jsonl',
    `${JSON.stringify({ runId: RUN_ID, state: 'APPLIED', event: 'finished' })}\n${JSON.stringify({
      runId: 999,
      state: 'APPLY_STARTED',
      event: 'started',
    })}\n`
  );
  save('private/batches/history/result.json', {
    items: [{ runId: RUN_ID, outcome: 'SUCCEEDED' }],
  });
  const built = buildMigrationPlan({ root, selectionFile: SELECTION_FILE });
  expect(built.plan.runs[0].references.map(item => item.file)).toEqual(
    expect.arrayContaining([
      'private/results/nested/references.jsonl',
      'private/batches/history/result.json',
    ])
  );
});

test('inventory 保留单个缺件与失败 run 为固定跳过原因', () => {
  save(`private/http-sample-2-${'b'.repeat(32)}.json`, {
    runId: 13,
    outcome: 'SUCCEEDED',
    finishedAt: Date.now() / 1000,
    cleanup: { removed: true },
    businessWrites: 0,
  });
  save(`private/http-sample-3-${'c'.repeat(32)}.json`, {
    runId: 14,
    outcome: 'HTTP_541',
    finishedAt: Date.now() / 1000,
    cleanup: { removed: true },
    businessWrites: 0,
  });
  const before = fs.readdirSync(path.join(root, 'private'), { recursive: true }).sort();
  const inventory = buildMigrationInventory({ root });
  expect(inventory.selection.runs).toEqual([{ runId: RUN_ID, auditFile: AUDIT_FILE }]);
  expect(inventory.summary.reasonCounts).toMatchObject({
    EVIDENCE_MISSING_OR_INVALID: 1,
    AUDIT_FAILED_OR_REVIEW: 1,
  });
  expect(fs.readdirSync(path.join(root, 'private'), { recursive: true }).sort()).toEqual(before);
});

test('正常队列审计以终态commit和result取代虚构businessWrites零值', () => {
  useRefreshQueueAudit();
  const inventory = buildMigrationInventory({ root });
  expect(inventory.summary).toMatchObject({ audits: 1, validAudits: 1, eligible: 1 });
  expect(inventory.selection.runs).toEqual([
    { runId: RUN_ID, auditFile: REFRESH_AUDIT_FILE },
  ]);
  const built = buildMigrationPlan({ root, selectionFile: SELECTION_FILE });
  expect(built.plan.runs[0].audit).toMatchObject({
    kind: 'refresh',
    businessWritePolicy: 'TERMINAL_QUEUE_COMMIT',
    result: { relative: `private/results/order-${QUEUE_ORDER_ID}-run-${RUN_ID}.json` },
    commit: { relative: `private/finish-${QUEUE_JOB_ID}.json` },
  });
  expect(built.plan.runs[0].audit).not.toHaveProperty('businessWrites');
  save(`private/${PLAN_FILE}`, built.plan);
  const planSha256 = hash(fs.readFileSync(path.join(root, 'private', PLAN_FILE)));
  save('private/STOP', 'stopped');
  save(`private/finish-${QUEUE_JOB_ID}.json`, {
    state: 'FINISHED',
    result: { state: 'failed', errorCode: 'REQUEST_STOPPED' },
  });
  expect(() =>
    stageMigration({
      root,
      planFile: PLAN_FILE,
      expectedPlanSha256: planSha256,
      quiescenceCheck,
      testOnlyAllowQuiescenceCheck: true,
    })
  ).toThrow('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH');
});

test('正常队列commit缺失及同job重复成功均保留跳过而不猜测归属', () => {
  useRefreshQueueAudit();
  fs.unlinkSync(path.join(root, 'private', `finish-${QUEUE_JOB_ID}.json`));
  let inventory = buildMigrationInventory({ root });
  expect(inventory.summary.reasonCounts).toMatchObject({ QUEUE_COMMIT_UNVERIFIED: 1 });
  save(`private/finish-${QUEUE_JOB_ID}.json`, {
    state: 'FINISHED',
    result: { state: 'succeeded', errorCode: null },
  });
  save(`private/refresh-audit-${'c'.repeat(32)}.json`, makeOfficialHttpRefreshAudit({
    attemptId: 'c'.repeat(32),
    jobId: QUEUE_JOB_ID,
    orderId: QUEUE_ORDER_ID,
    startedAt: Date.parse('2026-10-29T00:00:03.000Z') / 1000,
    runId: RUN_ID + 1,
    finishedAt: Date.parse('2026-10-29T00:00:04.000Z') / 1000,
  }));
  inventory = buildMigrationInventory({ root });
  expect(inventory.summary.reasonCounts).toMatchObject({ DUPLICATE_JOB_SUCCESS: 2 });
  expect(inventory.selection.runs).toHaveLength(0);
});

test('计划后无关已闭合 journal 追加不阻断，相关记录仍按摘要保护', () => {
  save(
    'private/http-batch-apply.jsonl',
    `${JSON.stringify({ runId: RUN_ID, state: 'APPLIED', event: 'finished' })}\n`
  );
  const built = buildMigrationPlan({ root, selectionFile: SELECTION_FILE });
  save(`private/${PLAN_FILE}`, built.plan);
  const planSha256 = hash(fs.readFileSync(path.join(root, 'private', PLAN_FILE)));
  fs.appendFileSync(
    path.join(root, 'private/http-batch-apply.jsonl'),
    `${JSON.stringify({ runId: 999, state: 'APPLIED', event: 'finished' })}\n`
  );
  save('private/STOP', 'stopped');
  expect(
    stageMigration({
      root,
      planFile: PLAN_FILE,
      expectedPlanSha256: planSha256,
      quiescenceCheck,
      testOnlyAllowQuiescenceCheck: true,
    })
  ).toMatchObject({ outcome: 'HTTP_EVIDENCE_V2_STAGED' });
  fs.appendFileSync(
    path.join(root, 'private/http-batch-apply.jsonl'),
    `${JSON.stringify({ runId: RUN_ID, state: 'APPLIED', event: 'finished_again' })}\n`
  );
  expect(() =>
    stageMigration({
      root,
      planFile: PLAN_FILE,
      expectedPlanSha256: planSha256,
      quiescenceCheck,
      testOnlyAllowQuiescenceCheck: true,
    })
  ).toThrow('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH');
});
