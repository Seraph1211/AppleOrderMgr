const fs = require('fs');
const { extractOfficialReceiptUrl, parseOfficialReceipt } = require('./officialOrderReceipt');
const { decrypt, encrypt, hash, fault, writePrivate, delay } = require('./officialOrderSupport');

const { receiptQuantity } = require('./officialReceiptEvidence');

const ATTACH_TIMEOUT_MS = 12000;
const ATTACH_POLL_MS = 50;
const RECEIPT_TIMEOUT_MS = 25000;

/** 创建空白收据页；确认目标网络拦截已启用后才允许任何真实导航。 */
async function createControlledReceiptPage(collector) {
  let page;
  try {
    page = await collector.context.newPage();
    const session = await collector.context.newCDPSession(page);
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      const started = Date.now();
      while (!collector.readyTargets.has(targetInfo.targetId)) {
        if (collector.isStopRequested() || collector.stopped) throw fault('REQUEST_STOPPED');
        if (Date.now() - started >= ATTACH_TIMEOUT_MS)
          throw fault('RECEIPT_INTERCEPTION_NOT_READY');
        await delay(ATTACH_POLL_MS);
      }
      if (page.url() !== 'about:blank') throw fault('RECEIPT_PAGE_NOT_BLANK');
      collector.guardedPages?.add(page);
      collector.log('receipt_target_ready', { targetId: targetInfo.targetId });
      return page;
    } finally {
      await session.detach();
    }
  } catch (error) {
    if (page) await page.close().catch(() => {});
    error.component = 'officialReceiptCapture';
    throw error;
  }
}

/** 同一 Gate run 内取得原生浏览器收据；无许可、错误页和解析不一致均不成功。 */
async function captureOfficialReceipt(collector) {
  const runId = Number(collector.id);
  const result = { orderId: collector.sample.id, runId, detailRun: runId };
  let page;
  try {
    const source = collector.resultEvidence;
    const referer = collector.page.url();
    if (hash(referer) !== source.urlHash) throw fault('RECEIPT_DETAIL_SOURCE_MISMATCH');
    const detailBody = decrypt(
      fs.readFileSync(`${collector.directory}/${source.file}`),
      collector.key
    );
    if (hash(detailBody) !== source.sha256) throw fault('DETAIL_HASH_INVALID');
    const url = extractOfficialReceiptUrl(
      detailBody.toString(),
      collector.sample.orderNumber,
      source.host
    );
    await collector.pageControl.send('Page.stopLoading');
    await Promise.allSettled([...collector.pending]);
    if (collector.page.url() !== referer) throw fault('RECEIPT_DETAIL_SOURCE_MISMATCH');
    collector.receiptPhase = { url: url.href, urlHash: hash(url.href), runId, permits: [] };
    collector.stopped = null;
    if (collector.navigateReceipt) {
      await collector.navigateReceipt(url.href).catch(error => {
        if (error.code) throw error;
        collector.log('receipt_navigation_finished', { interrupted: true, type: error.name });
      });
    } else {
      page = await createControlledReceiptPage(collector);
      await page
        .goto(url.href, { referer, waitUntil: 'load', timeout: RECEIPT_TIMEOUT_MS })
        .catch(error => {
          collector.log('receipt_navigation_finished', { interrupted: true, type: error.name });
        });
    }
    // 点击事件可能异步启动导航；旧页的 load 状态不能证明新收据已经返回。
    const waitingSince = Date.now();
    while (
      !collector.receiptPhase.captured &&
      !collector.receiptPhase.outcome &&
      !collector.stopped
    ) {
      if (collector.isStopRequested()) throw fault('REQUEST_STOPPED');
      if (Date.now() - waitingSince >= RECEIPT_TIMEOUT_MS) throw fault('RECEIPT_TIMEOUT');
      await delay(ATTACH_POLL_MS);
    }
    await Promise.allSettled([...collector.pending]);
    const phase = collector.receiptPhase;
    const failure = [collector.stopped, phase.outcome].find(
      value => value && value !== 'RECEIPT_CAPTURED'
    );
    if (failure) throw fault(failure);
    const captured = phase.captured;
    if (!captured) throw fault('RECEIPT_TIMEOUT');
    if (phase.permits.length !== 1 || phase.permits[0].urlHash !== phase.urlHash)
      throw fault('RECEIPT_REQUEST_COVERAGE_INVALID');
    if (captured.status !== 200) throw fault(`HTTP_${captured.status}`);
    const parsed = parseOfficialReceipt(
      captured.bytes.toString('utf8'),
      collector.sample.orderNumber,
      receiptQuantity(collector.result)
    );
    const file = `receipt-${runId}.enc`;
    writePrivate(`${collector.directory}/${file}`, encrypt(captured.bytes, collector.key));
    const proof = {
      version: 1,
      systemOrderId: collector.sample.id,
      orderNumber: collector.sample.orderNumber,
      runId,
      detailSha256: source.sha256,
      detailFile: source.file,
      file,
      sha256: hash(captured.bytes),
      status: captured.status,
      contentType: captured.contentType,
      observedAt: new Date().toISOString(),
      egressHash: collector.leaseContext.egressHash,
      egressVerifiedAfter: false,
      urlHash: phase.urlHash,
      permits: phase.permits,
      transport: collector.navigateReceipt ? 'native-controlled-click' : 'native-controlled-page',
      parsed,
    };
    const proofFile = `${collector.root}/private/receipt-${runId}.json`;
    writePrivate(proofFile, JSON.stringify(proof));
    result.outcome = 'RECEIPT_VERIFIED';
    result.proofFile = proofFile;
    result.serialCount = parsed.items.length;
    result.receiptSha256 = proof.sha256;
  } catch (error) {
    result.outcome = /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'RECEIPT_FAILED';
    collector.log('receipt_failed', { code: result.outcome });
  } finally {
    if (page) await page.close().catch(() => {});
    collector.receiptPhase = null;
    collector.stopped = result.outcome === 'RECEIPT_VERIFIED' ? 'SUCCEEDED' : result.outcome;
  }
  return result;
}

module.exports = { createControlledReceiptPage, captureOfficialReceipt };
