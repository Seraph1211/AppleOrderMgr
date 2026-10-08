/* global document */
const { fault, hash, detailUrl, proxyLeaseWindowMs } = require('./officialOrderSupport');

const DOM_WINDOW_MS = 6000;
const SLICE_MS = 250;
const READ_LIMIT_MS = 250;
const POLL_MS = 50;
const MAX_ANCHORS = 4096;
const MAX_MATCHES = 8;
const MAX_ATTRIBUTE_LENGTH = 2048;

/** 每个异步边界重新核验冻结候选，任何停止原因都不能被观察结果解除。 */
function assertReceiptCandidate(collector, candidate, observationMs) {
  if (collector.isStopRequested()) throw fault('REQUEST_STOPPED');
  if (collector.stopped) throw fault(collector.stopped);
  const now = Date.now();
  if (!Number.isFinite(collector.started) || now >= collector.started + observationMs)
    throw fault('TIME_BUDGET');
  const leaseStart = Date.parse(collector.leaseContext?.startedAt);
  if (
    !Number.isFinite(leaseStart) ||
    leaseStart > now ||
    now >= leaseStart + proxyLeaseWindowMs(collector.leaseContext, true)
  )
    throw fault('PROXY_LEASE_EXPIRED');
  if (collector.gate.requests >= collector.gate.runRequestLimit) throw fault('REQUEST_BUDGET');
  if (
    collector.detailCandidate !== candidate ||
    Number(collector.id) !== candidate.runId ||
    Number(collector.gate.id) !== candidate.runId ||
    collector.sample.id !== candidate.orderId ||
    collector.sample.orderNumber !== candidate.orderNumber ||
    collector.page !== candidate.page ||
    collector.page.mainFrame() !== candidate.frame
  )
    throw fault('DETAIL_CANDIDATE_CHANGED');
  const currentUrl = collector.page.url();
  try {
    detailUrl(currentUrl, candidate.source.host, candidate.orderNumber);
  } catch (_error) {
    throw fault('RECEIPT_DETAIL_SOURCE_MISMATCH');
  }
  if (
    hash(currentUrl) !== candidate.source.urlHash ||
    !candidate.source.frameId ||
    !candidate.source.loaderId ||
    !collector.sessions.has(candidate.source.sessionId) ||
    collector.documentLoaders.get(candidate.source.frameId) !== candidate.source.loaderId
  )
    throw fault('RECEIPT_DETAIL_SOURCE_MISMATCH');
}

/** 函数在浏览器中只读执行，不访问页面文本或执行链接处理器。 */
function readReceiptLinks({ invoiceUrl, fallbackAt, maxAnchors, maxMatches, maxText }) {
  const nodes = document.querySelectorAll('a[href]');
  const links = [];
  let matchingCount = 0;
  let visibleCount = 0;
  let truncatedCount = 0;
  const text = value => {
    if (value === null) return null;
    if (value.length > maxText) truncatedCount += 1;
    return value.slice(0, maxText);
  };
  const scannedCount = Math.min(nodes.length, maxAnchors);
  for (let index = 0; index < scannedCount; index += 1) {
    const node = nodes[index];
    if (node.href !== invoiceUrl) continue;
    matchingCount += 1;
    const visible = node.getClientRects().length > 0;
    if (visible) visibleCount += 1;
    if (links.length < maxMatches)
      links.push({
        href: text(node.href),
        rawHref: text(node.getAttribute('href')),
        target: text(node.getAttribute('target')),
        rel: text(node.getAttribute('rel')),
        referrerPolicy: text(node.getAttribute('referrerpolicy')),
        hasOnclick: node.hasAttribute('onclick'),
        hasDownload: node.hasAttribute('download'),
        visible,
      });
  }
  const ready = document.readyState === 'complete' && matchingCount > 0;
  if (!ready && Date.now() < fallbackAt) return false;
  return {
    ready,
    readyState: document.readyState,
    scannedCount,
    matchingCount,
    visibleCount,
    truncatedCount,
    omittedMatchCount: matchingCount - links.length,
    unscannedCount: Math.max(0, nodes.length - scannedCount),
    links,
  };
}

async function boundedRead(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fault('RECEIPT_DOM_READ_TIMEOUT')), milliseconds);
      }),
    ]);
  } catch (error) {
    error.component = 'officialOrderReceiptDom';
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 有界观察当前详情的精确收据链接；不点击、不导航、不创建网络许可或研究运行。
 * @returns {Promise<object>} 只能写入 AES 证据的有界 DOM 观察。
 */
async function observeReceiptDom(collector, candidate, observationMs) {
  try {
    assertReceiptCandidate(collector, candidate, observationMs);
    const evidence = {
      runId: candidate.runId,
      orderId: candidate.orderId,
      detailSha256: candidate.source.sha256,
      detailUrlHash: candidate.source.urlHash,
      startedAt: new Date().toISOString(),
    };
    const totalDeadline = collector.started + observationMs;
    const leaseDeadline =
      Date.parse(collector.leaseContext.startedAt) +
      proxyLeaseWindowMs(collector.leaseContext, true);
    const hardDeadline = Math.min(totalDeadline, leaseDeadline);
    const deadline = Math.min(
      candidate.createdAt + (collector.receiptDomWindowMs || DOM_WINDOW_MS),
      hardDeadline
    );
    const remaining = () => Math.max(1, Math.min(SLICE_MS, deadline - Date.now()));
    // 六秒仅限制 DOM 条件观察；来源核验、快照读取和清理独立有界，仍不能越过硬时限。
    const readRemaining = () => Math.max(1, Math.min(READ_LIMIT_MS, hardDeadline - Date.now()));
    const tree = await boundedRead(
      () => collector.pageControl.send('Page.getFrameTree'),
      readRemaining()
    );
    assertReceiptCandidate(collector, candidate, observationMs);
    if (
      tree?.frameTree?.frame?.id !== candidate.source.frameId ||
      tree.frameTree.frame.loaderId !== candidate.source.loaderId ||
      hash(tree.frameTree.frame.url) !== candidate.source.urlHash
    )
      throw fault('RECEIPT_DETAIL_SOURCE_MISMATCH');
    if (!candidate.invoiceUrl)
      return { ...evidence, outcome: 'LINK_UNAVAILABLE', linkOutcome: candidate.linkOutcome };
    let snapshot = null;
    while (Date.now() < deadline) {
      assertReceiptCandidate(collector, candidate, observationMs);
      const slice = remaining();
      let handle;
      try {
        handle = await candidate.frame.waitForFunction(
          readReceiptLinks,
          {
            invoiceUrl: candidate.invoiceUrl,
            fallbackAt: Date.now() + Math.max(0, slice - POLL_MS),
            maxAnchors: MAX_ANCHORS,
            maxMatches: MAX_MATCHES,
            maxText: MAX_ATTRIBUTE_LENGTH,
          },
          { timeout: slice, polling: Math.min(POLL_MS, slice) }
        );
        assertReceiptCandidate(collector, candidate, observationMs);
        snapshot = await boundedRead(() => handle.jsonValue(), readRemaining());
        assertReceiptCandidate(collector, candidate, observationMs);
      } catch (error) {
        assertReceiptCandidate(collector, candidate, observationMs);
        if (error.name !== 'TimeoutError') throw error;
      } finally {
        if (handle) await boundedRead(() => handle.dispose(), readRemaining());
      }
      assertReceiptCandidate(collector, candidate, observationMs);
      if (snapshot?.ready) break;
    }
    assertReceiptCandidate(collector, candidate, observationMs);
    return {
      ...evidence,
      finishedAt: new Date().toISOString(),
      outcome: snapshot?.ready ? 'LINK_OBSERVED' : 'DOM_TIMEOUT',
      detailUrl: collector.page.url(),
      invoiceUrl: candidate.invoiceUrl,
      frameId: candidate.source.frameId,
      loaderId: candidate.source.loaderId,
      snapshot,
    };
  } catch (error) {
    assertReceiptCandidate(collector, candidate, observationMs);
    error.component = 'officialOrderReceiptDom';
    throw error;
  }
}

module.exports = { assertReceiptCandidate, observeReceiptDom, readReceiptLinks };
