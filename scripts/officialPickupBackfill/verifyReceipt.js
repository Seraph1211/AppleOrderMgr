const fs = require('fs');
const { createRequire } = require('module');
const appRequire = createRequire('/app/package.json');
const { decrypt, hash, readPrivate } = appRequire('./src/services/officialOrderSupport');
const { parseOfficialOrderDetail } = appRequire('./src/services/officialOrderParser');
const { parseOfficialReceipt, extractOfficialReceiptUrl } = appRequire(
  './src/services/officialOrderReceipt'
);
try {
  const id = Number(process.argv[2]);
  if (!Number.isSafeInteger(id) || id <= 0) throw Error('ID');
  const plan = readPrivate('/research/private/plan.json');
  const entry = plan.entries.find(e => e.id === id);
  const receipt = readPrivate('/research/private/receipt-probe-' + id + '.json');
  if (
    !entry ||
    receipt.systemOrderId !== id ||
    receipt.orderNumber !== entry.orderNumber ||
    receipt.status !== 200 ||
    receipt.egressVerifiedAfter !== true ||
    !/^text\/html\b/.test(receipt.contentType) ||
    !/^receipt-probe-\d+\.enc$/.test(receipt.file) ||
    !/^\d+$/.test(String(receipt.detailRun)) ||
    Date.parse(receipt.observedAt) < Date.parse(plan.startedAt) ||
    Date.now() - Date.parse(plan.startedAt) > 86400000
  )
    throw Error('RECEIPT_METADATA_INVALID');
  const result = readPrivate(
    '/research/private/results/order-' + id + '-run-' + receipt.detailRun + '.json'
  );
  const source = result.source;
  if (!/^body-[a-zA-Z0-9-]+\.enc$/.test(source.file) || source.runId !== receipt.detailRun)
    throw Error('SOURCE_INVALID');
  const key = fs.readFileSync('/research/private/evidence.key');
  const detailBody = decrypt(
    fs.readFileSync('/research/evidence/run-' + source.runId + '/' + source.file),
    key
  );
  if (hash(detailBody) !== receipt.detailSha256 || source.sha256 !== receipt.detailSha256)
    throw Error('DETAIL_HASH');
  const detail = parseOfficialOrderDetail(detailBody.toString(), entry.orderNumber);
  if (!detail?.products?.length) throw Error('DETAIL_INVALID');
  const quantity = detail.products.reduce((sum, product) => sum + product.quantity, 0);
  const url = extractOfficialReceiptUrl(detailBody.toString(), entry.orderNumber, source.host);
  if (hash(url.href) !== receipt.urlHash) throw Error('URL_HASH');
  const body = decrypt(fs.readFileSync('/research/evidence/' + receipt.file), key);
  if (hash(body) !== receipt.sha256) throw Error('RECEIPT_HASH');
  const parsed = parseOfficialReceipt(body.toString(), entry.orderNumber, quantity);
  process.stdout.write(
    JSON.stringify({
      startedAt: plan.startedAt,
      cutoff: plan.cutoff,
      scope: plan.scope,
      schemaVersion: plan.schemaVersion,
      entry,
      receipt,
      parsed,
    })
  );
} catch (error) {
  process.stderr.write(
    /^[A-Z_0-9]+$/.test(error.code || error.message)
      ? error.code || error.message
      : 'RECEIPT_VERIFY_FAILED'
  );
  process.exitCode = 1;
}
