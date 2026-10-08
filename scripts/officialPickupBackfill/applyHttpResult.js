const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const {
  fault,
  hash,
  decrypt,
  permittedUrl,
  safePath,
  writePrivate,
} = require('../../src/services/officialOrderSupport');
const { parseOfficialOrderDetail } = require('../../src/services/officialOrderParser');
const { validateOfficialStatusResult } = require('../../src/services/officialOrderStatusSync');
const { deriveOfficialPickupDate } = require('../../src/services/officialPickupDate');
const { buildGuestRequestEvidence } = require('../../src/services/officialOrderRequestEvidence');

const LIMITS = Object.freeze({
  planAgeMs: 86400000,
  observationAgeMs: 300000,
  sampleDurationMs: 360000,
  fileBytes: 8388608,
  millisecondsPerSecond: 1000,
  schemaVersion: 3,
  maximumIds: 10000,
  keyBytes: 32,
  permissionMask: 0o077,
  prefixParts: 4,
  detailOrderIndex: 5,
  guestOrderIndex: 4,
  detailParts: 6,
  hashPrefixLength: 16,
  hashMatchIndex: 2,
  httpOk: 200,
  cliOffset: 2,
  verifyArgCount: 5,
  applyArgCount: 3,
});
const MD5 = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STATUS_FIELDS = ['actual_pickup_date', 'official_raw_status', 'official_status_observed_at'];
const EXPECTED_POLICY = { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 };
const STABLE_SQL =
  "md5((to_jsonb(o)-ARRAY['actual_pickup_date','official_raw_status'," +
  "'official_status_observed_at'])::text)";

function jsonHash(value) {
  return hash(JSON.stringify(value));
}

function validatePlan(plan, now) {
  const started = Date.parse(plan?.startedAt);
  if (
    plan?.schemaVersion !== LIMITS.schemaVersion ||
    plan.scope !== 'missing-fields' ||
    plan.cutoff !== null ||
    !isDeepStrictEqual(plan.policy, EXPECTED_POLICY) ||
    !Number.isFinite(started) ||
    started > now ||
    now - started > LIMITS.planAgeMs ||
    !Array.isArray(plan.entries) ||
    !plan.entries.length ||
    plan.entries.length > LIMITS.maximumIds ||
    new Set(plan.entries.map(entry => entry.id)).size !== plan.entries.length ||
    plan.entries.some(
      entry =>
        !Number.isSafeInteger(entry.id) ||
        entry.id <= 0 ||
        !/^W\d{10}$/.test(entry.orderNumber || '') ||
        !MD5.test(entry.rowHash || '') ||
        typeof entry.dateMissing !== 'boolean' ||
        typeof entry.serialsMissing !== 'boolean' ||
        !(entry.dateMissing || entry.serialsMissing) ||
        !Array.isArray(entry.previousDevices) ||
        entry.serialsMissing !== (entry.previousDevices.length === 0) ||
        entry.dateMissing !== (entry.previousDate === null)
    )
  )
    throw fault('HTTP_APPLY_SCOPE_INVALID');
}

function validateAudit(audit, entry, source, now) {
  const started = audit?.startedAt * LIMITS.millisecondsPerSecond;
  const finished = audit?.finishedAt * LIMITS.millisecondsPerSecond;
  const observed = Date.parse(source?.observedAt);
  if (
    audit?.outcome !== 'SUCCEEDED' ||
    audit.orderId !== entry.id ||
    audit.targetOrderId !== entry.id ||
    audit.runId !== source?.runId ||
    !MD5.test(audit.attemptId || '') ||
    audit.egressVerifiedAfter !== true ||
    !SHA256.test(audit.egressHash || '') ||
    audit.egressAfterHash !== audit.egressHash ||
    audit.businessWrites !== 0 ||
    audit.cleanup?.removed !== true ||
    typeof audit.startedAt !== 'number' ||
    typeof audit.finishedAt !== 'number' ||
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    finished - started > LIMITS.sampleDurationMs ||
    started > observed ||
    observed > finished ||
    finished > now ||
    now - observed > LIMITS.observationAgeMs ||
    audit.resultFile !== `/research/private/results/order-${entry.id}-run-${source.runId}.json`
  )
    throw fault('HTTP_APPLY_EGRESS_AUDIT_INVALID');
}

function validateDetailRequest(request, url, orderNumber) {
  if (request?.url !== url.href || !['', null].includes(request.body) || url.hash)
    throw fault('HTTP_APPLY_REQUEST_INVALID');
  if (request.method === 'POST') {
    if (
      !buildGuestRequestEvidence(
        { url: url.href, method: 'POST', headers: request.headers, hasPostData: false },
        orderNumber
      ) ||
      [...url.searchParams.keys()].some(name => !['_a', '_m', 'e'].includes(name)) ||
      url.searchParams.getAll('e').length > 1 ||
      (url.searchParams.has('e') && url.searchParams.get('e') !== 'true')
    )
      throw fault('HTTP_APPLY_REQUEST_INVALID');
    return;
  }
  const parts = url.pathname.split('/').map(decodeURIComponent);
  const prefix = parts.slice(1, LIMITS.prefixParts).join('/');
  const orderIndex =
    prefix === 'shop/order/detail' ? LIMITS.detailOrderIndex : LIMITS.guestOrderIndex;
  if (
    request.method !== 'GET' ||
    parts.length !== LIMITS.detailParts ||
    !['shop/order/detail', 'shop/order/guest', 'shop/order/list', 'xc/cn/vieworder'].includes(
      prefix
    ) ||
    parts[orderIndex] !== orderNumber ||
    (url.search && (prefix !== 'shop/order/guest' || url.search !== '?e=true'))
  )
    throw fault('HTTP_APPLY_REQUEST_INVALID');
}

function privateBytes(root, file, maximum = LIMITS.fileBytes) {
  const info = fs.lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.mode & LIMITS.permissionMask ||
    info.size > maximum ||
    !fs.realpathSync(file).startsWith(`${root}${path.sep}`)
  )
    throw fault('HTTP_APPLY_PRIVATE_FILE_INVALID');
  return fs.readFileSync(file);
}

function validatePayload(payload, now = Date.now()) {
  if (payload?.version !== 1 || !SHA256.test(payload.planSha256 || ''))
    throw fault('HTTP_APPLY_PAYLOAD_INVALID');
  validatePlan(payload.plan, now);
  const entry = payload.plan.entries.find(item => item.id === payload.entry?.id);
  if (!entry || !isDeepStrictEqual(entry, payload.entry)) throw fault('HTTP_APPLY_SCOPE_INVALID');
  const result = payload.result;
  const observed = Date.parse(result?.source?.observedAt);
  if (
    !Number.isFinite(observed) ||
    observed < Date.parse(payload.plan.startedAt) ||
    observed > now ||
    now - observed > LIMITS.observationAgeMs ||
    !SHA256.test(payload.evidence?.bodySha256 || '') ||
    payload.evidence.bodySha256 !== result?.source?.sha256 ||
    !SHA256.test(payload.evidence?.responseSha256 || '') ||
    !SHA256.test(payload.evidence?.requestSha256 || '') ||
    !SHA256.test(payload.evidence?.auditSha256 || '') ||
    !/^application\/json\b|^text\/html\b/i.test(result?.source?.contentType || '')
  )
    throw fault('HTTP_APPLY_SOURCE_INVALID');
  validateAudit(payload.audit, entry, result.source, now);
  if (payload.audit.startedAt * LIMITS.millisecondsPerSecond < Date.parse(payload.plan.startedAt))
    throw fault('HTTP_APPLY_SCOPE_INVALID');
  const checked = validateOfficialStatusResult(
    result,
    {
      orderId: entry.id,
      orderNumber: entry.orderNumber,
      startedAt: payload.plan.startedAt,
    },
    now
  );
  return {
    entry,
    checked,
    derivedDate: deriveOfficialPickupDate(result, result.source.observedAt),
  };
}

/**
 * 在无网络研究容器核对当前 HTTP 原文、加密响应和宿主前后出口；返回值为私密管道 payload。
 * @param {string} root 研究根目录。
 * @param {string} auditName 私密目录中的本次样本审计文件名。
 * @param {number} now 当前毫秒时间，仅测试注入。
 * @returns {object} 不可直接展示的身份及原文重解析结果。
 */
function verifyHttpEvidence(root, auditName, now = Date.now()) {
  if (
    !path.isAbsolute(root || '') ||
    !/^http-sample-[1-9]\d*-[a-f0-9]{32}\.json$/.test(auditName || '')
  )
    throw fault('HTTP_APPLY_ARGUMENT_INVALID');
  root = fs.realpathSync(root);
  const planBytes = privateBytes(root, path.join(root, 'private/plan.json'));
  const plan = JSON.parse(planBytes.toString('utf8'));
  validatePlan(plan, now);
  const auditBytes = privateBytes(root, path.join(root, 'private', auditName));
  const audit = JSON.parse(auditBytes.toString('utf8'));
  const entry = plan.entries.find(item => item.id === audit.targetOrderId);
  if (
    !entry ||
    auditName !== `http-sample-${entry.id}-${audit.attemptId}.json` ||
    !Number.isSafeInteger(audit.runId) ||
    audit.runId <= 0
  )
    throw fault('HTTP_APPLY_SCOPE_INVALID');
  const result = JSON.parse(
    privateBytes(
      root,
      path.join(root, `private/results/order-${entry.id}-run-${audit.runId}.json`)
    ).toString('utf8')
  );
  const source = result.source;
  const match = /^body-([1-9]\d*)-([a-f0-9]{16})\.enc$/.exec(source?.file || '');
  if (
    !match ||
    source.runId !== audit.runId ||
    result.systemOrderId !== entry.id ||
    result.orderNumber !== entry.orderNumber ||
    source.sha256?.slice(0, LIMITS.hashPrefixLength) !== match[LIMITS.hashMatchIndex]
  )
    throw fault('HTTP_APPLY_SOURCE_INVALID');
  validateAudit(audit, entry, source, now);
  const key = privateBytes(root, path.join(root, 'private/evidence.key'), LIMITS.keyBytes);
  if (key.length !== LIMITS.keyBytes) throw fault('HTTP_APPLY_KEY_INVALID');
  const directory = path.join(root, `evidence/run-${audit.runId}`);
  const bytes = decrypt(privateBytes(root, path.join(directory, source.file)), key);
  const responseBytes = decrypt(
    privateBytes(root, path.join(directory, `response-${match[1]}.enc`)),
    key
  );
  const response = JSON.parse(responseBytes.toString('utf8'));
  const requestBytes = decrypt(
    privateBytes(root, path.join(directory, `request-${match[1]}.enc`)),
    key
  );
  const request = JSON.parse(requestBytes.toString('utf8'));
  const url = permittedUrl(response.url);
  validateDetailRequest(request, url, entry.orderNumber);
  const responseBody = Buffer.from(response.bodyBase64 || '', 'base64');
  const rawContentTypes = response.rawHeaders?.filter(
    pair =>
      Array.isArray(pair) && typeof pair[0] === 'string' && pair[0].toLowerCase() === 'content-type'
  );
  const events = privateBytes(root, path.join(directory, 'events.jsonl'))
    .toString('utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const evidenceEvents = events.filter(
    event => event.message === 'http_response' && event.file === source.file
  );
  if (
    !/^(?:secure\d*\.)?www\.apple\.com\.cn$/.test(url.hostname) ||
    response.status !== LIMITS.httpOk ||
    source.status !== LIMITS.httpOk ||
    source.cached !== false ||
    url.hostname !== source.host ||
    safePath(url.pathname) !== source.path ||
    hash(url.href) !== source.urlHash ||
    hash(bytes) !== source.sha256 ||
    !bytes.equals(responseBody) ||
    responseBody.toString('base64') !== response.bodyBase64 ||
    rawContentTypes?.length !== 1 ||
    rawContentTypes[0][1] !== source.contentType ||
    !Number.isFinite(Date.parse(request.observedAt)) ||
    Date.parse(request.observedAt) < audit.startedAt * LIMITS.millisecondsPerSecond ||
    Date.parse(request.observedAt) > Date.parse(source.observedAt) ||
    evidenceEvents.length !== 1 ||
    evidenceEvents[0].method !== request.method ||
    evidenceEvents[0].bytes !== bytes.length ||
    [
      'provider',
      'status',
      'contentType',
      'cached',
      'host',
      'path',
      'urlHash',
      'observedAt',
      'sha256',
      'file',
      'runId',
    ].some(name => evidenceEvents[0][name] !== source[name])
  )
    throw fault('HTTP_APPLY_SOURCE_INVALID');
  const parsed = parseOfficialOrderDetail(bytes.toString('utf8'), entry.orderNumber);
  if (!parsed) throw fault('HTTP_APPLY_SOURCE_INVALID');
  const payload = {
    version: 1,
    plan,
    planSha256: hash(planBytes),
    entry,
    result: { ...parsed, systemOrderId: entry.id, source },
    audit,
    evidence: {
      bodySha256: hash(bytes),
      responseSha256: hash(responseBytes),
      requestSha256: hash(requestBytes),
      auditSha256: hash(auditBytes),
    },
  };
  validatePayload(payload, now);
  return payload;
}

function validBasis(basis, payload) {
  return (
    basis?.version === 1 &&
    basis.planSha256 === payload.planSha256 &&
    basis.orderId === payload.entry.id &&
    basis.originalRowHash === payload.entry.rowHash &&
    basis.runId === payload.result.source.runId &&
    basis.auditSha256 === payload.evidence.auditSha256 &&
    MD5.test(basis.stableRowHash || '')
  );
}

async function snapshot(client, entry, lock, candidateObservedAt) {
  try {
    const { rows } = await client.query(
      `SELECT to_jsonb(o) AS snapshot, actual_pickup_date::text AS date,
       official_raw_status AS status, official_status_observed_at::text AS observed,
       (official_status_observed_at IS NULL OR
        official_status_observed_at <= $3::timestamptz) AS "observationEligible",
       (official_status_observed_at IS NOT DISTINCT FROM $3::timestamptz) AS "observationEqual",
       md5(to_jsonb(o)::text) AS "fullHash",
       md5((to_jsonb(o)-'actual_pickup_date')::text) AS "originalHash",
       ${STABLE_SQL} AS "stableHash",
       (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb)
        FROM pickup_devices d WHERE d.order_id=o.id) AS devices
       FROM orders o WHERE id=$1 AND order_number=$2 AND email_order_status='picked_up'
       ${lock ? 'FOR UPDATE' : ''}`,
      [entry.id, entry.orderNumber, candidateObservedAt]
    );
    if (rows.length !== 1) throw fault('HTTP_APPLY_ORDER_CHANGED');
    return rows[0];
  } catch (error) {
    error.component = 'officialHttpApplySnapshot';
    throw error;
  }
}

/**
 * 正式库单目标事务。dry-run 完全只读，返回私密 preview 供调用者先保存。
 * apply 必须持有同一 payload 的已保存 preview，锁行后核对完整 beforeHash；不覆盖任何非空日期。
 * @param {object} client 已连接的正式业务 PostgreSQL client，研究库不可用。
 * @param {object} payload verifyHttpEvidence 的私密结果。
 * @param {object} options 明确 mode=dry-run/apply、可选旧 basis 及 apply 必需 preview。
 * @returns {Promise<object>} 含私密 snapshot/basis 的审计结果，展示时用 publicHttpApplyResult。
 */
async function applyHttpPayload(client, payload, { mode, basis, preview } = {}) {
  if (!['dry-run', 'apply'].includes(mode)) throw fault('HTTP_APPLY_MODE_REQUIRED');
  const { entry } = validatePayload(payload);
  const payloadSha256 = jsonHash(payload);
  if (basis && !validBasis(basis, payload)) throw fault('HTTP_APPLY_BASIS_INVALID');
  if (
    mode === 'apply' &&
    (preview?.version !== 1 ||
      preview.mode !== 'dry-run' ||
      preview.payloadSha256 !== payloadSha256 ||
      !validBasis(preview.basis, payload) ||
      !MD5.test(preview.beforeHash || '') ||
      !SHA256.test(preview.devicesHash || '') ||
      !isDeepStrictEqual(preview.basis, basis))
  )
    throw fault('HTTP_APPLY_PREVIEW_REQUIRED');
  try {
    await client.query(
      mode === 'dry-run' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN'
    );
    await client.query("SET LOCAL statement_timeout='8s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const before = await snapshot(
      client,
      entry,
      mode === 'apply',
      payload.result.source.observedAt
    );
    if (basis ? before.stableHash !== basis.stableRowHash : before.originalHash !== entry.rowHash)
      throw fault('HTTP_APPLY_ORDER_CHANGED');
    const resolvedBasis = basis || {
      version: 1,
      planSha256: payload.planSha256,
      orderId: entry.id,
      originalRowHash: entry.rowHash,
      stableRowHash: before.stableHash,
      runId: payload.result.source.runId,
      auditSha256: payload.evidence.auditSha256,
    };
    const devicesHash = jsonHash(before.devices);
    if (
      mode === 'apply' &&
      (before.fullHash !== preview.beforeHash ||
        devicesHash !== preview.devicesHash ||
        !isDeepStrictEqual(preview.snapshot, { order: before.snapshot, devices: before.devices }))
    )
      throw fault('HTTP_APPLY_ORDER_CHANGED');
    // 等待行锁后重新检查实际时钟，不能让旧结果因排队而越过五分钟时效。
    const { checked, derivedDate } = validatePayload(payload);
    const statusEligible = before.observationEligible;
    const statusChanged =
      statusEligible && (before.status !== checked.status || !before.observationEqual);
    const fillDate = statusEligible && entry.dateMissing && !before.date && derivedDate.date;
    const expectedDate = before.date || (fillDate ? derivedDate.date : null);
    const output = {
      version: 1,
      mode,
      orderId: entry.id,
      runId: checked.runId,
      payloadSha256,
      sha256: checked.sha256,
      basis: resolvedBasis,
      beforeHash: before.fullHash,
      afterHash: before.fullHash,
      devicesHash,
      stableRowHash: before.stableHash,
      statusSaved: false,
      dateFilled: false,
      statusAction: !statusEligible
        ? 'KEEP_NEWER_STATUS'
        : statusChanged
          ? 'UPDATE_STATUS'
          : 'UNCHANGED',
      dateAction: before.date
        ? 'KEEP_EXISTING_DATE'
        : fillDate
          ? 'FILL_DATE'
          : derivedDate.reason || 'UNCHANGED',
      previousDate: before.date,
      proposedDate: expectedDate,
      proposedOfficialStatus: statusEligible ? checked.status : before.status,
      proposedObservedAt: statusEligible ? checked.observedAt : before.observed,
      snapshot: { order: before.snapshot, devices: before.devices },
      businessWrites: 0,
    };
    if (mode === 'dry-run') {
      await client.query('ROLLBACK');
      return output;
    }
    if (statusChanged || fillDate) {
      await client.query(
        `UPDATE orders SET actual_pickup_date=CASE WHEN actual_pickup_date IS NULL AND $1
           THEN $2::date ELSE actual_pickup_date END,
         official_raw_status=CASE WHEN $3 THEN $4 ELSE official_raw_status END,
         official_status_observed_at=CASE WHEN $3 THEN $5::timestamptz
           ELSE official_status_observed_at END
         WHERE id=$6`,
        [
          Boolean(fillDate),
          derivedDate.date,
          statusChanged,
          checked.status,
          checked.observedAt,
          entry.id,
        ]
      );
    }
    const after = await snapshot(client, entry, false, checked.observedAt);
    const expectedStatus = statusChanged ? checked.status : before.status;
    if (
      after.stableHash !== before.stableHash ||
      after.date !== expectedDate ||
      after.status !== expectedStatus ||
      (statusChanged ? !after.observationEqual : after.observed !== before.observed) ||
      jsonHash(after.devices) !== devicesHash ||
      Object.entries(before.snapshot).some(
        ([key, value]) =>
          !STATUS_FIELDS.includes(key) && !isDeepStrictEqual(value, after.snapshot[key])
      )
    )
      throw fault('HTTP_APPLY_INVARIANCE_FAILED');
    await client.query('COMMIT');
    return {
      ...output,
      afterHash: after.fullHash,
      statusSaved: Boolean(statusChanged),
      dateFilled: Boolean(fillDate),
      businessWrites: statusChanged || fillDate ? 1 : 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    error.component = 'officialHttpApply';
    throw error;
  }
}

/** 只展示系统 ID、变更方案和摘要；不展示订单号、账号、设备 SN 或数据库行。 */
function publicHttpApplyResult(result) {
  return Object.fromEntries(
    [
      'mode',
      'orderId',
      'runId',
      'statusAction',
      'dateAction',
      'previousDate',
      'proposedDate',
      'proposedOfficialStatus',
      'proposedObservedAt',
      'statusSaved',
      'dateFilled',
      'businessWrites',
      'beforeHash',
      'afterHash',
      'sha256',
    ].map(key => [key, result[key]])
  );
}

async function main() {
  let client;
  try {
    const [mode, root, auditName] = process.argv.slice(LIMITS.cliOffset);
    if (mode === '--verify' && process.argv.length === LIMITS.verifyArgCount) {
      // 这是显式私密管道输出，只可重定向到 0600 文件或同机正式库进程 stdin。
      process.stdout.write(JSON.stringify(verifyHttpEvidence(root, auditName)) + '\n');
      return;
    }
    if (!['--dry-run', '--apply'].includes(mode) || process.argv.length !== LIMITS.applyArgCount)
      throw fault('HTTP_APPLY_ARGUMENT_INVALID');
    if (
      process.env.NODE_ENV !== 'production' ||
      !process.env.DB_HOST ||
      !process.env.DB_NAME ||
      /research|study/i.test(process.env.DB_HOST + ' ' + process.env.DB_NAME)
    )
      throw fault('HTTP_APPLY_BUSINESS_DATABASE_REQUIRED');
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > LIMITS.fileBytes) throw fault('HTTP_APPLY_INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const { Client } = require('pg');
    client = new Client({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    await client.connect();
    const check = await client.query(
      "SELECT current_database() AS name, to_regclass('public.orders') AS orders"
    );
    if (check.rows[0]?.name !== process.env.DB_NAME || !check.rows[0].orders)
      throw fault('HTTP_APPLY_BUSINESS_DATABASE_REQUIRED');
    const result = await applyHttpPayload(client, input.payload, {
      mode: mode.slice(LIMITS.cliOffset),
      basis: input.basis,
      preview: input.preview,
    });
    if (mode === '--dry-run') {
      if (!path.isAbsolute(input.privateOutput || ''))
        throw fault('HTTP_APPLY_PREVIEW_PATH_REQUIRED');
      writePrivate(input.privateOutput, JSON.stringify(result));
    }
    process.stdout.write(JSON.stringify(publicHttpApplyResult(result)) + '\n');
  } catch (error) {
    const code = error.code || '';
    process.stderr.write(
      JSON.stringify({ outcome: /^HTTP_APPLY_[A-Z_]+$/.test(code) ? code : 'HTTP_APPLY_FAILED' }) +
        '\n'
    );
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

if (require.main === module) main();
module.exports = { verifyHttpEvidence, applyHttpPayload, publicHttpApplyResult };
