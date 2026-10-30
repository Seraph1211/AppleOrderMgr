/* eslint-disable no-magic-numbers -- 合成证据边界和故障注入需要明确数值。 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EVIDENCE_VERSION_V2,
  MAX_BODY_BYTES,
  createHttpResponseEvidenceV2,
  readHttpResponseEvidence,
} = require('../src/services/officialHttpEvidence');
const { OfficialOrderHttpCollector } = require('../src/services/officialOrderHttpCollector');
const {
  decrypt,
  encrypt,
  hash,
  writePrivate,
} = require('../src/services/officialOrderSupport');
const {
  buildMigrationInventory,
  buildMigrationPlan,
  stageMigration,
  finalizeMigration,
  signOffhostAttestation,
  verifyBackupForAttestation,
} = require('../scripts/officialPickupBackfill/migrateHttpEvidenceV2');

function fixture() {
  const key = crypto.randomBytes(32);
  const request = {
    url: 'https://www.apple.com.cn/shop/order/detail/test/W1234567890',
    method: 'GET',
    headers: { Accept: 'application/json' },
    body: null,
    observedAt: '2026-10-30T01:02:03.000Z',
  };
  const requestPlaintext = Buffer.from(JSON.stringify(request));
  const body = Buffer.from('{"head":{"status":"SUCCESS"},"body":{"orders":[]}}');
  const index = 3;
  const runId = 17;
  const file = `body-${index}-${hash(body).slice(0, 16)}.enc`;
  const response = {
    url: request.url,
    status: 200,
    headers: { 'content-type': 'application/json' },
    rawHeaders: [['content-type', 'application/json']],
    cookies: [],
    bodyBase64: body.toString('base64'),
  };
  const observedAt = '2026-10-30T01:02:04.000Z';
  const v2 = createHttpResponseEvidenceV2({
    response,
    requestBytes: requestPlaintext,
    runId,
    index,
    observedAt,
    bodyFile: file,
    body,
  });
  return { key, request, requestPlaintext, body, file, response, observedAt, index, runId, v2 };
}

function readEvidence(sample, value, overrides = {}) {
  const body = overrides.storedBody === undefined ? sample.body : overrides.storedBody;
  const readBody = overrides.readBody || jest.fn(() => body);
  return readHttpResponseEvidence({
    responseBytes: encrypt(value, overrides.key || sample.key),
    requestBytes: encrypt(overrides.request || sample.requestPlaintext, sample.key),
    key: sample.key,
    runId: overrides.runId || sample.runId,
    index: overrides.index || sample.index,
    readBody,
    expectedBodyFile:
      overrides.expectedBodyFile === undefined ? sample.file : overrides.expectedBodyFile,
  });
}

function expectCode(code, callback) {
  try {
    callback();
  } catch (error) {
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

test('v1 与 v2 双读返回同一份原始正文且 v2 不重复存储正文', () => {
  const sample = fixture();
  const v1 = readEvidence(sample, sample.response);
  const v2 = readEvidence(sample, sample.v2);

  expect(v1.version).toBe(1);
  expect(v2.version).toBe(EVIDENCE_VERSION_V2);
  expect(v1.body.equals(sample.body)).toBe(true);
  expect(v2.body.equals(sample.body)).toBe(true);
  expect(v1.bodyFile).toBe(sample.file);
  expect(v2.bodyFile).toBe(sample.file);
  expect(v2.request).toEqual(v1.request);
  expect(v2.response).toMatchObject({
    url: sample.response.url,
    status: sample.response.status,
    observedAt: sample.observedAt,
  });
  expect(sample.v2.bodyBase64).toBeUndefined();
  expect(sample.v2.body).toEqual({
    encoding: 'identity',
    file: sample.file,
    sha256: hash(sample.body),
    length: sample.body.length,
  });
  expect(v1.responsePlaintext.equals(Buffer.from(JSON.stringify(sample.response)))).toBe(true);
  expect(v2.responsePlaintext.equals(Buffer.from(JSON.stringify(sample.v2)))).toBe(true);
});

test.each([
  [
    'runId',
    'HTTP_EVIDENCE_BINDING_INVALID',
    false,
    value => ({ ...value, runId: value.runId + 1 }),
  ],
  [
    'index',
    'HTTP_EVIDENCE_BINDING_INVALID',
    false,
    value => ({ ...value, index: value.index + 1 }),
  ],
  [
    'request digest',
    'HTTP_EVIDENCE_BINDING_INVALID',
    false,
    value => ({ ...value, request: { ...value.request, sha256: '0'.repeat(64) } }),
  ],
  [
    'body digest',
    'HTTP_EVIDENCE_BINDING_INVALID',
    false,
    value => ({ ...value, body: { ...value.body, sha256: '0'.repeat(64) } }),
  ],
  [
    'body length',
    'HTTP_EVIDENCE_BODY_INVALID',
    true,
    value => ({ ...value, body: { ...value.body, length: value.body.length + 1 } }),
  ],
  [
    'body encoding',
    'HTTP_EVIDENCE_BINDING_INVALID',
    false,
    value => ({ ...value, body: { ...value.body, encoding: 'gzip' } }),
  ],
  [
    'body file',
    'HTTP_EVIDENCE_BINDING_INVALID',
    false,
    value => ({ ...value, body: { ...value.body, file: '../outside.enc' } }),
  ],
  [
    'request file',
    'HTTP_EVIDENCE_BINDING_INVALID',
    false,
    value => ({ ...value, request: { ...value.request, file: '../request.enc' } }),
  ],
  [
    'response URL',
    'HTTP_EVIDENCE_BINDING_INVALID',
    true,
    value => ({ ...value, url: 'https://www.apple.com.cn/other' }),
  ],
  [
    'observation time',
    'HTTP_EVIDENCE_BINDING_INVALID',
    true,
    value => ({ ...value, observedAt: '2026-10-30T01:02:02.000Z' }),
  ],
  [
    'duplicate body',
    'HTTP_EVIDENCE_BINDING_INVALID',
    false,
    value => ({ ...value, bodyBase64: 'eA==' }),
  ],
])('v2 %s 绑定被篡改时拒绝', (_name, code, bodyReadExpected, mutate) => {
  const sample = fixture();
  const readBody = jest.fn(() => sample.body);
  expectCode(code, () => readEvidence(sample, mutate(sample.v2), { readBody }));
  expect(readBody).toHaveBeenCalledTimes(bodyReadExpected ? 1 : 0);
});

test('v2 正文缺失、长度不符或摘要不符不能当作空结果', () => {
  const sample = fixture();
  for (const body of [undefined, Buffer.alloc(0), Buffer.from('tampered')]) {
    expectCode('HTTP_EVIDENCE_BODY_INVALID', () =>
      readEvidence(sample, sample.v2, {
        readBody: jest.fn(() => body),
      })
    );
  }
});

test('v1 仍校验独立正文且拒绝非规范 Base64', () => {
  const sample = fixture();
  expectCode('HTTP_EVIDENCE_BODY_INVALID', () =>
    readEvidence(sample, { ...sample.response, bodyBase64: '***' })
  );
  expectCode('HTTP_EVIDENCE_BODY_INVALID', () =>
    readEvidence(sample, sample.response, { storedBody: Buffer.from('tampered') })
  );
});

test('v2 未知格式与超限元数据失败关闭且不读正文', () => {
  const sample = fixture();
  expectCode('HTTP_EVIDENCE_FORMAT_UNKNOWN', () =>
    readEvidence(sample, { ...sample.response, evidenceVersion: 3 })
  );
  const readBody = jest.fn(() => sample.body);
  expectCode('HTTP_EVIDENCE_BINDING_INVALID', () =>
    readEvidence(
      sample,
      { ...sample.v2, body: { ...sample.v2.body, length: MAX_BODY_BYTES + 1 } },
      { readBody }
    )
  );
  expect(readBody).not.toHaveBeenCalled();
});

test('v2 创建时拒绝请求、响应和正文不一致', () => {
  const sample = fixture();
  expectCode('HTTP_EVIDENCE_BODY_INVALID', () =>
    createHttpResponseEvidenceV2({
      response: { ...sample.response, bodyBase64: Buffer.from('other').toString('base64') },
      requestBytes: sample.requestPlaintext,
      runId: sample.runId,
      index: sample.index,
      observedAt: sample.observedAt,
      bodyFile: sample.file,
      body: sample.body,
    })
  );
  expectCode('HTTP_EVIDENCE_BINDING_INVALID', () =>
    createHttpResponseEvidenceV2({
      response: { ...sample.response, url: 'https://www.apple.com.cn/other' },
      requestBytes: sample.requestPlaintext,
      runId: sample.runId,
      index: sample.index,
      observedAt: sample.observedAt,
      bodyFile: sample.file,
      body: sample.body,
    })
  );
});

test('密文或密钥认证失败不会降级为 v1 或空正文', () => {
  const sample = fixture();
  const responseBytes = encrypt(sample.v2, sample.key);
  responseBytes[responseBytes.length - 1] ^= 1;
  expectCode('ENCRYPTED_STATE_INVALID', () =>
    readHttpResponseEvidence({
      responseBytes,
      requestBytes: encrypt(sample.requestPlaintext, sample.key),
      key: sample.key,
      runId: sample.runId,
      index: sample.index,
      readBody: () => sample.body,
      expectedBodyFile: sample.file,
    })
  );
});

test('collector 缺省保留 v1，只有显式开关才写入单正文 v2', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-evidence-writer-'));
  try {
    const key = crypto.randomBytes(32);
    const url = 'https://www.apple.com.cn/shop/order/detail/test/W1234567890';
    const body = Buffer.from('{"synthetic":true}');
    const transport = {
      request: jest.fn(input =>
        Promise.resolve({
          url: input.url,
          status: 200,
          headers: { 'content-type': 'application/json' },
          rawHeaders: [['content-type', 'application/json']],
          cookies: [],
          bodyBase64: body.toString('base64'),
        })
      ),
    };
    const versions = [];
    for (const [runId, evidenceVersion] of [
      [1, undefined],
      [2, 2],
    ]) {
      const collector = new OfficialOrderHttpCollector({
        transport,
        sample: {},
        root,
        key,
        runId,
        collectReceipt: false,
        evidenceVersion,
      });
      await collector.request(url);
      const response = JSON.parse(
        decrypt(fs.readFileSync(`${root}/evidence/run-${runId}/response-1.enc`), key)
      );
      versions.push(response.evidenceVersion || 1);
      if (evidenceVersion === 2) {
        expect(response.bodyBase64).toBeUndefined();
        expect(response.body).toMatchObject({ encoding: 'identity', length: body.length });
      } else {
        expect(response.bodyBase64).toBe(body.toString('base64'));
      }
    }
    expect(versions).toEqual([1, 2]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const MIGRATION_RUN_ID = 23;
const MIGRATION_INDEX = 1;
const MIGRATION_AUDIT = `http-sample-23-${'a'.repeat(32)}.json`;
const MIGRATION_SELECTION = 'qa-http-evidence-selection.json';
const MIGRATION_PLAN = 'qa-http-evidence-plan.json';
const MIGRATION_URL = 'https://www.apple.com.cn/shop/order/detail/test/W1234567890';
const MIGRATION_SOURCE_HOST_HASH = 'e'.repeat(64);

function quiescenceCheck() {
  return {
    service: 'inactive',
    activeContainers: 0,
    activeProcesses: 0,
    sourceHostHash: MIGRATION_SOURCE_HOST_HASH,
  };
}

function stageOptions(sample, planSha256) {
  return {
    root: sample.root,
    planFile: MIGRATION_PLAN,
    expectedPlanSha256: planSha256,
    quiescenceCheck,
    testOnlyAllowQuiescenceCheck: true,
  };
}

function attestOffline(offline, planSha256) {
  const offlineKey = fs.readFileSync(path.join(offline, 'private/evidence.key'));
  const contentManifestSha256 = verifyBackupForAttestation({
    root: offline,
    planFile: MIGRATION_PLAN,
    expectedPlanSha256: planSha256,
  }).contentManifestSha256;
  const attestation = {
    version: 1,
    kind: 'OFFICIAL_HTTP_EVIDENCE_OFFHOST_ATTESTATION',
    planSha256,
    sourceHostHash: MIGRATION_SOURCE_HOST_HASH,
    storageHostHash: 'f'.repeat(64),
    contentManifestSha256,
    verifiedAt: new Date().toISOString(),
  };
  attestation.signature = signOffhostAttestation(offlineKey, attestation);
  writePrivate(
    path.join(offline, 'private/http-evidence-offhost-attestation.json'),
    JSON.stringify(attestation)
  );
}

function finalizeOptions(sample, offline, planSha256) {
  return {
    ...stageOptions(sample, planSha256),
    offlineRoot: offline,
  };
}

function saveMigration(root, relative, value) {
  writePrivate(
    path.join(root, relative),
    Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)
  );
}

function migrationFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-evidence-migration-qa-'));
  const key = crypto.randomBytes(32);
  const body = Buffer.from('independent historical evidence');
  const bodyFile = `body-${MIGRATION_INDEX}-${hash(body).slice(0, 16)}.enc`;
  const directory = `evidence/run-${MIGRATION_RUN_ID}`;
  const request = {
    url: MIGRATION_URL,
    method: 'GET',
    headers: {},
    body: null,
    observedAt: '2026-10-20T00:00:00.000Z',
  };
  const response = {
    url: MIGRATION_URL,
    status: 200,
    headers: { 'content-type': 'text/plain' },
    rawHeaders: [['content-type', 'text/plain']],
    cookies: [],
    bodyBase64: body.toString('base64'),
  };
  saveMigration(root, 'private/evidence.key', key);
  saveMigration(root, `${directory}/request-${MIGRATION_INDEX}.enc`, encrypt(request, key));
  saveMigration(root, `${directory}/response-${MIGRATION_INDEX}.enc`, encrypt(response, key));
  saveMigration(root, `${directory}/${bodyFile}`, encrypt(body, key));
  saveMigration(
    root,
    `${directory}/events.jsonl`,
    `${JSON.stringify({
      message: 'http_response',
      runId: MIGRATION_RUN_ID,
      file: bodyFile,
      sha256: hash(body),
      bytes: body.length,
      observedAt: '2026-10-20T00:00:01.000Z',
    })}\n`
  );
  saveMigration(root, `private/${MIGRATION_AUDIT}`, {
    runId: MIGRATION_RUN_ID,
    outcome: 'SUCCEEDED',
    finishedAt: Date.parse('2026-10-20T00:00:02.000Z') / 1000,
    cleanup: { removed: true },
    businessWrites: 0,
  });
  saveMigration(root, `private/${MIGRATION_SELECTION}`, {
    version: 1,
    kind: 'OFFICIAL_HTTP_EVIDENCE_V2_SELECTION',
    runs: [{ runId: MIGRATION_RUN_ID, auditFile: MIGRATION_AUDIT }],
  });

  function version(responseFile = `${directory}/response-${MIGRATION_INDEX}.enc`) {
    return readHttpResponseEvidence({
      responseBytes: fs.readFileSync(path.join(root, responseFile)),
      requestBytes: fs.readFileSync(path.join(root, directory, `request-${MIGRATION_INDEX}.enc`)),
      key,
      runId: MIGRATION_RUN_ID,
      index: MIGRATION_INDEX,
      expectedBodyFile: bodyFile,
      readBody: file => decrypt(fs.readFileSync(path.join(root, directory, file)), key),
    }).version;
  }

  return { root, key, body, bodyFile, directory, version };
}

function fileTreeState(root) {
  const rows = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      const relative = path.relative(root, file);
      if (stat.isDirectory()) visit(file);
      else rows.push([relative, stat.mode & 0o777, hash(fs.readFileSync(file))]);
    }
  }
  visit(root);
  return rows;
}

function prepareMigration(sample) {
  const built = buildMigrationPlan({
    root: sample.root,
    selectionFile: MIGRATION_SELECTION,
    now: Date.parse('2026-10-30T00:00:00.000Z'),
  });
  saveMigration(sample.root, `private/${MIGRATION_PLAN}`, built.plan);
  const planSha256 = hash(fs.readFileSync(path.join(sample.root, 'private', MIGRATION_PLAN)));
  return { ...built, planSha256 };
}

test.each([
  ['active reference', 'ACTIVE_OR_UNKNOWN_REFERENCE'],
  ['pinned reference', 'PINNED_REFERENCE'],
  ['duplicate audit', 'DUPLICATE_RUN_ID'],
  ['global unknown intent', 'GLOBAL_UNKNOWN_INTENT'],
])('inventory 对 %s 使用固定排除原因且不误入 selection', (faultType, reasonCode) => {
  const sample = migrationFixture();
  try {
    if (faultType === 'active reference') {
      saveMigration(sample.root, 'private/references/active.json', {
        nested: { runId: MIGRATION_RUN_ID, state: 'COMMIT_UNKNOWN' },
      });
    } else if (faultType === 'pinned reference') {
      saveMigration(sample.root, 'private/references/pinned.jsonl', `${JSON.stringify({
        nested: { runId: MIGRATION_RUN_ID, pinned: true },
      })}\n`);
    } else if (faultType === 'duplicate audit') {
      saveMigration(sample.root, `private/http-sample-99-${'b'.repeat(32)}.json`, {
        runId: MIGRATION_RUN_ID,
        outcome: 'SUCCEEDED',
        finishedAt: Date.parse('2026-10-20T00:00:03.000Z') / 1000,
        cleanup: { removed: true },
        businessWrites: 0,
      });
    } else {
      saveMigration(sample.root, 'private/http-apply-intent-global.json', {
        state: 'COMMIT_UNKNOWN',
      });
    }
    const before = fileTreeState(sample.root);
    const inventory = buildMigrationInventory({ root: sample.root });
    expect(inventory.selection.runs).toEqual([]);
    expect(inventory.summary.reasonCounts[reasonCode]).toBeGreaterThan(0);
    expect(inventory.skipped.some(item => item.reasonCode === reasonCode)).toBe(true);
    expect(fileTreeState(sample.root)).toEqual(before);
  } finally {
    fs.rmSync(sample.root, { recursive: true, force: true });
  }
});

test('历史迁移计划为零写入且绑定原证据与 guard', () => {
  const sample = migrationFixture();
  try {
    const before = fileTreeState(sample.root);
    const built = buildMigrationPlan({
      root: sample.root,
      selectionFile: MIGRATION_SELECTION,
      now: Date.parse('2026-10-30T00:00:00.000Z'),
    });
    expect(fileTreeState(sample.root)).toEqual(before);
    expect(built.plan).toMatchObject({
      kind: 'OFFICIAL_HTTP_EVIDENCE_V2_MIGRATION_PLAN',
      selectionFile: MIGRATION_SELECTION,
      keySha256: hash(sample.key),
      runs: [{ runId: MIGRATION_RUN_ID }],
    });
    expect(built.plan.runs[0].responses).toHaveLength(1);
  } finally {
    fs.rmSync(sample.root, { recursive: true, force: true });
  }
});

test('STOP、未知 intent 或日志漂移都在 staging 写入前阻断', () => {
  for (const faultType of ['stop', 'intent', 'journal']) {
    const sample = migrationFixture();
    try {
      const { planSha256 } = prepareMigration(sample);
      if (faultType !== 'stop') saveMigration(sample.root, 'private/STOP', 'stopped');
      if (faultType === 'intent') {
        saveMigration(sample.root, 'private/http-apply-intent-99.json', {
          state: 'COMMIT_UNKNOWN',
        });
      }
      if (faultType === 'journal') {
        saveMigration(sample.root, 'private/http-batch-apply.jsonl', '{"state":"APPLIED"}\n');
      }
      expect(() =>
        stageMigration(stageOptions(sample, planSha256))
      ).toThrow();
      expect(sample.version()).toBe(1);
      expect(fs.existsSync(path.join(sample.root, 'private/http-evidence-v2-staging'))).toBe(false);
    } finally {
      fs.rmSync(sample.root, { recursive: true, force: true });
    }
  }
});

test('计划后其他 run 的已闭合 journal 追加不阻断选中 run', () => {
  const sample = migrationFixture();
  try {
    const { planSha256 } = prepareMigration(sample);
    saveMigration(sample.root, 'private/STOP', 'stopped');
    saveMigration(
      sample.root,
      'private/http-batch-apply.jsonl',
      `${JSON.stringify({ runId: MIGRATION_RUN_ID + 100, state: 'APPLIED' })}\n`
    );
    expect(stageMigration(stageOptions(sample, planSha256))).toMatchObject({
      outcome: 'HTTP_EVIDENCE_V2_STAGED',
      files: 1,
    });
  } finally {
    fs.rmSync(sample.root, { recursive: true, force: true });
  }
});

test.each([
  ['same selected run', { runId: MIGRATION_RUN_ID, state: 'APPLIED' }, 'PLAN_MISMATCH'],
  ['unscoped record', { state: 'APPLIED' }, 'GUARD_CHANGED'],
])('计划后 %s journal 追加仍失败关闭', (_label, record, codeSuffix) => {
  const sample = migrationFixture();
  try {
    const { planSha256 } = prepareMigration(sample);
    saveMigration(sample.root, 'private/STOP', 'stopped');
    saveMigration(
      sample.root,
      'private/http-batch-apply.jsonl',
      `${JSON.stringify(record)}\n`
    );
    expect(() => stageMigration(stageOptions(sample, planSha256))).toThrow(codeSuffix);
    expect(sample.version()).toBe(1);
  } finally {
    fs.rmSync(sample.root, { recursive: true, force: true });
  }
});

test('staging 只写副本并与 v1 正文独立对照', () => {
  const sample = migrationFixture();
  try {
    const before = fileTreeState(path.join(sample.root, 'evidence'));
    const { planSha256 } = prepareMigration(sample);
    saveMigration(sample.root, 'private/STOP', 'stopped');
    const staged = stageMigration(stageOptions(sample, planSha256));
    expect(fileTreeState(path.join(sample.root, 'evidence'))).toEqual(before);
    expect(sample.version()).toBe(1);
    const stagedResponse =
      `private/http-evidence-v2-staging/${planSha256}/run-${MIGRATION_RUN_ID}/response-1.enc`;
    expect(sample.version(stagedResponse)).toBe(2);
    expect(staged).toMatchObject({ outcome: 'HTTP_EVIDENCE_V2_STAGED', files: 1 });
  } finally {
    fs.rmSync(sample.root, { recursive: true, force: true });
  }
});

test('production 不接受测试注入的停机检查', () => {
  const sample = migrationFixture();
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    const { planSha256 } = prepareMigration(sample);
    saveMigration(sample.root, 'private/STOP', 'stopped');
    process.env.NODE_ENV = 'production';
    expect(() => stageMigration(stageOptions(sample, planSha256))).toThrow(
      'HTTP_EVIDENCE_MIGRATION_QUIESCENCE_REQUIRED'
    );
    expect(fs.existsSync(path.join(sample.root, 'private/http-evidence-v2-staging'))).toBe(false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    fs.rmSync(sample.root, { recursive: true, force: true });
  }
});

test('离机认证签名被篡改时不得替换在线 v1', () => {
  const sample = migrationFixture();
  const offline = fs.mkdtempSync(path.join(os.tmpdir(), 'http-evidence-offline-qa-'));
  try {
    const { planSha256 } = prepareMigration(sample);
    saveMigration(sample.root, 'private/STOP', 'stopped');
    stageMigration(stageOptions(sample, planSha256));
    fs.cpSync(sample.root, offline, { recursive: true });
    attestOffline(offline, planSha256);
    const attestationPath = path.join(
      offline,
      'private/http-evidence-offhost-attestation.json'
    );
    const attestation = JSON.parse(fs.readFileSync(attestationPath, 'utf8'));
    attestation.signature = '0'.repeat(64);
    writePrivate(attestationPath, JSON.stringify(attestation));
    expect(() => finalizeMigration(finalizeOptions(sample, offline, planSha256))).toThrow(
      'HTTP_EVIDENCE_MIGRATION_OFFHOST_UNVERIFIED'
    );
    expect(sample.version()).toBe(1);
  } finally {
    fs.rmSync(sample.root, { recursive: true, force: true });
    fs.rmSync(offline, { recursive: true, force: true });
  }
});

test.each(['missing body', 'wrong key'])('离机恢复 %s 时不得替换在线 v1', faultType => {
  const sample = migrationFixture();
  const offline = fs.mkdtempSync(path.join(os.tmpdir(), 'http-evidence-offline-qa-'));
  try {
    const { planSha256 } = prepareMigration(sample);
    saveMigration(sample.root, 'private/STOP', 'stopped');
    stageMigration(stageOptions(sample, planSha256));
    fs.cpSync(sample.root, offline, { recursive: true });
    attestOffline(offline, planSha256);
    if (faultType === 'missing body') {
      fs.unlinkSync(path.join(offline, sample.directory, sample.bodyFile));
    } else {
      saveMigration(offline, 'private/evidence.key', crypto.randomBytes(32));
    }
    expect(() =>
      finalizeMigration(finalizeOptions(sample, offline, planSha256))
    ).toThrow();
    expect(sample.version()).toBe(1);
  } finally {
    fs.rmSync(sample.root, { recursive: true, force: true });
    fs.rmSync(offline, { recursive: true, force: true });
  }
});

test('finalize 中断保留 APPLY_STARTED 且不把失败当成已清理', () => {
  const sample = migrationFixture();
  const offline = fs.mkdtempSync(path.join(os.tmpdir(), 'http-evidence-offline-qa-'));
  try {
    const { planSha256 } = prepareMigration(sample);
    saveMigration(sample.root, 'private/STOP', 'stopped');
    stageMigration(stageOptions(sample, planSha256));
    fs.cpSync(sample.root, offline, { recursive: true });
    attestOffline(offline, planSha256);
    const rename = fs.renameSync;
    const responsePath = path.join(
      sample.root,
      sample.directory,
      `response-${MIGRATION_INDEX}.enc`
    );
    const injected = jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (destination === responsePath) throw new Error('synthetic finalize interruption');
      return rename(source, destination);
    });
    try {
      expect(() =>
        finalizeMigration(finalizeOptions(sample, offline, planSha256))
      ).toThrow('synthetic finalize interruption');
    } finally {
      injected.mockRestore();
    }
    expect(sample.version()).toBe(1);
    const intentPath = path.join(
      sample.root,
      'private',
      `http-evidence-v2-intent-${planSha256}.json`
    );
    expect(JSON.parse(fs.readFileSync(intentPath, 'utf8'))).toMatchObject({
      state: 'APPLY_STARTED',
      completed: [],
    });
    expect(() =>
      finalizeMigration(finalizeOptions(sample, offline, planSha256))
    ).toThrow('HTTP_EVIDENCE_MIGRATION_UNKNOWN_INTENT');
  } finally {
    fs.rmSync(sample.root, { recursive: true, force: true });
    fs.rmSync(offline, { recursive: true, force: true });
  }
});

test('finalize 成功后仅替换响应元数据，请求、正文、事件和审计不变', () => {
  const sample = migrationFixture();
  const offline = fs.mkdtempSync(path.join(os.tmpdir(), 'http-evidence-offline-qa-'));
  try {
    const protectedFiles = [
      `${sample.directory}/request-${MIGRATION_INDEX}.enc`,
      `${sample.directory}/${sample.bodyFile}`,
      `${sample.directory}/events.jsonl`,
      `private/${MIGRATION_AUDIT}`,
    ];
    const before = Object.fromEntries(
      protectedFiles.map(file => [file, hash(fs.readFileSync(path.join(sample.root, file)))])
    );
    const { planSha256 } = prepareMigration(sample);
    saveMigration(sample.root, 'private/STOP', 'stopped');
    stageMigration(stageOptions(sample, planSha256));
    fs.cpSync(sample.root, offline, { recursive: true });
    attestOffline(offline, planSha256);
    const result = finalizeMigration(finalizeOptions(sample, offline, planSha256));
    expect(result).toMatchObject({
      outcome: 'HTTP_EVIDENCE_V2_FINALIZED',
      replacedResponses: 1,
    });
    expect(sample.version()).toBe(2);
    for (const file of protectedFiles) {
      expect(hash(fs.readFileSync(path.join(sample.root, file)))).toBe(before[file]);
    }
    expect(JSON.parse(fs.readFileSync(path.join(sample.root, result.intentFile), 'utf8')))
      .toMatchObject({ state: 'APPLIED', completed: [{ runId: MIGRATION_RUN_ID }] });
  } finally {
    fs.rmSync(sample.root, { recursive: true, force: true });
    fs.rmSync(offline, { recursive: true, force: true });
  }
});
