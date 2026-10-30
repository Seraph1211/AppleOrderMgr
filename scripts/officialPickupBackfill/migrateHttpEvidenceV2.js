const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const {
  decrypt,
  encrypt,
  fault,
  hash,
  writePrivate,
} = require('../../src/services/officialOrderSupport');
const {
  createHttpResponseEvidenceV2,
  readHttpResponseEvidence,
} = require('../../src/services/officialHttpEvidence');

const LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  planBytes: 32 * 1024 * 1024,
  maximumRuns: 10000,
  maximumReferenceFiles: 100000,
  maximumReferences: 200000,
  maximumReferenceDepth: 12,
  permissionMask: 0o077,
  attestationAgeMs: 24 * 60 * 60 * 1000,
  clockSkewMs: 5 * 60 * 1000,
});
const SHA256 = /^[a-f0-9]{64}$/;
const TERMINAL_INTENTS = new Set(['APPLIED', 'ROLLED_BACK']);
const ACTIVE_OUTCOMES = new Set([
  'RUNNING',
  'PENDING',
  'QUEUED',
  'APPLY_STARTED',
  'COMMIT_UNKNOWN',
]);
const MAINTENANCE_LOCK = 'private/http-evidence-v2-maintenance.lock';
const QUIESCENCE_KIND = 'OFFICIAL_HTTP_EVIDENCE_V2_QUIESCENCE';
const INTENT_NAME = /^(?:(?:http-apply-intent|browser-receipt-bind-intent)-.+|http-evidence-v2-intent-[a-f0-9]{64})\.json$/;
const SAMPLE_AUDIT_NAME = /^http-sample-[1-9]\d*-[a-f0-9]{32}\.json$/;
const REFRESH_AUDIT_NAME = /^refresh-audit-([a-f0-9]{32})\.json$/;
const QUEUE_JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function auditKind(name) {
  if (SAMPLE_AUDIT_NAME.test(name)) return 'sample';
  if (REFRESH_AUDIT_NAME.test(name)) return 'refresh';
  return null;
}

function secureBytes(root, relative, maximum = LIMITS.fileBytes) {
  const file = path.join(root, relative);
  const stat = fs.lstatSync(file);
  const resolved = fs.realpathSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & LIMITS.permissionMask ||
    stat.size > maximum ||
    !resolved.startsWith(`${root}${path.sep}`)
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_FILE_INVALID');
  }
  return fs.readFileSync(file);
}

function parseJson(bytes, code = 'HTTP_EVIDENCE_MIGRATION_INPUT_INVALID') {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault(code);
    return value;
  } catch (error) {
    if (error.code) throw error;
    throw fault(code);
  }
}

function parseReference(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (_error) {
    throw fault('HTTP_EVIDENCE_MIGRATION_REFERENCE_INVALID');
  }
}

function collectRunIds(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectRunIds(item, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  if (Number.isSafeInteger(value.runId) && value.runId > 0) output.add(value.runId);
  for (const item of Object.values(value)) collectRunIds(item, output);
  return output;
}

function guardSnapshot(root, requireStopped, selectedRunIds = new Set()) {
  const privateRoot = path.join(root, 'private');
  const names = fs.readdirSync(privateRoot).sort();
  if (fs.existsSync(path.join(privateRoot, 'http-cleanup-blocked.json'))) {
    throw fault('HTTP_EVIDENCE_MIGRATION_ACTIVE');
  }
  if (requireStopped && !fs.existsSync(path.join(privateRoot, 'STOP'))) {
    throw fault('HTTP_EVIDENCE_MIGRATION_NOT_STOPPED');
  }
  const files = [];
  for (const name of names) {
    if (!INTENT_NAME.test(name)) continue;
    const bytes = secureBytes(root, `private/${name}`);
    const value = parseJson(bytes, 'HTTP_EVIDENCE_MIGRATION_INTENT_INVALID');
    const referenced = collectRunIds(value);
    if (!TERMINAL_INTENTS.has(value.state)) {
      if (!referenced.size || [...referenced].some(runId => selectedRunIds.has(runId))) {
        throw fault('HTTP_EVIDENCE_MIGRATION_UNKNOWN_INTENT');
      }
      continue;
    }
    if (![...referenced].some(runId => selectedRunIds.has(runId))) continue;
    files.push({ file: `private/${name}`, sha256: hash(bytes), state: value.state });
  }
  for (const name of ['http-batch-apply.jsonl', 'http-batch-dry-run.jsonl']) {
    if (!fs.existsSync(path.join(privateRoot, name))) continue;
    const bytes = secureBytes(root, `private/${name}`);
    const unscoped = [];
    forEachReferenceRecord(name, bytes, value => {
      if (!collectRunIds(value).size) unscoped.push(hash(JSON.stringify(value)));
    });
    if (unscoped.length) {
      files.push({
        file: `private/${name}`,
        sha256: hash(unscoped.sort().join('\n')),
        scope: 'UNSCOPED_RECORDS',
      });
    }
  }
  return files;
}

function withMaintenanceLock(root, action) {
  const lock = path.join(root, MAINTENANCE_LOCK);
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (_error) {
    throw fault('HTTP_EVIDENCE_MIGRATION_LOCKED');
  }
  try {
    writePrivate(
      path.join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
    return action();
  } finally {
    try {
      fs.unlinkSync(path.join(lock, 'owner.json'));
      fs.rmdirSync(lock);
    } catch (_error) {
      // 锁残留时队列继续失败关闭；不得在这里递归删除未知内容。
    }
  }
}

function quiescencePayload(value) {
  return JSON.stringify({
    version: value.version,
    kind: value.kind,
    planSha256: value.planSha256,
    rootPathHash: value.rootPathHash,
    sourceHostHash: value.sourceHostHash,
    toolSha256: value.toolSha256,
    nonce: value.nonce,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    service: value.service,
    serviceInactive: value.serviceInactive,
    activeContainers: value.activeContainers,
    activeProcesses: value.activeProcesses,
    stopPresent: value.stopPresent,
  });
}

/**
 * 计算宿主 Python 与 Node 容器共用的 quiescence proof HMAC。
 * @param {Buffer} key 32 字节证据密钥。
 * @param {object} value 不含 signature 的证明字段。
 * @returns {string} 十六进制 HMAC-SHA256。
 */
function signQuiescenceProof(key, value) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw fault('HTTP_EVIDENCE_MIGRATION_KEY_INVALID');
  }
  return crypto.createHmac('sha256', key).update(quiescencePayload(value)).digest('hex');
}

function offhostAttestationPayload(value) {
  return JSON.stringify({
    version: value.version,
    kind: value.kind,
    planSha256: value.planSha256,
    sourceHostHash: value.sourceHostHash,
    storageHostHash: value.storageHostHash,
    contentManifestSha256: value.contentManifestSha256,
    verifiedAt: value.verifiedAt,
  });
}

/**
 * 计算离机设备认证文件 HMAC，证明认证文件与完整备份中的 evidence.key 同源。
 * @param {Buffer} key 32 字节证据密钥。
 * @param {object} value 离机认证字段。
 * @returns {string} 十六进制 HMAC-SHA256。
 */
function signOffhostAttestation(key, value) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw fault('HTTP_EVIDENCE_MIGRATION_KEY_INVALID');
  }
  return crypto
    .createHmac('sha256', key)
    .update(offhostAttestationPayload(value))
    .digest('hex');
}

function verifyExternalQuiescence(root, planSha256, proofFile, nonce) {
  if (
    !/^http-evidence-v2-quiescence-[a-f0-9]{64}\.json$/.test(proofFile || '') ||
    !/^[a-f0-9]{64}$/.test(nonce || '')
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_QUIESCENCE_INVALID');
  }
  const key = secureBytes(root, 'private/evidence.key', 32);
  const proofBytes = secureBytes(root, `private/${proofFile}`);
  const proof = parseJson(proofBytes, 'HTTP_EVIDENCE_MIGRATION_QUIESCENCE_INVALID');
  const owner = parseJson(
    secureBytes(root, `${MAINTENANCE_LOCK}/owner.json`),
    'HTTP_EVIDENCE_MIGRATION_QUIESCENCE_INVALID'
  );
  const issuedAt = Date.parse(proof.issuedAt);
  const expiresAt = Date.parse(proof.expiresAt);
  const expected = signQuiescenceProof(key, proof);
  const actual = typeof proof.signature === 'string' ? proof.signature : '';
  if (
    proof.version !== 1 ||
    proof.kind !== QUIESCENCE_KIND ||
    proof.planSha256 !== planSha256 ||
    proof.nonce !== nonce ||
    owner.nonce !== nonce ||
    owner.planSha256 !== planSha256 ||
    owner.rootPathHash !== proof.rootPathHash ||
    owner.sourceHostHash !== proof.sourceHostHash ||
    owner.toolSha256 !== proof.toolSha256 ||
    proof.toolSha256 !== hash(fs.readFileSync(__filename)) ||
    proof.serviceInactive !== true ||
    proof.activeContainers !== 0 ||
    proof.activeProcesses !== 0 ||
    proof.stopPresent !== true ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > Date.now() + LIMITS.clockSkewMs ||
    expiresAt <= Date.now() ||
    expiresAt - issuedAt > LIMITS.clockSkewMs ||
    !SHA256.test(actual) ||
    !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex')) ||
    !fs.existsSync(path.join(root, 'private/STOP'))
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_QUIESCENCE_INVALID');
  }
  return {
    proofSha256: hash(proofBytes),
    issuedAt: proof.issuedAt,
    expiresAt: proof.expiresAt,
    service: proof.service,
    activeContainers: 0,
    activeProcesses: 0,
    sourceHostHash: proof.sourceHostHash,
  };
}

function withQuiescence(options, root, action) {
  if (options.quiescenceProofFile || options.maintenanceNonce) {
    return action(
      verifyExternalQuiescence(
        root,
        options.expectedPlanSha256,
        options.quiescenceProofFile,
        options.maintenanceNonce
      )
    );
  }
  const testRuntime =
    process.env.NODE_ENV !== 'production' &&
    (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined);
  if (
    !testRuntime ||
    options.testOnlyAllowQuiescenceCheck !== true ||
    typeof options.quiescenceCheck !== 'function'
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_QUIESCENCE_REQUIRED');
  }
  return withMaintenanceLock(root, () => action(options.quiescenceCheck(root)));
}

function validateSelection(value) {
  if (
    value?.version !== 1 ||
    value.kind !== 'OFFICIAL_HTTP_EVIDENCE_V2_SELECTION' ||
    !Array.isArray(value.runs) ||
    !value.runs.length ||
    value.runs.length > LIMITS.maximumRuns ||
    new Set(value.runs.map(item => item?.runId)).size !== value.runs.length ||
    value.runs.some(
      item =>
        !Number.isSafeInteger(item?.runId) ||
        item.runId < 1 ||
        auditKind(item.auditFile || '') === null
    )
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID');
  }
}

function buildRefreshAuditContext(root) {
  const byJob = new Map();
  for (const name of fs.readdirSync(path.join(root, 'private')).sort()) {
    if (!REFRESH_AUDIT_NAME.test(name)) continue;
    let bytes;
    let audit;
    try {
      bytes = secureBytes(root, `private/${name}`);
      audit = parseJson(bytes);
    } catch (_error) {
      continue;
    }
    if (!QUEUE_JOB_ID.test(audit.jobId || '')) continue;
    const values = byJob.get(audit.jobId) || [];
    values.push({ name, sha256: hash(bytes), audit });
    byJob.set(audit.jobId, values);
  }
  return byJob;
}

function validQueueResult(result, audit, runId) {
  const source = result?.source;
  return (
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    result.systemOrderId === audit.orderId &&
    source &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    source.runId === runId &&
    typeof source.file === 'string' &&
    /^body-[1-9]\d*-[a-f0-9]{16}\.enc$/.test(source.file) &&
    SHA256.test(source.sha256 || '') &&
    source.status === 200 &&
    source.cached === false &&
    typeof source.host === 'string' &&
    source.host.length > 0 &&
    SHA256.test(source.urlHash || '') &&
    Number.isFinite(Date.parse(source.observedAt))
  );
}

function readEvents(root, runId) {
  const relative = `evidence/run-${runId}/events.jsonl`;
  const bytes = secureBytes(root, relative);
  if (!bytes.length || bytes.at(-1) !== 10) throw fault('HTTP_EVIDENCE_MIGRATION_RUN_INVALID');
  const events = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map(line => parseJson(Buffer.from(line), 'HTTP_EVIDENCE_MIGRATION_RUN_INVALID'));
  return { bytes, events };
}

function validateAudit(
  root,
  item,
  refreshAuditContext = buildRefreshAuditContext(root),
  responseBodies
) {
  const relative = `private/${item.auditFile}`;
  const bytes = secureBytes(root, relative);
  const audit = parseJson(bytes);
  const kind = auditKind(item.auditFile);
  if (audit.runId !== item.runId || ACTIVE_OUTCOMES.has(audit.outcome)) {
    throw fault('HTTP_EVIDENCE_MIGRATION_ACTIVE');
  }
  if (typeof audit.outcome !== 'string' || !Number.isFinite(audit.finishedAt)) {
    throw fault('HTTP_EVIDENCE_MIGRATION_AUDIT_INVALID');
  }
  if (kind === 'sample') {
    if (audit.cleanup?.removed !== true || audit.businessWrites !== 0) {
      throw fault('HTTP_EVIDENCE_MIGRATION_ACTIVE');
    }
    return {
      kind,
      relative,
      sha256: hash(bytes),
      outcome: audit.outcome,
      finishedAt: audit.finishedAt,
      businessWritePolicy: 'NONE',
    };
  }
  const attemptId = REFRESH_AUDIT_NAME.exec(item.auditFile)?.[1];
  if (
    !attemptId ||
    audit.attemptId !== attemptId ||
    !QUEUE_JOB_ID.test(audit.jobId || '') ||
    !Number.isSafeInteger(audit.orderId) ||
    audit.orderId < 1 ||
    !Number.isFinite(audit.startedAt) ||
    audit.startedAt > audit.finishedAt ||
    audit.outcome !== 'SUCCEEDED' ||
    audit.cleanupVerified !== true ||
    (audit.collectorOutcome !== undefined && audit.collectorOutcome !== 'SUCCEEDED') ||
    audit.failedStage !== undefined ||
    audit.egressAfterError !== undefined
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_AUDIT_INVALID');
  }
  const jobAudits = refreshAuditContext.get(audit.jobId) || [];
  const successfulAudits = jobAudits.filter(value => value.audit.outcome === 'SUCCEEDED');
  if (successfulAudits.length !== 1 || successfulAudits[0].name !== item.auditFile) {
    throw fault('HTTP_EVIDENCE_MIGRATION_DUPLICATE_JOB_SUCCESS');
  }
  if (
    jobAudits.some(
      value =>
        value.name !== item.auditFile &&
        (typeof value.audit.outcome !== 'string' ||
          ACTIVE_OUTCOMES.has(value.audit.outcome) ||
          !Number.isFinite(value.audit.finishedAt) ||
          value.audit.finishedAt > audit.startedAt ||
          value.audit.cleanupVerified !== true)
    )
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_COMMIT_UNVERIFIED');
  }
  const resultRelative = `private/results/order-${audit.orderId}-run-${item.runId}.json`;
  let resultBytes;
  try {
    resultBytes = secureBytes(root, resultRelative);
    const result = parseJson(resultBytes);
    if (
      !validQueueResult(result, audit, item.runId) ||
      (responseBodies &&
        !isDeepStrictEqual(responseBodies.get(result.source.file), {
          sha256: result.source.sha256,
          status: result.source.status,
          host: result.source.host,
          urlHash: result.source.urlHash,
          observedAt: result.source.observedAt,
        }))
    ) {
      throw new Error();
    }
    secureBytes(root, `evidence/run-${item.runId}/${result.source.file}`);
  } catch (_error) {
    throw fault('HTTP_EVIDENCE_MIGRATION_RESULT_UNVERIFIED');
  }
  const commitRelative = `private/finish-${audit.jobId}.json`;
  let commitBytes;
  try {
    commitBytes = secureBytes(root, commitRelative);
    const commit = parseJson(commitBytes);
    if (
      !commit ||
      Object.keys(commit).sort().join(',') !== 'result,state' ||
      commit.state !== 'FINISHED' ||
      !commit.result ||
      Object.keys(commit.result).sort().join(',') !== 'errorCode,state' ||
      commit.result.state !== 'succeeded' ||
      commit.result.errorCode !== null
    ) {
      throw new Error();
    }
  } catch (_error) {
    throw fault('HTTP_EVIDENCE_MIGRATION_COMMIT_UNVERIFIED');
  }
  return {
    kind,
    relative,
    sha256: hash(bytes),
    outcome: audit.outcome,
    finishedAt: audit.finishedAt,
    businessWritePolicy: 'TERMINAL_QUEUE_COMMIT',
    jobAuditSetSha256: hash(
      JSON.stringify(
        jobAudits
          .map(value => ({ name: value.name, sha256: value.sha256 }))
          .sort((left, right) => left.name.localeCompare(right.name))
      )
    ),
    result: { relative: resultRelative, sha256: hash(resultBytes) },
    commit: { relative: commitRelative, sha256: hash(commitBytes) },
  };
}

function containsActiveState(value) {
  if (Array.isArray(value)) return value.some(containsActiveState);
  if (!value || typeof value !== 'object') return false;
  if (ACTIVE_OUTCOMES.has(value.state) || ACTIVE_OUTCOMES.has(value.outcome)) return true;
  return Object.values(value).some(containsActiveState);
}

function containsPinnedState(value) {
  if (Array.isArray(value)) return value.some(containsPinnedState);
  if (!value || typeof value !== 'object') return false;
  if (
    value.pinned === true ||
    value.preserve === true ||
    value.state === 'PINNED' ||
    value.outcome === 'PINNED' ||
    (typeof value.event === 'string' && /(?:^|_)(?:pinned|hold)$/.test(value.event))
  ) {
    return true;
  }
  return Object.values(value).some(containsPinnedState);
}

function referenceFindings(value, selectedRunIds, findings) {
  if (Array.isArray(value)) {
    for (const item of value) referenceFindings(item, selectedRunIds, findings);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (selectedRunIds.has(value.runId)) {
    const finding = findings.get(value.runId) || {
      active: false,
      retryPending: false,
      pinned: false,
      recordSha256s: [],
    };
    finding.active ||= containsActiveState(value);
    finding.pinned ||= containsPinnedState(value);
    finding.retryPending ||=
      typeof value.event === 'string' &&
      /(?:^|_)(?:started|queued|running|authorized)$/.test(value.event);
    finding.recordSha256s.push(hash(JSON.stringify(value)));
    findings.set(value.runId, finding);
  }
  for (const item of Object.values(value)) {
    referenceFindings(item, selectedRunIds, findings);
  }
}

function forEachReferenceRecord(name, bytes, callback) {
  if (!name.endsWith('.jsonl')) {
    callback(parseReference(bytes));
    return;
  }
  if (bytes.length && bytes.at(-1) !== 10) {
    throw fault('HTTP_EVIDENCE_MIGRATION_REFERENCE_INVALID');
  }
  const text = bytes.toString('utf8');
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    if (index > start) callback(parseReference(Buffer.from(text.slice(start, index))));
    start = index + 1;
  }
}

function buildReferenceIndex(root, runIds, collectExclusions = false) {
  const privateRoot = path.join(root, 'private');
  const selectedRunIds = new Set(runIds);
  const references = new Map(runIds.map(runId => [runId, []]));
  const exclusions = new Map();
  let fileCount = 0;
  let referenceCount = 0;

  function visit(directory, depth) {
    if (depth > LIMITS.maximumReferenceDepth) {
      throw fault('HTTP_EVIDENCE_MIGRATION_REFERENCE_LIMIT');
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(file, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.jsonl?$/.test(entry.name)) continue;
      fileCount += 1;
      if (fileCount > LIMITS.maximumReferenceFiles) {
        throw fault('HTTP_EVIDENCE_MIGRATION_REFERENCE_LIMIT');
      }
      const relative = path.relative(root, file).split(path.sep).join('/');
      const maximum = entry.name === 'http-evidence-migration-plan.json'
        ? LIMITS.planBytes
        : LIMITS.fileBytes;
      const bytes = secureBytes(root, relative, maximum);
      const findings = new Map();
      forEachReferenceRecord(entry.name, bytes, value => {
        if (
          typeof value.kind === 'string' &&
          /^OFFICIAL_HTTP_EVIDENCE_V2_(?:INVENTORY|SELECTION|MIGRATION_PLAN)$/.test(value.kind)
        ) {
          return;
        }
        referenceFindings(value, selectedRunIds, findings);
      });
      if (!findings.size) continue;
      for (const [runId, finding] of findings) {
        const reasonCode = finding.active
          ? 'ACTIVE_OR_UNKNOWN_REFERENCE'
          : finding.retryPending
            ? 'RETRY_PENDING'
            : finding.pinned
              ? 'PINNED_REFERENCE'
              : null;
        if (reasonCode) {
          if (!collectExclusions) {
            throw fault(
              reasonCode === 'RETRY_PENDING'
                ? 'HTTP_EVIDENCE_MIGRATION_RETRY_PENDING'
                : 'HTTP_EVIDENCE_MIGRATION_ACTIVE'
            );
          }
          exclusions.set(runId, reasonCode);
        }
        referenceCount += 1;
        if (referenceCount > LIMITS.maximumReferences) {
          throw fault('HTTP_EVIDENCE_MIGRATION_REFERENCE_LIMIT');
        }
        references.get(runId).push({
          file: relative,
          sha256: hash(finding.recordSha256s.sort().join('\n')),
        });
      }
    }
  }

  visit(privateRoot, 0);
  for (const value of references.values()) value.sort((left, right) => left.file.localeCompare(right.file));
  return { references, exclusions };
}

function inspectRun(root, item, key, references, refreshAuditContext) {
  const directory = `evidence/run-${item.runId}`;
  const names = fs.readdirSync(path.join(root, directory)).sort();
  const responseNames = names.filter(name => /^response-[1-9]\d*\.enc$/.test(name));
  if (!responseNames.length) throw fault('HTTP_EVIDENCE_MIGRATION_RUN_INVALID');
  const { bytes: eventBytes, events } = readEvents(root, item.runId);
  const responses = responseNames.map(name => {
    const index = Number(/^response-([1-9]\d*)\.enc$/.exec(name)[1]);
    const requestFile = `request-${index}.enc`;
    const responseFile = name;
    const evidence = readHttpResponseEvidence({
      responseBytes: secureBytes(root, `${directory}/${responseFile}`),
      requestBytes: secureBytes(root, `${directory}/${requestFile}`),
      key,
      runId: item.runId,
      index,
      readBody: file => decrypt(secureBytes(root, `${directory}/${file}`), key),
    });
    if (evidence.version !== 1) throw fault('HTTP_EVIDENCE_MIGRATION_NOT_V1');
    const logged = events.filter(
      event => event.message === 'http_response' && event.file === evidence.bodyFile
    );
    let requestUrl;
    try {
      requestUrl = new URL(evidence.request.url);
    } catch (_error) {
      throw fault('HTTP_EVIDENCE_MIGRATION_RUN_INVALID');
    }
    if (
      logged.length !== 1 ||
      logged[0].runId !== item.runId ||
      logged[0].bytes !== evidence.body.length ||
      logged[0].sha256 !== hash(evidence.body) ||
      !Number.isFinite(Date.parse(logged[0].observedAt))
    ) {
      throw fault('HTTP_EVIDENCE_MIGRATION_RUN_INVALID');
    }
    return {
      index,
      requestFile,
      requestSha256: hash(secureBytes(root, `${directory}/${requestFile}`)),
      responseFile,
      responseSha256: hash(secureBytes(root, `${directory}/${responseFile}`)),
      bodyFile: evidence.bodyFile,
      bodyCipherSha256: hash(secureBytes(root, `${directory}/${evidence.bodyFile}`)),
      bodySha256: hash(evidence.body),
      bodyLength: evidence.body.length,
      observedAt: logged[0].observedAt,
      status: evidence.response.status,
      host: requestUrl.hostname,
      urlHash: hash(requestUrl.href),
      responseUrlMatchesRequest: evidence.response.url === requestUrl.href,
    };
  });
  return {
    runId: item.runId,
    audit: validateAudit(
      root,
      item,
      refreshAuditContext,
      new Map(
        responses
          .filter(
            response =>
              response.status === 200 &&
              response.responseUrlMatchesRequest
          )
          .map(response => [
            response.bodyFile,
            {
              sha256: response.bodySha256,
              status: response.status,
              host: response.host,
              urlHash: response.urlHash,
              observedAt: response.observedAt,
            },
          ])
      )
    ),
    eventsSha256: hash(eventBytes),
    references,
    responses,
  };
}

/**
 * 对显式选择的封存 run 生成只读迁移计划；不会扫描数据库或写入证据。
 * @param {object} options 根目录、private 下的选择清单文件名和当前时间。
 * @returns {object} 绑定 v1 原件、终态审计、引用保护与密钥的迁移计划。
 */
function buildMigrationPlan({ root, selectionFile, now = Date.now() }) {
  if (
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(selectionFile || '') ||
    !Number.isFinite(now)
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID');
  }
  root = fs.realpathSync(root);
  const selectionBytes = secureBytes(root, `private/${selectionFile}`);
  const selection = parseJson(selectionBytes);
  validateSelection(selection);
  const keyBytes = secureBytes(root, 'private/evidence.key', 32);
  if (keyBytes.length !== 32) throw fault('HTTP_EVIDENCE_MIGRATION_KEY_INVALID');
  const { references: referenceIndex } = buildReferenceIndex(
    root,
    selection.runs.map(item => item.runId)
  );
  const refreshAuditContext = buildRefreshAuditContext(root);
  const plan = {
    version: 1,
    kind: 'OFFICIAL_HTTP_EVIDENCE_V2_MIGRATION_PLAN',
    createdAt: new Date(now).toISOString(),
    selectionFile,
    selectionSha256: hash(selectionBytes),
    keySha256: hash(keyBytes),
    guards: guardSnapshot(root, false, new Set(selection.runs.map(item => item.runId))),
    runs: selection.runs.map(item =>
      inspectRun(root, item, keyBytes, referenceIndex.get(item.runId), refreshAuditContext)
    ),
  };
  return { plan, planSha256: hash(JSON.stringify(plan)) };
}

function inventoryReason(error) {
  const code = error?.code || error?.message;
  if (code === 'HTTP_EVIDENCE_MIGRATION_AUDIT_INVALID') return 'AUDIT_INVALID';
  if (code === 'HTTP_EVIDENCE_MIGRATION_COMMIT_UNVERIFIED') return 'QUEUE_COMMIT_UNVERIFIED';
  if (code === 'HTTP_EVIDENCE_MIGRATION_RESULT_UNVERIFIED') return 'COLLECTOR_RESULT_UNVERIFIED';
  if (code === 'HTTP_EVIDENCE_MIGRATION_DUPLICATE_JOB_SUCCESS') {
    return 'DUPLICATE_JOB_SUCCESS';
  }
  if (code === 'HTTP_EVIDENCE_MIGRATION_NOT_V1') return 'NOT_V1';
  if (code === 'HTTP_EVIDENCE_MIGRATION_RETRY_PENDING') return 'RETRY_PENDING';
  if (code === 'HTTP_EVIDENCE_MIGRATION_ACTIVE') return 'ACTIVE_OR_UNKNOWN_REFERENCE';
  if (
    [
      'HTTP_EVIDENCE_MIGRATION_RUN_INVALID',
      'HTTP_EVIDENCE_MIGRATION_FILE_INVALID',
      'HTTP_EVIDENCE_FORMAT_UNKNOWN',
      'HTTP_EVIDENCE_BINDING_INVALID',
      'HTTP_EVIDENCE_BODY_INVALID',
      'ENCRYPTED_STATE_INVALID',
      'ENOENT',
      'ENOTDIR',
      'EACCES',
    ].includes(code)
  ) {
    return 'EVIDENCE_MISSING_OR_INVALID';
  }
  return null;
}

/**
 * 扫描 sampler 与正常队列终态 audit，输出受限候选清单和固定跳过原因；不写生产根目录。
 * @param {object} options 官网证据根目录。
 * @returns {object} selection、skipped 和不含敏感正文的计数。
 */
function buildMigrationInventory({ root }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw fault('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID');
  }
  root = fs.realpathSync(root);
  const privateRoot = path.join(root, 'private');
  const audits = [];
  const skipped = [];
  let matchedAudits = 0;
  for (const name of fs.readdirSync(privateRoot).sort()) {
    const kind = auditKind(name);
    if (kind === null) continue;
    matchedAudits += 1;
    let audit;
    try {
      audit = parseJson(secureBytes(root, `private/${name}`));
    } catch (_error) {
      skipped.push({ auditFile: name, reasonCode: 'AUDIT_INVALID' });
      continue;
    }
    if (!Number.isSafeInteger(audit.runId) || audit.runId < 1) {
      skipped.push({ auditFile: name, reasonCode: 'AUDIT_INVALID' });
      continue;
    }
    audits.push({ runId: audit.runId, auditFile: name, audit, kind });
  }
  const refreshAuditContext = buildRefreshAuditContext(root);
  const grouped = new Map();
  for (const item of audits) {
    const values = grouped.get(item.runId) || [];
    values.push(item);
    grouped.set(item.runId, values);
  }
  const candidates = [];
  for (const values of grouped.values()) {
    if (values.length !== 1) {
      for (const item of values) {
        skipped.push({ runId: item.runId, auditFile: item.auditFile, reasonCode: 'DUPLICATE_RUN_ID' });
      }
      continue;
    }
    const item = values[0];
    if (ACTIVE_OUTCOMES.has(item.audit.outcome) || !Number.isFinite(item.audit.finishedAt)) {
      skipped.push({ runId: item.runId, auditFile: item.auditFile, reasonCode: 'AUDIT_ACTIVE_OR_UNKNOWN' });
      continue;
    }
    if (item.audit.outcome !== 'SUCCEEDED') {
      skipped.push({ runId: item.runId, auditFile: item.auditFile, reasonCode: 'AUDIT_FAILED_OR_REVIEW' });
      continue;
    }
    if (item.kind === 'sample') {
      if (item.audit.cleanup?.removed !== true) {
        skipped.push({
          runId: item.runId,
          auditFile: item.auditFile,
          reasonCode: 'CLEANUP_UNVERIFIED',
        });
        continue;
      }
      if (item.audit.businessWrites !== 0) {
        skipped.push({
          runId: item.runId,
          auditFile: item.auditFile,
          reasonCode: Number.isFinite(item.audit.businessWrites)
            ? 'BUSINESS_WRITE_PRESENT'
            : 'BUSINESS_WRITE_UNVERIFIED',
        });
        continue;
      }
    } else {
      try {
        validateAudit(root, item, refreshAuditContext);
      } catch (error) {
        const reasonCode = inventoryReason(error);
        if (!reasonCode) throw error;
        skipped.push({ runId: item.runId, auditFile: item.auditFile, reasonCode });
        continue;
      }
    }
    candidates.push(item);
  }
  if (candidates.length > LIMITS.maximumRuns) {
    throw fault('HTTP_EVIDENCE_MIGRATION_REFERENCE_LIMIT');
  }
  const key = secureBytes(root, 'private/evidence.key', 32);
  if (key.length !== 32) throw fault('HTTP_EVIDENCE_MIGRATION_KEY_INVALID');
  let hasGlobalUnknownIntent = false;
  for (const name of fs.readdirSync(privateRoot)) {
    if (!INTENT_NAME.test(name)) continue;
    const value = parseJson(
      secureBytes(root, `private/${name}`),
      'HTTP_EVIDENCE_MIGRATION_INTENT_INVALID'
    );
    if (!TERMINAL_INTENTS.has(value.state) && !collectRunIds(value).size) {
      hasGlobalUnknownIntent = true;
      break;
    }
  }
  if (hasGlobalUnknownIntent) {
    for (const item of candidates) {
      skipped.push({
        runId: item.runId,
        auditFile: item.auditFile,
        reasonCode: 'GLOBAL_UNKNOWN_INTENT',
      });
    }
    candidates.length = 0;
  }
  const { references, exclusions } = buildReferenceIndex(
    root,
    candidates.map(item => item.runId),
    true
  );
  const eligible = [];
  for (const item of candidates) {
    const excluded = exclusions.get(item.runId);
    if (excluded) {
      skipped.push({ runId: item.runId, auditFile: item.auditFile, reasonCode: excluded });
      continue;
    }
    try {
      inspectRun(root, item, key, references.get(item.runId), refreshAuditContext);
      eligible.push({ runId: item.runId, auditFile: item.auditFile });
    } catch (error) {
      const reasonCode = inventoryReason(error);
      if (!reasonCode) throw error;
      skipped.push({ runId: item.runId, auditFile: item.auditFile, reasonCode });
    }
  }
  eligible.sort((left, right) => left.runId - right.runId);
  skipped.sort((left, right) => (left.runId || 0) - (right.runId || 0));
  const reasonCounts = {};
  for (const item of skipped) reasonCounts[item.reasonCode] = (reasonCounts[item.reasonCode] || 0) + 1;
  return {
    version: 1,
    kind: 'OFFICIAL_HTTP_EVIDENCE_V2_INVENTORY',
    selection: { version: 1, kind: 'OFFICIAL_HTTP_EVIDENCE_V2_SELECTION', runs: eligible },
    skipped,
    summary: {
      audits: matchedAudits,
      validAudits: audits.length,
      eligible: eligible.length,
      skipped: skipped.length,
      reasonCounts,
    },
  };
}

function verifyPlanFile(root, planFile, expectedPlanSha256) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(planFile || '') ||
    !SHA256.test(expectedPlanSha256 || '')
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID');
  }
  const bytes = secureBytes(root, `private/${planFile}`, LIMITS.planBytes);
  if (hash(bytes) !== expectedPlanSha256) throw fault('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH');
  const plan = parseJson(bytes);
  if (plan.version !== 1 || plan.kind !== 'OFFICIAL_HTTP_EVIDENCE_V2_MIGRATION_PLAN') {
    throw fault('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH');
  }
  return { plan, bytes };
}

function verifyPlanSources(root, plan, key, allowV2 = false) {
  if (hash(key) !== plan.keySha256) throw fault('HTTP_EVIDENCE_MIGRATION_KEY_INVALID');
  const { references: currentReferences } = buildReferenceIndex(
    root,
    plan.runs.map(run => run.runId)
  );
  const refreshAuditContext = buildRefreshAuditContext(root);
  for (const run of plan.runs) {
    const directory = `evidence/run-${run.runId}`;
    if (hash(secureBytes(root, `${directory}/events.jsonl`)) !== run.eventsSha256) {
      throw fault('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH');
    }
    let currentAudit;
    try {
      currentAudit = validateAudit(
        root,
        { runId: run.runId, auditFile: path.basename(run.audit.relative) },
        refreshAuditContext,
        new Map(
          run.responses
            .filter(
              response =>
                response.status === 200 &&
                response.responseUrlMatchesRequest
            )
            .map(response => [
              response.bodyFile,
              {
                sha256: response.bodySha256,
                status: response.status,
                host: response.host,
                urlHash: response.urlHash,
                observedAt: response.observedAt,
              },
            ])
        )
      );
    } catch (_error) {
      throw fault('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH');
    }
    if (!isDeepStrictEqual(currentAudit, run.audit)) {
      throw fault('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH');
    }
    if (!isDeepStrictEqual(currentReferences.get(run.runId), run.references || [])) {
      throw fault('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH');
    }
    for (const entry of run.responses) {
      const requestBytes = secureBytes(root, `${directory}/${entry.requestFile}`);
      const responseBytes = secureBytes(root, `${directory}/${entry.responseFile}`);
      const bodyBytes = secureBytes(root, `${directory}/${entry.bodyFile}`);
      if (
        hash(requestBytes) !== entry.requestSha256 ||
        hash(bodyBytes) !== entry.bodyCipherSha256 ||
        (!allowV2 && hash(responseBytes) !== entry.responseSha256)
      ) {
        throw fault('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH');
      }
    }
  }
}

/**
 * 按显式计划摘要写入 v2 staging 副本并双读对照；不替换或删除 v1 原件。
 * @param {object} options 根目录、计划文件及调用方重新输入的计划 SHA-256。
 * @returns {object} 加密认证清单和 staging 摘要。
 */
function stageMigrationUnlocked({ root, planFile, expectedPlanSha256, quiescence }) {
  const { plan } = verifyPlanFile(root, planFile, expectedPlanSha256);
  if (
    !isDeepStrictEqual(
      guardSnapshot(root, true, new Set(plan.runs.map(run => run.runId))),
      plan.guards
    )
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_GUARD_CHANGED');
  }
  const key = secureBytes(root, 'private/evidence.key', 32);
  verifyPlanSources(root, plan, key);
  const stageRoot = `private/http-evidence-v2-staging/${expectedPlanSha256}`;
  const output = [];
  for (const run of plan.runs) {
    const directory = `evidence/run-${run.runId}`;
    for (const entry of run.responses) {
      const requestCipher = secureBytes(root, `${directory}/${entry.requestFile}`);
      const responseCipher = secureBytes(root, `${directory}/${entry.responseFile}`);
      const original = readHttpResponseEvidence({
        responseBytes: responseCipher,
        requestBytes: requestCipher,
        key,
        runId: run.runId,
        index: entry.index,
        expectedBodyFile: entry.bodyFile,
        readBody: file => decrypt(secureBytes(root, `${directory}/${file}`), key),
      });
      const v2 = createHttpResponseEvidenceV2({
        response: original.response,
        requestBytes: original.requestPlaintext,
        runId: run.runId,
        index: entry.index,
        observedAt: entry.observedAt,
        bodyFile: entry.bodyFile,
        body: original.body,
      });
      const staged = `${stageRoot}/run-${run.runId}/${entry.responseFile}`;
      writePrivate(path.join(root, staged), encrypt(v2, key));
      const checked = readHttpResponseEvidence({
        responseBytes: secureBytes(root, staged),
        requestBytes: requestCipher,
        key,
        runId: run.runId,
        index: entry.index,
        expectedBodyFile: entry.bodyFile,
        readBody: file => decrypt(secureBytes(root, `${directory}/${file}`), key),
      });
      if (!checked.body.equals(original.body) || checked.version !== 2) {
        throw fault('HTTP_EVIDENCE_MIGRATION_COMPARE_FAILED');
      }
      output.push({
        runId: run.runId,
        index: entry.index,
        file: staged,
        sha256: hash(secureBytes(root, staged)),
      });
    }
  }
  const manifest = {
    version: 1,
    kind: 'OFFICIAL_HTTP_EVIDENCE_V2_STAGED',
    planSha256: expectedPlanSha256,
    quiescence,
    files: output,
  };
  const manifestFile = `${stageRoot}/manifest.enc`;
  writePrivate(path.join(root, manifestFile), encrypt(manifest, key));
  return {
    outcome: 'HTTP_EVIDENCE_V2_STAGED',
    planSha256: expectedPlanSha256,
    files: output.length,
    manifestFile,
    manifestSha256: hash(secureBytes(root, manifestFile)),
  };
}

function stageMigration(options) {
  const root = fs.realpathSync(options.root);
  return withQuiescence(options, root, quiescence =>
    stageMigrationUnlocked({ ...options, root, quiescence })
  );
}

function localMachineHash() {
  try {
    return hash(fs.readFileSync('/etc/machine-id'));
  } catch (_error) {
    throw fault('HTTP_EVIDENCE_MIGRATION_OFFHOST_UNVERIFIED');
  }
}

function verifiedV1ContentManifest(root, plan, expectedPlanSha256, key) {
  verifyPlanSources(root, plan, key);
  const content = {
    version: 1,
    planSha256: expectedPlanSha256,
    keySha256: hash(key),
    runs: [],
  };
  for (const run of plan.runs) {
    const directory = `evidence/run-${run.runId}`;
    const responses = [];
    for (const entry of run.responses) {
      const restored = readHttpResponseEvidence({
        responseBytes: secureBytes(root, `${directory}/${entry.responseFile}`),
        requestBytes: secureBytes(root, `${directory}/${entry.requestFile}`),
        key,
        runId: run.runId,
        index: entry.index,
        expectedBodyFile: entry.bodyFile,
        readBody: file => decrypt(secureBytes(root, `${directory}/${file}`), key),
      });
      if (restored.version !== 1) throw fault('HTTP_EVIDENCE_MIGRATION_OFFLINE_INVALID');
      responses.push({
        index: entry.index,
        requestSha256: entry.requestSha256,
        responseSha256: entry.responseSha256,
        bodyCipherSha256: entry.bodyCipherSha256,
        bodySha256: hash(restored.body),
        bodyLength: restored.body.length,
      });
    }
    content.runs.push({
      runId: run.runId,
      auditSha256: run.audit.sha256,
      eventsSha256: run.eventsSha256,
      references: (run.references || []).map(item => ({ ...item })),
      responses,
    });
  }
  return hash(JSON.stringify(content));
}

/**
 * 在离机设备或服务器只读镜像上完整解密 v1，并生成不含正文的内容清单摘要。
 * @param {object} options 根目录、计划文件和显式计划摘要。
 * @returns {object} 独立恢复结果与内容清单摘要。
 */
function verifyBackupForAttestation({ root, planFile, expectedPlanSha256 }) {
  root = fs.realpathSync(root);
  const { plan } = verifyPlanFile(root, planFile, expectedPlanSha256);
  const key = secureBytes(root, 'private/evidence.key', 32);
  return {
    outcome: 'HTTP_EVIDENCE_V1_BACKUP_VERIFIED',
    planSha256: expectedPlanSha256,
    runs: plan.runs.length,
    responses: plan.runs.reduce((sum, run) => sum + run.responses.length, 0),
    contentManifestSha256: verifiedV1ContentManifest(
      root,
      plan,
      expectedPlanSha256,
      key
    ),
  };
}

function verifyOfflineOriginals(root, offlineRoot, plan, expectedPlanSha256, sourceHostHash) {
  offlineRoot = fs.realpathSync(offlineRoot);
  if (offlineRoot === root) throw fault('HTTP_EVIDENCE_MIGRATION_OFFHOST_UNVERIFIED');
  const attestation = parseJson(
    secureBytes(offlineRoot, 'private/http-evidence-offhost-attestation.json')
  );
  const expectedSourceHostHash = sourceHostHash || localMachineHash();
  const verifiedAt = Date.parse(attestation.verifiedAt);
  const key = secureBytes(offlineRoot, 'private/evidence.key', 32);
  const expectedSignature = signOffhostAttestation(key, attestation);
  const actualSignature = typeof attestation.signature === 'string' ? attestation.signature : '';
  if (
    attestation.version !== 1 ||
    attestation.kind !== 'OFFICIAL_HTTP_EVIDENCE_OFFHOST_ATTESTATION' ||
    attestation.planSha256 !== expectedPlanSha256 ||
    attestation.sourceHostHash !== expectedSourceHostHash ||
    !SHA256.test(attestation.storageHostHash || '') ||
    attestation.storageHostHash === expectedSourceHostHash ||
    !SHA256.test(attestation.contentManifestSha256 || '') ||
    !Number.isFinite(verifiedAt) ||
    verifiedAt > Date.now() + LIMITS.clockSkewMs ||
    Date.now() - verifiedAt > LIMITS.attestationAgeMs ||
    !SHA256.test(actualSignature) ||
    !crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(actualSignature, 'hex')
    )
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_OFFHOST_UNVERIFIED');
  }
  const actualManifest = verifiedV1ContentManifest(
    offlineRoot,
    plan,
    expectedPlanSha256,
    key
  );
  if (actualManifest !== attestation.contentManifestSha256) {
    throw fault('HTTP_EVIDENCE_MIGRATION_OFFHOST_UNVERIFIED');
  }
}

/**
 * 验证离机 v1 原件可独立恢复后，以 staging v2 原子替换在线 response-N.enc。
 * @param {object} options 根目录、离机根目录、计划文件和显式计划摘要。
 * @returns {object} 最终意图和替换数量；正文、请求及事件不会删除。
 */
function finalizeMigrationUnlocked({
  root,
  offlineRoot,
  planFile,
  expectedPlanSha256,
  quiescence,
}) {
  if (typeof offlineRoot !== 'string' || !path.isAbsolute(offlineRoot)) {
    throw fault('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID');
  }
  const { plan } = verifyPlanFile(root, planFile, expectedPlanSha256);
  if (
    !isDeepStrictEqual(
      guardSnapshot(root, true, new Set(plan.runs.map(run => run.runId))),
      plan.guards
    )
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_GUARD_CHANGED');
  }
  const key = secureBytes(root, 'private/evidence.key', 32);
  verifyPlanSources(root, plan, key);
  verifyOfflineOriginals(
    root,
    offlineRoot,
    plan,
    expectedPlanSha256,
    quiescence.sourceHostHash
  );
  const stageRoot = `private/http-evidence-v2-staging/${expectedPlanSha256}`;
  const manifestFile = `${stageRoot}/manifest.enc`;
  const manifest = parseJson(decrypt(secureBytes(root, manifestFile), key));
  if (
    manifest.version !== 1 ||
    manifest.kind !== 'OFFICIAL_HTTP_EVIDENCE_V2_STAGED' ||
    manifest.planSha256 !== expectedPlanSha256
  ) {
    throw fault('HTTP_EVIDENCE_MIGRATION_MANIFEST_INVALID');
  }
  const expectedCount = plan.runs.reduce((sum, run) => sum + run.responses.length, 0);
  if (!Array.isArray(manifest.files) || manifest.files.length !== expectedCount) {
    throw fault('HTTP_EVIDENCE_MIGRATION_MANIFEST_INVALID');
  }
  const intentFile = `private/http-evidence-v2-intent-${expectedPlanSha256}.json`;
  if (fs.existsSync(path.join(root, intentFile))) {
    throw fault('HTTP_EVIDENCE_MIGRATION_UNKNOWN_INTENT');
  }
  const intent = {
    version: 1,
    state: 'APPLY_STARTED',
    planSha256: expectedPlanSha256,
    runIds: plan.runs.map(run => run.runId),
    verificationMirrorHash: hash(fs.realpathSync(offlineRoot)),
    quiescence,
    completed: [],
  };
  writePrivate(path.join(root, intentFile), JSON.stringify(intent));
  for (const run of plan.runs) {
    const directory = `evidence/run-${run.runId}`;
    for (const entry of run.responses) {
      const staged = `${stageRoot}/run-${run.runId}/${entry.responseFile}`;
      const listed = manifest.files.find(
        item => item.runId === run.runId && item.index === entry.index && item.file === staged
      );
      const stagedBytes = secureBytes(root, staged);
      if (!listed || listed.sha256 !== hash(stagedBytes)) {
        throw fault('HTTP_EVIDENCE_MIGRATION_MANIFEST_INVALID');
      }
      writePrivate(path.join(root, `${directory}/${entry.responseFile}`), stagedBytes);
      const checked = readHttpResponseEvidence({
        responseBytes: secureBytes(root, `${directory}/${entry.responseFile}`),
        requestBytes: secureBytes(root, `${directory}/${entry.requestFile}`),
        key,
        runId: run.runId,
        index: entry.index,
        expectedBodyFile: entry.bodyFile,
        readBody: file => decrypt(secureBytes(root, `${directory}/${file}`), key),
      });
      if (checked.version !== 2) throw fault('HTTP_EVIDENCE_MIGRATION_COMPARE_FAILED');
      intent.completed.push({ runId: run.runId, index: entry.index, sha256: hash(stagedBytes) });
      writePrivate(path.join(root, intentFile), JSON.stringify(intent));
    }
  }
  intent.state = 'APPLIED';
  writePrivate(path.join(root, intentFile), JSON.stringify(intent));
  return {
    outcome: 'HTTP_EVIDENCE_V2_FINALIZED',
    planSha256: expectedPlanSha256,
    replacedResponses: intent.completed.length,
    intentFile,
  };
}

function finalizeMigration(options) {
  const root = fs.realpathSync(options.root);
  return withQuiescence(options, root, quiescence =>
    finalizeMigrationUnlocked({ ...options, root, quiescence })
  );
}

function cli() {
  const args = process.argv.slice(2);
  const value = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const root = value('--root');
  if (args.includes('--inventory')) return buildMigrationInventory({ root });
  if (args.includes('--finalize')) {
    if (!args.includes('--apply')) throw fault('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID');
    return finalizeMigration({
      root,
      offlineRoot: value('--offline-root'),
      planFile: value('--plan'),
      expectedPlanSha256: value('--expected-plan-sha256'),
      quiescenceProofFile: value('--quiescence-proof'),
      maintenanceNonce: value('--maintenance-nonce'),
    });
  }
  if (args.includes('--verify-offhost-backup')) {
    return verifyBackupForAttestation({
      root,
      planFile: value('--plan'),
      expectedPlanSha256: value('--expected-plan-sha256'),
    });
  }
  if (args.includes('--apply')) {
    return stageMigration({
      root,
      planFile: value('--plan'),
      expectedPlanSha256: value('--expected-plan-sha256'),
      quiescenceProofFile: value('--quiescence-proof'),
      maintenanceNonce: value('--maintenance-nonce'),
    });
  }
  return buildMigrationPlan({ root, selectionFile: value('--selection') });
}

function publicCliResult(result) {
  if (process.env.OFFICIAL_EVIDENCE_COORDINATOR_CAPTURE === '1') return result;
  if (result?.kind === 'OFFICIAL_HTTP_EVIDENCE_V2_INVENTORY') {
    return {
      outcome: 'HTTP_EVIDENCE_V2_INVENTORY_VALIDATED',
      ...result.summary,
      coordinatorRequired: true,
    };
  }
  if (result?.plan?.kind === 'OFFICIAL_HTTP_EVIDENCE_V2_MIGRATION_PLAN') {
    return {
      outcome: 'HTTP_EVIDENCE_V2_PLAN_VALIDATED',
      planSha256: result.planSha256,
      runs: result.plan.runs.length,
      coordinatorRequired: true,
    };
  }
  return result;
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(publicCliResult(cli()))}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ outcome: error.code || 'HTTP_EVIDENCE_MIGRATION_FAILED' })}\n`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  buildMigrationPlan,
  buildMigrationInventory,
  stageMigration,
  finalizeMigration,
  signQuiescenceProof,
  signOffhostAttestation,
  verifyBackupForAttestation,
};
