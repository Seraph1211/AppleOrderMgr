const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const {
  decrypt,
  hash,
  fault,
  safePath,
  proxyLeaseWindowMs,
} = require('../../src/services/officialOrderSupport');
const {
  parseOfficialOrderDetail,
  isOfficialOrderResponse,
} = require('../../src/services/officialOrderParser');
const {
  extractOfficialReceiptUrl,
  parseOfficialReceipt,
} = require('../../src/services/officialOrderReceipt');

const LIMITS = Object.freeze({
  fileBytes: 16777216,
  planAgeMs: 86400000,
  observationAgeMs: 300000,
  sampleDurationMs: 360000,
  second: 1000,
  schema: 3,
  orders: 10000,
  mask: 0o077,
  keyBytes: 32,
  hashPrefix: 16,
  minimumArgc: 5,
  basisArgc: 7,
  argvOffset: 2,
  httpOk: 200,
});
const SHA256 = /^[a-f0-9]{64}$/;
const MD5 = /^[a-f0-9]{32}$/;
const BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/;
const BODY_FILE = /^body-[1-9]\d*-([a-f0-9]{16})\.enc$/;
const POLICY = { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 };
const EVENT_FIELDS = [
  'sampleId',
  'status',
  'host',
  'path',
  'action',
  'urlHash',
  'cached',
  'contentType',
  'type',
  'phase',
];

function readFile(root, relative) {
  const filename = path.join(root, relative);
  const stat = fs.lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & LIMITS.mask ||
    stat.size > LIMITS.fileBytes ||
    !fs.realpathSync(filename).startsWith(`${root}${path.sep}`)
  )
    throw fault('BROWSER_RECEIPT_FILE_INVALID');
  return fs.readFileSync(filename);
}

function readJson(root, relative) {
  const bytes = readFile(root, relative);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) };
}

function readNamed(root, filename) {
  if (!BASENAME.test(filename || '')) throw fault('BROWSER_RECEIPT_FILE_INVALID');
  return readJson(root, `private/${filename}`);
}

function validId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function readPlan(root, orderId, now) {
  const { value: plan, sha256 } = readJson(root, 'private/plan.json');
  const started = Date.parse(plan?.startedAt);
  if (
    plan?.schemaVersion !== LIMITS.schema ||
    plan.scope !== 'missing-fields' ||
    plan.cutoff !== null ||
    !isDeepStrictEqual(plan.policy, POLICY) ||
    !Number.isFinite(started) ||
    started > now ||
    now - started > LIMITS.planAgeMs ||
    !Array.isArray(plan.entries) ||
    !plan.entries.length ||
    plan.entries.length > LIMITS.orders ||
    new Set(plan.entries.map(entry => entry?.id)).size !== plan.entries.length
  )
    throw fault('BROWSER_RECEIPT_SCOPE_INVALID');
  const entry = plan.entries.find(item => item?.id === orderId);
  if (
    !entry ||
    !/^W\d{10}$/.test(entry.orderNumber || '') ||
    !MD5.test(entry.rowHash || '') ||
    typeof entry.dateMissing !== 'boolean' ||
    typeof entry.serialsMissing !== 'boolean' ||
    !(entry.dateMissing || entry.serialsMissing) ||
    !Array.isArray(entry.previousDevices) ||
    entry.serialsMissing !== (entry.previousDevices.length === 0) ||
    entry.dateMissing !== (entry.previousDate === null)
  )
    throw fault('BROWSER_RECEIPT_SCOPE_INVALID');
  return { plan, entry, started, sha256 };
}

function readSample(root, auditFile, prefix, entry, planStarted, now) {
  const match = new RegExp(`^${prefix}-sample-${entry.id}-([a-f0-9]{32})\\.json$`).exec(
    auditFile || ''
  );
  if (!match) throw fault('BROWSER_RECEIPT_AUDIT_INVALID');
  const { value: audit, sha256 } = readNamed(root, auditFile);
  const started = audit.startedAt * LIMITS.second;
  const finished = audit.finishedAt * LIMITS.second;
  if (
    audit.attemptId !== match[1] ||
    audit.outcome !== 'SUCCEEDED' ||
    audit.orderId !== entry.id ||
    audit.targetOrderId !== entry.id ||
    !validId(audit.runId) ||
    audit.businessWrites !== 0 ||
    audit.cleanup?.removed !== true ||
    audit.egressVerifiedAfter !== true ||
    !SHA256.test(audit.egressHash || '') ||
    audit.egressAfterHash !== audit.egressHash ||
    typeof audit.startedAt !== 'number' ||
    typeof audit.finishedAt !== 'number' ||
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    started < planStarted ||
    finished < started ||
    finished > now ||
    finished - started > LIMITS.sampleDurationMs ||
    audit.resultFile !== `/research/private/results/order-${entry.id}-run-${audit.runId}.json`
  )
    throw fault('BROWSER_RECEIPT_AUDIT_INVALID');
  return { audit, sha256, started, finished };
}

function freshTime(value, window, now) {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < window.started ||
    timestamp > window.finished ||
    timestamp > now ||
    now - timestamp > LIMITS.observationAgeMs
  )
    throw fault('BROWSER_RECEIPT_TIME_INVALID');
  return timestamp;
}

function readBody(root, directory, file, sha256, key) {
  const match = BODY_FILE.exec(file || '');
  if (!match || !SHA256.test(sha256 || '') || match[1] !== sha256.slice(0, LIMITS.hashPrefix))
    throw fault('BROWSER_RECEIPT_SOURCE_INVALID');
  const body = decrypt(readFile(root, `${directory}/${file}`), key);
  if (hash(body) !== sha256) throw fault('BROWSER_RECEIPT_HASH_INVALID');
  return body;
}

function verifyBodyEvent(events, source, body, window, now) {
  const matching = events.filter(event => event.message === 'body' && event.file === source.file);
  if (
    matching.length !== 1 ||
    matching[0].sha256 !== source.sha256 ||
    matching[0].bytes !== body.length ||
    EVENT_FIELDS.some(field => matching[0][field] !== source[field])
  )
    throw fault('BROWSER_RECEIPT_EVENT_INVALID');
  freshTime(matching[0].timestamp, window, now);
  return matching[0];
}

function verifyBasis(root, planState, browserWindow, basisFile, httpSourceAudit) {
  const { entry } = planState;
  if (basisFile === undefined && httpSourceAudit === undefined) return { entry };
  const { value: basis, sha256: basisSha256 } = readNamed(root, basisFile);
  const expectedKeys = [
    'version',
    'planSha256',
    'orderId',
    'originalRowHash',
    'stableRowHash',
    'runId',
    'auditSha256',
  ];
  if (
    !basis ||
    !isDeepStrictEqual(Object.keys(basis).sort(), expectedKeys.sort()) ||
    basis.version !== 1 ||
    basis.planSha256 !== planState.sha256 ||
    basis.orderId !== entry.id ||
    basis.originalRowHash !== entry.rowHash ||
    !MD5.test(basis.stableRowHash || '') ||
    !validId(basis.runId) ||
    basis.runId >= browserWindow.audit.runId ||
    basisFile !== `http-apply-basis-${entry.id}-run-${basis.runId}.json`
  )
    throw fault('BROWSER_RECEIPT_BASIS_INVALID');
  const http = readSample(
    root,
    httpSourceAudit,
    'http',
    entry,
    planState.started,
    browserWindow.started
  );
  if (http.audit.runId !== basis.runId || http.sha256 !== basis.auditSha256)
    throw fault('BROWSER_RECEIPT_BASIS_INVALID');
  const intent = readNamed(root, `http-apply-intent-${entry.id}.json`).value;
  const prefix = `http-apply-${entry.id}-${intent.attemptId}`;
  if (
    !MD5.test(intent.attemptId || '') ||
    intent.state !== 'APPLIED' ||
    intent.orderId !== entry.id ||
    intent.runId !== basis.runId ||
    intent.sourceAudit !== httpSourceAudit ||
    ['payload', 'preview', 'result', 'audit'].some(
      kind => intent[`${kind}File`] !== `${prefix}-${kind}.json`
    )
  )
    throw fault('BROWSER_RECEIPT_BASIS_INVALID');
  const payload = readNamed(root, intent.payloadFile).value;
  const preview = readNamed(root, intent.previewFile).value;
  const result = readNamed(root, intent.resultFile).value;
  const applied = readNamed(root, intent.auditFile).value;
  const payloadSha256 = hash(JSON.stringify(payload));
  if (
    payload.version !== 1 ||
    payload.planSha256 !== planState.sha256 ||
    !isDeepStrictEqual(payload.plan, planState.plan) ||
    !isDeepStrictEqual(payload.entry, entry) ||
    payload.result?.systemOrderId !== entry.id ||
    payload.result?.orderNumber !== entry.orderNumber ||
    payload.result?.source?.runId !== basis.runId ||
    payload.evidence?.auditSha256 !== http.sha256 ||
    !isDeepStrictEqual(payload.audit, http.audit) ||
    preview.version !== 1 ||
    preview.mode !== 'dry-run' ||
    preview.businessWrites !== 0 ||
    result.version !== 1 ||
    result.mode !== 'apply' ||
    ![0, 1].includes(result.businessWrites) ||
    [preview, result].some(
      value =>
        value.orderId !== entry.id ||
        value.runId !== basis.runId ||
        value.payloadSha256 !== payloadSha256 ||
        !isDeepStrictEqual(value.basis, basis) ||
        value.stableRowHash !== basis.stableRowHash ||
        !MD5.test(value.beforeHash || '')
    ) ||
    !MD5.test(result.afterHash || '') ||
    preview.beforeHash !== result.beforeHash ||
    preview.devicesHash !== result.devicesHash ||
    !SHA256.test(result.devicesHash || '') ||
    applied.outcome !== 'SUCCEEDED' ||
    applied.mode !== 'apply' ||
    applied.orderId !== entry.id ||
    applied.runId !== basis.runId ||
    applied.resultFile !== intent.resultFile ||
    applied.basisFile !== basisFile ||
    applied.beforeHash !== result.beforeHash ||
    applied.afterHash !== result.afterHash ||
    applied.businessWrites !== result.businessWrites
  )
    throw fault('BROWSER_RECEIPT_BASIS_INVALID');
  return {
    entry: { ...entry, stableRowHash: basis.stableRowHash },
    basisEvidence: {
      basisFile,
      basisSha256,
      httpSourceAudit,
      httpSourceAuditSha256: http.sha256,
      httpApplyAuditFile: intent.auditFile,
    },
  };
}

/**
 * 只读重验本轮浏览器详情、收据、前后出口及可选旧 HTTP 回写依据，生成原 bindReceipt 私密输入。
 * @param {object} options 私密根目录、系统订单 ID、本次浏览器审计及可选 basis/HTTP 来源审计。
 * @returns {object} 含明确订单身份与全量 SN 的私密载荷；调用者不得输出到普通日志。
 */
function verifyBrowserReceipt({
  root,
  orderId,
  auditFile,
  basisFile,
  httpSourceAudit,
  now = Date.now(),
}) {
  try {
    if (!path.isAbsolute(root || '') || !validId(orderId) || !Number.isFinite(now))
      throw fault('BROWSER_RECEIPT_INPUT_INVALID');
    root = fs.realpathSync(root);
    const planState = readPlan(root, orderId, now);
    const window = readSample(root, auditFile, 'browser', planState.entry, planState.started, now);
    const { audit } = window;
    if (
      audit.auditFile !== auditFile ||
      audit.receiptEgressVerifiedAfter !== true ||
      audit.detailRunId !== audit.runId ||
      !validId(audit.receiptRunId) ||
      audit.receiptRunId <= audit.runId ||
      audit.receiptOutcome !== 'RECEIPT_CAPTURED' ||
      audit.receipt?.outcome !== 'RECEIPT_CAPTURED' ||
      audit.receipt?.orderId !== orderId ||
      audit.receipt?.detailRun !== audit.runId ||
      audit.receipt?.runId !== audit.receiptRunId ||
      !SHA256.test(audit.proxyHash || '') ||
      audit.receiptFile !== `/research/private/receipt-probe-${orderId}.json`
    )
      throw fault('BROWSER_RECEIPT_AUDIT_INVALID');
    const lease = audit.leaseContext;
    const leaseStarted = Date.parse(lease?.startedAt);
    if (
      lease?.provider !== 'iproyal' ||
      lease.proxyHash !== audit.proxyHash ||
      lease.egressHash !== audit.egressHash ||
      !Number.isFinite(leaseStarted) ||
      leaseStarted > window.started ||
      window.finished - leaseStarted > proxyLeaseWindowMs(lease, true)
    )
      throw fault('BROWSER_RECEIPT_LEASE_INVALID');
    const { entry, basisEvidence } = verifyBasis(
      root,
      planState,
      window,
      basisFile,
      httpSourceAudit
    );
    const receipt = readJson(root, `private/receipt-probe-${orderId}.json`).value;
    const detailResult = readJson(
      root,
      `private/results/order-${orderId}-run-${audit.runId}.json`
    ).value;
    const source = detailResult.source;
    if (
      receipt.systemOrderId !== orderId ||
      receipt.orderNumber !== entry.orderNumber ||
      receipt.runId !== audit.receiptRunId ||
      receipt.detailRun !== audit.runId ||
      receipt.status !== LIMITS.httpOk ||
      !/^text\/html(?:\s*;|$)/i.test(receipt.contentType || '') ||
      receipt.file !== `receipt-probe-${receipt.runId}.enc` ||
      receipt.transport !== 'same-browser' ||
      receipt.egressVerifiedAfter !== true ||
      receipt.egressHash !== audit.egressHash ||
      receipt.egressAfterHash !== audit.egressAfterHash ||
      receipt.proxyHash !== audit.proxyHash ||
      receipt.browserAttemptId !== audit.attemptId ||
      receipt.browserAuditFile !== auditFile ||
      receipt.browserAuditSha256 !== window.sha256 ||
      receipt.leaseStartedAt !== lease.startedAt ||
      !SHA256.test(receipt.sha256 || '') ||
      !SHA256.test(receipt.urlHash || '') ||
      detailResult.systemOrderId !== orderId ||
      detailResult.orderNumber !== entry.orderNumber ||
      source?.provider !== 'Apple official website' ||
      source.runId !== audit.runId ||
      source.sampleId !== orderId ||
      source.cached !== false ||
      !isOfficialOrderResponse(source) ||
      !SHA256.test(source.urlHash || '') ||
      source.sha256 !== receipt.detailSha256 ||
      !/^(?:text\/html|application\/json)(?:\s*;|$)/i.test(source.contentType || '') ||
      !['pre-login', 'post-login'].includes(source.phase)
    )
      throw fault('BROWSER_RECEIPT_METADATA_INVALID');
    const detailTime = freshTime(source.observedAt, window, now);
    const receiptTime = freshTime(receipt.observedAt, window, now);
    if (receiptTime < detailTime) throw fault('BROWSER_RECEIPT_TIME_INVALID');
    const key = readFile(root, 'private/evidence.key');
    if (key.length !== LIMITS.keyBytes) throw fault('BROWSER_RECEIPT_KEY_INVALID');
    const directory = `evidence/run-${audit.runId}`;
    const events = readFile(root, `${directory}/events.jsonl`)
      .toString('utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    const detailBytes = readBody(root, directory, source.file, source.sha256, key);
    const detailEvent = verifyBodyEvent(events, source, detailBytes, window, now);
    if (Date.parse(detailEvent.timestamp) > detailTime) throw fault('BROWSER_RECEIPT_TIME_INVALID');
    const detail = parseOfficialOrderDetail(detailBytes.toString('utf8'), entry.orderNumber);
    const storedDetail = { ...detailResult };
    delete storedDetail.systemOrderId;
    delete storedDetail.source;
    if (!detail || !isDeepStrictEqual(detail, storedDetail))
      throw fault('BROWSER_RECEIPT_DETAIL_INVALID');
    const url = extractOfficialReceiptUrl(
      detailBytes.toString('utf8'),
      entry.orderNumber,
      source.host
    );
    if (hash(url.href) !== receipt.urlHash) throw fault('BROWSER_RECEIPT_URL_INVALID');
    const receiptBytes = decrypt(readFile(root, `evidence/${receipt.file}`), key);
    if (hash(receiptBytes) !== receipt.sha256) throw fault('BROWSER_RECEIPT_HASH_INVALID');
    const captured = events.filter(
      event =>
        event.message === 'body' && event.phase === 'receipt' && event.urlHash === receipt.urlHash
    );
    if (
      captured.length !== 1 ||
      captured[0].sampleId !== orderId ||
      captured[0].status !== LIMITS.httpOk ||
      captured[0].cached !== false ||
      captured[0].host !== url.hostname ||
      captured[0].path !== safePath(url.pathname) ||
      captured[0].contentType !== receipt.contentType ||
      captured[0].sha256 !== receipt.sha256 ||
      !['Document', 'XHR', 'Fetch'].includes(captured[0].type) ||
      Date.parse(captured[0].timestamp) < detailTime ||
      Date.parse(captured[0].timestamp) > receiptTime
    )
      throw fault('BROWSER_RECEIPT_EVENT_INVALID');
    const copy = readBody(root, directory, captured[0].file, captured[0].sha256, key);
    if (!copy.equals(receiptBytes)) throw fault('BROWSER_RECEIPT_HASH_INVALID');
    verifyBodyEvent(events, captured[0], copy, window, now);
    const quantity = detail.products.reduce((sum, product) => sum + product.quantity, 0);
    const parsed = parseOfficialReceipt(receiptBytes.toString('utf8'), entry.orderNumber, quantity);
    return {
      startedAt: planState.plan.startedAt,
      cutoff: planState.plan.cutoff,
      scope: planState.plan.scope,
      schemaVersion: planState.plan.schemaVersion,
      entry,
      receipt: { ...receipt, ...(basisEvidence || {}) },
      parsed,
    };
  } catch (error) {
    error.component = 'verifyBrowserReceipt';
    throw error;
  }
}

if (require.main === module) {
  try {
    const [root, id, auditFile, basisFile, httpSourceAudit] = process.argv.slice(LIMITS.argvOffset);
    if (
      ![LIMITS.minimumArgc, LIMITS.basisArgc].includes(process.argv.length) ||
      !/^[1-9]\d*$/.test(id || '')
    )
      throw fault('BROWSER_RECEIPT_INPUT_INVALID');
    process.stdout.write(
      JSON.stringify(
        verifyBrowserReceipt({ root, orderId: Number(id), auditFile, basisFile, httpSourceAudit })
      )
    );
  } catch (error) {
    process.stderr.write(
      /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'BROWSER_RECEIPT_VERIFY_FAILED'
    );
    process.exitCode = 1;
  }
}

module.exports = { verifyBrowserReceipt };
