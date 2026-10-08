const fs = require('fs');
const path = require('path');
const { readPrivate, decrypt, hash, fault, validateSample } = require('./officialOrderSupport');
const { parseOfficialOrderDetail } = require('./officialOrderParser');
const { parseOfficialReceipt, extractOfficialReceiptUrl } = require('./officialOrderReceipt');
const { validateReceiptBinding } = require('./officialReceiptBinding');

/** 官网详情中的设备数量为各行 quantity 之和，不能使用商品行数代替。 */
function receiptQuantity(detail) {
  if (
    !detail?.products?.length ||
    detail.products.some(
      item =>
        item.rawStatus !== 'PICKED_UP' || !Number.isSafeInteger(item.quantity) || item.quantity < 1
    )
  )
    throw fault('RECEIPT_DETAIL_NOT_PICKED_UP');
  const quantity = detail.products.reduce((sum, item) => sum + item.quantity, 0);
  if (!Number.isSafeInteger(quantity) || quantity > 100) throw fault('RECEIPT_QUANTITY_INVALID');
  return quantity;
}

/** 封闭文件名，避免证据 JSON 指向其他批次、符号链接或任意本地文件。 */
function evidenceFile(directory, name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+\.enc$/.test(name))
    throw fault('RECEIPT_FILE_INVALID');
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 8388640)
    throw fault('RECEIPT_FILE_INVALID');
  return fs.readFileSync(file);
}

/** 写入前独立重验原始正文、许可日志、Gate 与宿主审计，不信任预解析 SN。 */
function verifyReceiptEvidence(root, intent) {
  const input = readPrivate(`${root}/private/input.json`);
  const sample = validateSample(input.samples?.[0]);
  const result = readPrivate(`${root}/private/result.json`);
  const audit = readPrivate(`${root}/private/audit.json`);
  const gate = readPrivate(`${root}/private/gate.json`);
  const runId = result.runId;
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    result.systemOrderId !== sample.id ||
    result.outcome !== 'SUCCEEDED' ||
    result.receipt?.outcome !== 'RECEIPT_VERIFIED'
  )
    throw fault('RECEIPT_COLLECTOR_NOT_SUCCEEDED');
  const proof = readPrivate(`${root}/private/receipt-${runId}.json`);
  const detailResult = readPrivate(`${root}/private/results/order-${sample.id}-run-${runId}.json`);
  if (
    audit.cleanupConfirmed !== true ||
    !/^[a-f0-9]{64}$/.test(audit.egressBefore || '') ||
    audit.egressBefore !== audit.egressAfter ||
    audit.egressBefore !== proof.egressHash ||
    audit.orderId !== sample.id ||
    audit.attemptId !== intent.requestKey ||
    gate.runId !== runId ||
    gate.orderId !== sample.id ||
    gate.accountHash !== sample.accountHash ||
    gate.orderHash !== sample.orderHash ||
    gate.outcome !== 'SUCCEEDED' ||
    !gate.finishedAt ||
    gate.requests !== result.requests ||
    proof.version !== 1 ||
    proof.status !== 200 ||
    proof.runId !== runId ||
    proof.systemOrderId !== sample.id ||
    proof.orderNumber !== sample.orderNumber ||
    proof.transport !== 'native-controlled-click' ||
    proof.sha256 !== result.receipt.receiptSha256
  )
    throw fault('RECEIPT_AUDIT_INVALID');
  const directory = `${root}/evidence/run-${runId}`;
  const key = readPrivate(`${root}/private/evidence.key`, false);
  const detailBody = decrypt(evidenceFile(directory, proof.detailFile), key);
  const body = decrypt(evidenceFile(directory, proof.file), key);
  if (
    hash(detailBody) !== proof.detailSha256 ||
    hash(body) !== proof.sha256 ||
    detailResult.source?.sha256 !== proof.detailSha256 ||
    detailResult.source?.runId !== runId ||
    detailResult.source?.cached ||
    detailResult.systemOrderId !== sample.id
  )
    throw fault('RECEIPT_BODY_HASH_INVALID');
  const detail = parseOfficialOrderDetail(detailBody.toString('utf8'), sample.orderNumber);
  const url = extractOfficialReceiptUrl(
    detailBody.toString('utf8'),
    sample.orderNumber,
    detailResult.source.host
  );
  const events = readPrivate(`${directory}/events.jsonl`, false)
    .toString('utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const permits = events.filter(event => event.message === 'permit');
  const receiptPermits = events.filter(event => event.message === 'receipt_permit');
  const bodies = events.filter(
    event =>
      event.message === 'body' &&
      event.urlHash === proof.urlHash &&
      event.sha256 === proof.sha256 &&
      event.status === 200 &&
      !event.cached
  );
  if (
    proof.urlHash !== hash(url.href) ||
    proof.permits?.length !== 1 ||
    receiptPermits.length !== 1 ||
    bodies.length !== 1 ||
    receiptPermits[0].index !== proof.permits[0].index ||
    receiptPermits[0].runId !== runId ||
    receiptPermits[0].urlHash !== proof.urlHash ||
    !permits.some(
      permit => permit.index === receiptPermits[0].index && permit.urlHash === proof.urlHash
    ) ||
    !Number.isInteger(receiptPermits[0].index) ||
    receiptPermits[0].index < 1 ||
    receiptPermits[0].index > gate.requests ||
    events.some(event => event.message === 'receipt_unknown_target_blocked')
  )
    throw fault('RECEIPT_REQUEST_COVERAGE_INVALID');
  const parsed = parseOfficialReceipt(
    body.toString('utf8'),
    sample.orderNumber,
    receiptQuantity(detail)
  );
  const payload = {
    version: 1,
    requestKey: intent.requestKey,
    batchId: intent.batchId,
    actorUserId: input.actorUserId,
    orderId: sample.id,
    orderNumber: sample.orderNumber,
    orderBeforeHash: sample.beforeRowHash,
    devicesBeforeHash: input.devicesBeforeHash,
    receipt: {
      runId,
      sha256: proof.sha256,
      detailSha256: proof.detailSha256,
      observedAt: proof.observedAt,
      egressVerified: true,
      requestCoverageVerified: true,
    },
    items: parsed.items,
  };
  validateReceiptBinding(payload);
  return payload;
}

module.exports = { receiptQuantity, verifyReceiptEvidence };
