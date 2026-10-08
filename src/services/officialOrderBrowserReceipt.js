const fs = require('fs');
const { extractOfficialReceiptUrl } = require('./officialOrderReceipt');
const {
  decrypt,
  hash,
  encrypt,
  writePrivate,
  fault,
  proxyLeaseWindowMs,
  detailUrl,
} = require('./officialOrderSupport');

const RECEIPT_TIMEOUT_MS = 20000;

function verifiedReceiptReferer(collector, source) {
  try {
    const currentUrl = collector.page.url();
    if (typeof currentUrl !== 'string' || hash(currentUrl) !== source.urlHash)
      throw fault('RECEIPT_DETAIL_SOURCE_MISMATCH');
    return detailUrl(currentUrl, source.host, collector.sample.orderNumber);
  } catch (_error) {
    throw fault('RECEIPT_DETAIL_SOURCE_MISMATCH');
  }
}

/** 在仍存活的详情浏览器中读取收据；独立计次，失败不抹去详情结果。 */
async function collectBrowserReceipt(collector) {
  const detailRun = Number(collector.id);
  const source = collector.resultEvidence;
  const receipt = { orderId: collector.sample.id, detailRun, outcome: 'RECEIPT_UNAVAILABLE' };
  try {
    const lease = collector.leaseContext;
    if (
      !lease ||
      !Number.isFinite(Date.parse(lease.startedAt)) ||
      Date.parse(lease.startedAt) > Date.now() ||
      Date.now() - Date.parse(lease.startedAt) > proxyLeaseWindowMs(lease)
    )
      throw fault('RECEIPT_LEASE_TOO_SHORT');
    const body = decrypt(fs.readFileSync(`${collector.directory}/${source.file}`), collector.key);
    if (hash(body) !== source.sha256) throw fault('DETAIL_HASH_INVALID');
    const url = extractOfficialReceiptUrl(
      body.toString(),
      collector.sample.orderNumber,
      source.host
    );
    const referer = verifiedReceiptReferer(collector, source);
    await collector.pageControl.send('Page.stopLoading');
    await Promise.allSettled([...collector.pending]);
    // 等待既有处理器期间若当前页改变，也不能把旧详情作为新导航的来源。
    if (verifiedReceiptReferer(collector, source) !== referer)
      throw fault('RECEIPT_DETAIL_SOURCE_MISMATCH');
    // 详情运行在切换研究 runId 前结束；额外读取仍占单订单每日三次额度。
    await collector.gate.finishOrder('SUCCEEDED');
    const runId = Number(await collector.gate.startOrder(collector.sample));
    receipt.runId = runId;
    collector.receiptPhase = { url: url.href, urlHash: hash(url.href), runId };
    collector.stopped = null;
    await collector.page
      .goto(url.href, { referer, waitUntil: 'load', timeout: RECEIPT_TIMEOUT_MS })
      .catch(() => {});
    await Promise.allSettled([...collector.pending]);
    const captured = collector.receiptPhase.captured;
    const failure = [collector.stopped, collector.receiptPhase.outcome].find(
      outcome => outcome && outcome !== 'RECEIPT_CAPTURED'
    );
    receipt.outcome =
      failure || collector.receiptPhase.outcome || collector.stopped || 'RECEIPT_TIMEOUT';
    if (captured && !failure) {
      const file = `receipt-probe-${runId}.enc`;
      writePrivate(`${collector.root}/evidence/${file}`, encrypt(captured.bytes, collector.key));
      const metadata = {
        systemOrderId: collector.sample.id,
        orderNumber: collector.sample.orderNumber,
        runId,
        detailRun,
        detailSha256: source.sha256,
        file,
        sha256: hash(captured.bytes),
        status: captured.status,
        contentType: captured.contentType,
        observedAt: new Date().toISOString(),
        egressHash: lease.egressHash,
        urlHash: hash(url.href),
        transport: 'same-browser',
        egressVerifiedAfter: false,
      };
      writePrivate(
        `${collector.root}/private/receipt-probe-${collector.sample.id}.json`,
        JSON.stringify(metadata)
      );
      receipt.outcome = captured.status === 200 ? 'RECEIPT_CAPTURED' : `HTTP_${captured.status}`;
    }
  } catch (error) {
    receipt.outcome = /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'RECEIPT_CAPTURE_FAILED';
  } finally {
    try {
      await collector.gate.recordFailure(receipt.outcome, collector.retryAfter);
    } catch (_error) {
      receipt.outcome = 'STATE_WRITE_FAILED';
    }
    collector.receiptPhase = null;
    collector.stopped = 'SUCCEEDED';
  }
  return receipt;
}

module.exports = { collectBrowserReceipt };
