const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const {
  decrypt,
  hash,
  fault,
  permittedUrl,
  safePath,
} = require('../../src/services/officialOrderSupport');
const { parseOfficialOrderDetail } = require('../../src/services/officialOrderParser');
const {
  extractOfficialReceiptUrl,
  parseOfficialReceipt,
} = require('../../src/services/officialOrderReceipt');
const { validateReadUrl } = require('../../src/services/officialOrderHttpCollector');
const { buildGuestRequestEvidence } = require('../../src/services/officialOrderRequestEvidence');

const LIMITS = Object.freeze({
  metadataBytes: 1048576,
  evidenceBytes: 8388608,
  planAgeMs: 86400000,
  observationAgeMs: 300000,
  sampleDurationMs: 360000,
  clockSkewMs: 5000,
  orders: 10000,
  permissionMask: 0o077,
});
const MILLISECONDS_PER_SECOND = 1000;
const HTTP_OK = 200;
const PROXY_541_LIMIT = 3;
const MISSING_FIELDS_SCHEMA = 3;
const MATCH_VALUE_INDEX = 2;
const HASH_PREFIX_LENGTH = 16;
const DETAIL_PATH_SEGMENTS = 6;
const DETAIL_ORDER_INDEX = 5;
const GUEST_ORDER_INDEX = 4;
const PATH_PREFIX_END = 4;
const CLI_ARGUMENT_OFFSET = 2;
const CLI_ARGUMENT_COUNT = 6;
const CLI_BASIS_ARGUMENT_COUNT = 7;
const SHA256 = /^[a-f0-9]{64}$/;
const MD5 = /^[a-f0-9]{32}$/;
const BODY_FILE = /^body-([1-9]\d*)-([a-f0-9]{16})\.enc$/;
const SOURCE_FIELDS = [
  'provider',
  'status',
  'cached',
  'host',
  'path',
  'urlHash',
  'observedAt',
  'sha256',
  'file',
  'runId',
  'contentType',
];

function readFile(root, relative, maximum = LIMITS.metadataBytes) {
  const file = path.join(root, relative);
  const stat = fs.lstatSync(file);
  const resolved = fs.realpathSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & LIMITS.permissionMask ||
    !resolved.startsWith(`${root}${path.sep}`) ||
    stat.size > maximum
  )
    throw fault('HTTP_RECEIPT_FILE_INVALID');
  return fs.readFileSync(file);
}

function readJson(root, relative) {
  return JSON.parse(readFile(root, relative).toString('utf8'));
}

function readEncrypted(root, relative, key, json = false) {
  const bytes = decrypt(readFile(root, relative, LIMITS.evidenceBytes), key);
  return json ? JSON.parse(bytes.toString('utf8')) : bytes;
}

function readPlanEntry(root, orderId, now) {
  const planBytes = readFile(root, 'private/plan.json');
  const plan = JSON.parse(planBytes.toString('utf8'));
  const started = Date.parse(plan.startedAt);
  if (
    plan.schemaVersion !== MISSING_FIELDS_SCHEMA ||
    plan.scope !== 'missing-fields' ||
    plan.cutoff !== null ||
    plan.policy?.loginCooldown !== true ||
    plan.policy?.apiHealthCheck !== true ||
    plan.policy?.proxy541Limit !== PROXY_541_LIMIT ||
    !Number.isFinite(started) ||
    started > now ||
    now - started > LIMITS.planAgeMs ||
    !Array.isArray(plan.entries) ||
    !plan.entries.length ||
    plan.entries.length > LIMITS.orders ||
    new Set(plan.entries.map(entry => entry?.id)).size !== plan.entries.length
  )
    throw fault('HTTP_RECEIPT_SCOPE_INVALID');
  let entry = plan.entries.find(value => value?.id === orderId);
  if (
    !entry ||
    !/^W\d{10}$/.test(entry.orderNumber || '') ||
    !MD5.test(entry.rowHash || '') ||
    typeof entry.dateMissing !== 'boolean' ||
    typeof entry.serialsMissing !== 'boolean' ||
    !(entry.dateMissing || entry.serialsMissing) ||
    !Array.isArray(entry.previousDevices)
  )
    throw fault('HTTP_RECEIPT_SCOPE_INVALID');
  if (fs.existsSync(path.join(root, 'private/status-plan.json'))) {
    const derived = readJson(root, 'private/status-plan.json');
    const { statusSync, entries, ...base } = derived;
    const { entries: originalEntries, ...originalBase } = plan;
    if (
      statusSync !== true ||
      !isDeepStrictEqual(base, originalBase) ||
      !Array.isArray(entries) ||
      entries.length !== originalEntries.length ||
      entries.some((value, index) => {
        const { stableRowHash, ...original } = value || {};
        return (
          !MD5.test(stableRowHash || '') || !isDeepStrictEqual(original, originalEntries[index])
        );
      })
    )
      throw fault('HTTP_RECEIPT_STATUS_PLAN_INVALID');
    entry = entries.find(value => value.id === orderId);
  }
  return { plan, entry, started, planSha256: hash(planBytes) };
}

function applyBindingBasis(root, basisFile, entry, planSha256, runId, auditSha256) {
  if (basisFile === undefined) return { entry };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(basisFile || ''))
    throw fault('HTTP_RECEIPT_BASIS_INVALID');
  const bytes = readFile(root, `private/${basisFile}`);
  const value = JSON.parse(bytes.toString('utf8'));
  const basis = value?.basis || value;
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
    basis.planSha256 !== planSha256 ||
    basis.orderId !== entry.id ||
    basis.originalRowHash !== entry.rowHash ||
    basis.runId !== runId ||
    basis.auditSha256 !== auditSha256 ||
    !MD5.test(basis.stableRowHash || '') ||
    (entry.stableRowHash && entry.stableRowHash !== basis.stableRowHash)
  )
    throw fault('HTTP_RECEIPT_BASIS_INVALID');
  return { entry: { ...entry, stableRowHash: basis.stableRowHash }, basisSha256: hash(bytes) };
}

function readAudit(root, auditFile, orderId, runId, planStarted, now) {
  const match = /^http-sample-([1-9]\d*)-([a-f0-9]{32})\.json$/.exec(auditFile || '');
  if (!match || Number(match[1]) !== orderId) throw fault('HTTP_RECEIPT_AUDIT_INVALID');
  const auditBytes = readFile(root, `private/${auditFile}`);
  const audit = JSON.parse(auditBytes.toString('utf8'));
  const started = audit.startedAt * MILLISECONDS_PER_SECOND;
  const finished = audit.finishedAt * MILLISECONDS_PER_SECOND;
  if (
    audit.attemptId !== match[MATCH_VALUE_INDEX] ||
    audit.targetOrderId !== orderId ||
    audit.orderId !== orderId ||
    audit.runId !== runId ||
    audit.outcome !== 'SUCCEEDED' ||
    audit.receiptOutcome !== 'RECEIPT_VERIFIED' ||
    audit.businessWrites !== 0 ||
    audit.cleanup?.removed !== true ||
    audit.resultFile !== `/research/private/results/order-${orderId}-run-${runId}.json` ||
    audit.egressVerifiedAfter !== true ||
    !SHA256.test(audit.egressHash || '') ||
    audit.egressAfterHash !== audit.egressHash ||
    typeof audit.startedAt !== 'number' ||
    !Number.isFinite(started) ||
    typeof audit.finishedAt !== 'number' ||
    !Number.isFinite(finished) ||
    started < planStarted ||
    finished < started ||
    finished > now + LIMITS.clockSkewMs ||
    finished - started > LIMITS.sampleDurationMs
  )
    throw fault('HTTP_RECEIPT_AUDIT_INVALID');
  return { audit, auditSha256: hash(auditBytes), started, finished };
}

function sourceEvidence(root, source, key, runId, events, window, now) {
  const fileMatch = BODY_FILE.exec(source?.file || '');
  const observed = Date.parse(source?.observedAt);
  if (
    !fileMatch ||
    source.runId !== runId ||
    source.provider !== 'Apple official website' ||
    source.status !== HTTP_OK ||
    source.cached !== false ||
    !SHA256.test(source.sha256 || '') ||
    fileMatch[MATCH_VALUE_INDEX] !== source.sha256.slice(0, HASH_PREFIX_LENGTH) ||
    !SHA256.test(source.urlHash || '') ||
    !/^(?:secure\d*\.)?www\.apple\.com\.cn$/.test(source.host || '') ||
    !Number.isFinite(observed) ||
    observed < window.started - LIMITS.clockSkewMs ||
    observed > window.finished + LIMITS.clockSkewMs ||
    observed > now + LIMITS.clockSkewMs ||
    now - observed > LIMITS.observationAgeMs
  )
    throw fault('HTTP_RECEIPT_SOURCE_INVALID');
  const index = Number(fileMatch[1]);
  if (!Number.isSafeInteger(index)) throw fault('HTTP_RECEIPT_SOURCE_INVALID');
  const prefix = `evidence/run-${runId}`;
  const body = readEncrypted(root, `${prefix}/${source.file}`, key);
  const response = readEncrypted(root, `${prefix}/response-${index}.enc`, key, true);
  const request = readEncrypted(root, `${prefix}/request-${index}.enc`, key, true);
  const url = permittedUrl(response.url);
  const decoded =
    typeof response.bodyBase64 === 'string' ? Buffer.from(response.bodyBase64, 'base64') : null;
  const responseType = Object.entries(response.headers || {}).find(
    ([name]) => name.toLowerCase() === 'content-type'
  )?.[1];
  const logged = events.filter(event => event.file === source.file);
  if (
    hash(body) !== source.sha256 ||
    !decoded ||
    decoded.toString('base64') !== response.bodyBase64 ||
    !decoded.equals(body) ||
    response.status !== HTTP_OK ||
    hash(url.href) !== source.urlHash ||
    source.host !== url.hostname ||
    source.path !== safePath(url.pathname) ||
    typeof responseType !== 'string' ||
    !/^(?:text\/html|application\/json)(?:\s*;|$)/i.test(responseType) ||
    source.contentType !== responseType ||
    request.url !== url.href ||
    !['GET', 'POST'].includes(request.method) ||
    !Number.isFinite(Date.parse(request.observedAt)) ||
    Date.parse(request.observedAt) < window.started - LIMITS.clockSkewMs ||
    Date.parse(request.observedAt) > observed + LIMITS.clockSkewMs ||
    logged.length !== 1 ||
    logged[0].message !== 'http_response' ||
    logged[0].method !== request.method ||
    logged[0].bytes !== body.length ||
    SOURCE_FIELDS.some(field => logged[0][field] !== source[field])
  )
    throw fault('HTTP_RECEIPT_EVIDENCE_MISMATCH');
  validateReadUrl(url.href, request.method);
  return { body: body.toString('utf8'), request, response, url, index, observed };
}

function validateDetailRequest(evidence, orderNumber) {
  if (evidence.request.method === 'POST') {
    if (
      !['', null].includes(evidence.request.body) ||
      !buildGuestRequestEvidence(
        {
          url: evidence.url.href,
          method: 'POST',
          headers: evidence.request.headers,
          hasPostData: false,
        },
        orderNumber
      )
    )
      throw fault('HTTP_RECEIPT_DETAIL_REQUEST_INVALID');
  } else {
    const parts = evidence.url.pathname.split('/').map(decodeURIComponent);
    const prefix = parts.slice(1, PATH_PREFIX_END).join('/');
    const orderIndex = prefix === 'shop/order/detail' ? DETAIL_ORDER_INDEX : GUEST_ORDER_INDEX;
    if (
      parts.length !== DETAIL_PATH_SEGMENTS ||
      !['shop/order/detail', 'shop/order/guest', 'shop/order/list', 'xc/cn/vieworder'].includes(
        prefix
      ) ||
      parts[orderIndex] !== orderNumber ||
      ![null, ''].includes(evidence.request.body)
    )
      throw fault('HTTP_RECEIPT_DETAIL_REQUEST_INVALID');
  }
}

/**
 * 只读核对 HTTP 详情、收据与服务器前后出口审计，生成原 bindReceipt 的私密输入。
 * 不接受裸 parsed、单独的成功标志或旧采集记录；不写文件、不连接数据库、不发请求。
 * @param {object} options 根目录、订单/运行编号、明确审计文件名和当前时间。
 * @returns {object} 已核验的私密绑定载荷，含全量 SN；只可送入受控绑定入口。
 */
function verifyHttpReceipt({ root, orderId, runId, auditFile, basisFile, now = Date.now() }) {
  try {
    if (
      typeof root !== 'string' ||
      !path.isAbsolute(root) ||
      !Number.isSafeInteger(orderId) ||
      orderId <= 0 ||
      !Number.isSafeInteger(runId) ||
      runId <= 0 ||
      !Number.isFinite(now)
    )
      throw fault('HTTP_RECEIPT_INPUT_INVALID');
    root = fs.realpathSync(root);
    const { plan, entry: originalEntry, started, planSha256 } = readPlanEntry(root, orderId, now);
    const window = readAudit(root, auditFile, orderId, runId, started, now);
    const { entry, basisSha256 } = applyBindingBasis(
      root,
      basisFile,
      originalEntry,
      planSha256,
      runId,
      window.auditSha256
    );
    const metadata = readJson(root, `private/http-receipt-${orderId}-run-${runId}.json`);
    const result = readJson(root, `private/results/order-${orderId}-run-${runId}.json`);
    if (
      metadata.systemOrderId !== orderId ||
      metadata.detailRun !== runId ||
      result.systemOrderId !== orderId ||
      result.orderNumber !== entry.orderNumber ||
      !SHA256.test(metadata.detailSha256 || '') ||
      metadata.detailSha256 !== result.source?.sha256 ||
      !SHA256.test(metadata.urlHash || '')
    )
      throw fault('HTTP_RECEIPT_METADATA_INVALID');
    const key = readFile(root, 'private/evidence.key');
    const events = readFile(root, `evidence/run-${runId}/events.jsonl`)
      .toString('utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const detailEvidence = sourceEvidence(root, result.source, key, runId, events, window, now);
    validateDetailRequest(detailEvidence, entry.orderNumber);
    const detail = parseOfficialOrderDetail(detailEvidence.body, entry.orderNumber);
    const storedDetail = { ...result };
    delete storedDetail.systemOrderId;
    delete storedDetail.source;
    if (!detail || !isDeepStrictEqual(detail, storedDetail))
      throw fault('HTTP_RECEIPT_DETAIL_INVALID');
    const receiptUrl = extractOfficialReceiptUrl(
      detailEvidence.body,
      entry.orderNumber,
      result.source.host
    );
    const receiptEvidence = sourceEvidence(root, metadata.source, key, runId, events, window, now);
    if (
      receiptEvidence.index <= detailEvidence.index ||
      receiptEvidence.observed < detailEvidence.observed ||
      receiptEvidence.request.method !== 'GET' ||
      receiptEvidence.url.href !== receiptUrl.href ||
      metadata.urlHash !== hash(receiptUrl.href) ||
      metadata.source.urlHash !== metadata.urlHash
    )
      throw fault('HTTP_RECEIPT_BINDING_INVALID');
    const quantity = detail.products.reduce((sum, product) => sum + product.quantity, 0);
    const parsed = parseOfficialReceipt(receiptEvidence.body, entry.orderNumber, quantity);
    if (!isDeepStrictEqual(parsed, metadata.parsed)) throw fault('HTTP_RECEIPT_PARSED_MISMATCH');
    return {
      startedAt: plan.startedAt,
      cutoff: plan.cutoff,
      scope: plan.scope,
      schemaVersion: plan.schemaVersion,
      entry,
      receipt: {
        systemOrderId: orderId,
        orderNumber: entry.orderNumber,
        runId,
        detailRun: runId,
        detailSha256: result.source.sha256,
        status: HTTP_OK,
        contentType: metadata.source.contentType,
        observedAt: metadata.source.observedAt,
        file: metadata.source.file,
        sha256: metadata.source.sha256,
        urlHash: metadata.urlHash,
        transport: 'same-http-session',
        egressHash: window.audit.egressHash,
        egressVerifiedAfter: true,
        auditFile,
        auditSha256: window.auditSha256,
        ...(basisFile ? { basisFile, basisSha256 } : {}),
      },
      parsed,
    };
  } catch (error) {
    error.component = 'verifyHttpReceipt';
    throw error;
  }
}

if (require.main === module) {
  try {
    const [root, order, run, auditFile, basisFile] = process.argv.slice(CLI_ARGUMENT_OFFSET);
    if (
      ![CLI_ARGUMENT_COUNT, CLI_BASIS_ARGUMENT_COUNT].includes(process.argv.length) ||
      !/^[1-9]\d*$/.test(order || '') ||
      !/^[1-9]\d*$/.test(run || '')
    )
      throw fault('HTTP_RECEIPT_INPUT_INVALID');
    process.stdout.write(
      JSON.stringify(
        verifyHttpReceipt({
          root,
          orderId: Number(order),
          runId: Number(run),
          auditFile,
          basisFile,
        })
      )
    );
  } catch (error) {
    process.stderr.write(
      /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'HTTP_RECEIPT_VERIFY_FAILED'
    );
    process.exitCode = 1;
  }
}

module.exports = { verifyHttpReceipt };
