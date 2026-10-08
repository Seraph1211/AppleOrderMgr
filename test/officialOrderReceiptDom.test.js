/* eslint-disable no-magic-numbers -- 本地时间、DOM和网络事件替身，不访问官网。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const OfficialOrderCollector = require('../src/services/officialOrderCollector');
const { readReceiptLinks } = require('../src/services/officialOrderReceiptDom');
const { hash, decrypt, proxyLeaseWindowMs } = require('../src/services/officialOrderSupport');

const ORDER = 'W1234567890';
const DETAIL = `https://secure6.www.apple.com.cn/shop/order/detail/Abc/${ORDER}`;
const INVOICE = 'https://secure6.www.apple.com.cn/shop/order/print/invoice/123/private-token';
const NOW = new Date('2026-10-08T00:00:00Z').getTime();
let root;
let collector;
let frame;
let body;

function snapshot(ready = true) {
  return {
    ready,
    readyState: 'complete',
    matchingCount: ready ? 1 : 0,
    visibleCount: ready ? 1 : 0,
    truncatedCount: 0,
    links: ready ? [{ href: INVOICE, target: '_blank', rel: 'noopener' }] : [],
  };
}

function handle(value = snapshot()) {
  return { jsonValue: jest.fn().mockResolvedValue(value), dispose: jest.fn().mockResolvedValue() };
}

function freeze() {
  collector.freezeDetailCandidate(
    { orderNumber: ORDER, marker: 'first' },
    {
      host: 'secure6.www.apple.com.cn',
      sha256: hash(body),
      urlHash: hash(DETAIL),
      frameId: 'main',
      loaderId: 'loader',
      sessionId: 's1',
    },
    Buffer.from(body)
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-dom-'));
  fs.mkdirSync(path.join(root, 'private'));
  fs.mkdirSync(path.join(root, 'evidence/run-11'), { recursive: true });
  frame = { waitForFunction: jest.fn().mockResolvedValue(handle()) };
  body = JSON.stringify({
    orderDetail: {
      orderHeader: { d: { orderNumber: ORDER, invoiceUrl: INVOICE } },
      orderItems: {
        c: ['orderItem-11'],
        'orderItem-11': {
          orderItemDetails: { d: { productName: '测试商品', quantity: 2 } },
          orderItemStatusTracker: { d: { currentStatus: 'PICKED_UP' } },
        },
      },
    },
  });
  collector = Object.assign(Object.create(OfficialOrderCollector.prototype), {
    root,
    directory: path.join(root, 'evidence/run-11'),
    key: crypto.randomBytes(32),
    logger: { info: jest.fn() },
    id: 11,
    started: NOW,
    sample: { id: 21, orderNumber: ORDER },
    captureReceipt: true,
    stopped: null,
    detailCandidate: null,
    detailCandidateState: null,
    ignoredDetailCandidates: 0,
    sessions: new Set(['s1']),
    documentLoaders: new Map([['main', 'loader']]),
    requests: new Map(),
    inFlightHosts: new Map(),
    pending: new Set(),
    bodyCount: 0,
    leaseContext: { provider: 'iproyal', startedAt: new Date(NOW).toISOString() },
    gate: {
      id: 11,
      requests: 5,
      runRequestLimit: 300,
      finishOrder: jest.fn(),
      startOrder: jest.fn(),
    },
    page: { url: jest.fn(() => DETAIL), mainFrame: jest.fn(() => frame), goto: jest.fn() },
    pageControl: {
      send: jest.fn().mockResolvedValue({
        frameTree: { frame: { id: 'main', loaderId: 'loader', url: DETAIL } },
      }),
    },
    cdp: {
      send: jest.fn().mockImplementation(() => Promise.resolve({ body, base64Encoded: false })),
    },
  });
});

afterEach(() => {
  jest.useRealTimers();
  delete global.document;
  fs.rmSync(root, { recursive: true, force: true });
});

function readObservation() {
  const filename = fs
    .readdirSync(collector.directory)
    .find(name => name.startsWith('receipt-dom-'));
  return filename
    ? JSON.parse(decrypt(fs.readFileSync(path.join(collector.directory, filename)), collector.key))
    : null;
}

test('已渲染的精确收据链接立即结束条件等待，只保存AES属性', async () => {
  freeze();
  await collector.observeDetailCandidate();
  expect(Date.now()).toBe(NOW);
  expect(frame.waitForFunction).toHaveBeenCalledTimes(1);
  expect(frame.waitForFunction.mock.calls[0][2]).toEqual({ timeout: 250, polling: 50 });
  expect(collector.stopped).toBe('SUCCEEDED');
  expect(collector.detailCandidateState).toBe('promoted');
  expect(readObservation()).toMatchObject({
    outcome: 'LINK_OBSERVED',
    snapshot: { matchingCount: 1 },
  });
  expect(JSON.stringify(collector.logger.info.mock.calls)).not.toContain(INVOICE);
  expect(JSON.stringify(collector.logger.info.mock.calls)).not.toContain('noopener');
  expect(collector.page.goto).not.toHaveBeenCalled();
  expect(collector.gate.startOrder).not.toHaveBeenCalled();
});

test('缺链接只观察最多六秒，保留正确详情并单独记超时', async () => {
  frame.waitForFunction.mockImplementation((_fn, _args, options) => {
    jest.setSystemTime(Date.now() + options.timeout);
    return Promise.resolve(handle(snapshot(false)));
  });
  freeze();
  await collector.observeDetailCandidate();
  expect(Date.now() - NOW).toBe(6000);
  expect(collector.stopped).toBe('SUCCEEDED');
  expect(readObservation()).toMatchObject({
    outcome: 'DOM_TIMEOUT',
    snapshot: { matchingCount: 0 },
  });
  expect(frame.waitForFunction.mock.calls.every(call => call[2].timeout <= 250)).toBe(true);
});

test('候选超过六秒仍允许有界来源核验，10ms正确frame树保留详情并记录DOM超时', async () => {
  freeze();
  jest.setSystemTime(NOW + 6100);
  collector.pageControl.send.mockImplementation(
    () =>
      new Promise(resolve => {
        setTimeout(
          () => resolve({ frameTree: { frame: { id: 'main', loaderId: 'loader', url: DETAIL } } }),
          10
        );
      })
  );
  const observation = collector.observeDetailCandidate();
  await jest.advanceTimersByTimeAsync(10);
  await observation;
  expect(collector.stopped).toBe('SUCCEEDED');
  expect(readObservation()).toMatchObject({ outcome: 'DOM_TIMEOUT', snapshot: null });
  expect(frame.waitForFunction).not.toHaveBeenCalled();
});

test.each([false, true])(
  '六秒临界匹配状态%s的读取及清理各延迟10ms不会误判业务失败',
  async ready => {
    freeze();
    jest.setSystemTime(NOW + 5999);
    const value = {
      jsonValue: jest.fn(
        () => new Promise(resolve => setTimeout(() => resolve(snapshot(ready)), 10))
      ),
      dispose: jest.fn(() => new Promise(resolve => setTimeout(resolve, 10))),
    };
    frame.waitForFunction.mockResolvedValue(value);
    const observation = collector.observeDetailCandidate();
    await jest.advanceTimersByTimeAsync(20);
    await observation;
    expect(Date.now()).toBe(NOW + 6019);
    expect(collector.stopped).toBe('SUCCEEDED');
    expect(readObservation()).toMatchObject({
      outcome: ready ? 'LINK_OBSERVED' : 'DOM_TIMEOUT',
      snapshot: { matchingCount: ready ? 1 : 0 },
    });
    expect(value.dispose).toHaveBeenCalledTimes(1);
    expect(frame.waitForFunction).toHaveBeenCalledTimes(1);
  }
);

test.each(['source', 'snapshot', 'dispose'])(
  '六秒到期后的%s真实读取超时不能被吞成DOM_TIMEOUT',
  async stage => {
    freeze();
    jest.setSystemTime(NOW + (stage === 'source' ? 6100 : 5999));
    const never = () => new Promise(() => {});
    if (stage === 'source') collector.pageControl.send.mockImplementation(never);
    else {
      const value = handle(snapshot(false));
      value[stage === 'snapshot' ? 'jsonValue' : 'dispose'].mockImplementation(never);
      frame.waitForFunction.mockResolvedValue(value);
    }
    const observation = collector.observeDetailCandidate();
    await jest.advanceTimersByTimeAsync(250);
    await observation;
    expect(collector.stopped).toBe('RECEIPT_DOM_READ_TIMEOUT');
    expect(collector.result).toBeUndefined();
    expect(readObservation()).toBeNull();
  }
);

test.each(
  ['source', 'snapshot', 'dispose'].flatMap(stage =>
    ['REQUEST_STOPPED', 'TIME_BUDGET', 'PROXY_LEASE_EXPIRED'].map(code => [stage, code])
  )
)('六秒临界%s期间%s仍优先', async (stage, code) => {
  freeze();
  jest.setSystemTime(NOW + (stage === 'source' ? 6100 : 5999));
  if (code === 'TIME_BUDGET') collector.started = Date.now() - 170000 + 5;
  if (code === 'PROXY_LEASE_EXPIRED')
    collector.leaseContext.startedAt = new Date(
      Date.now() - proxyLeaseWindowMs(collector.leaseContext, true) + 5
    ).toISOString();
  const delayed = value => () =>
    new Promise(resolve => {
      setTimeout(() => {
        if (code === 'REQUEST_STOPPED') fs.writeFileSync(path.join(root, 'private/STOP'), 'stop');
        resolve(value);
      }, 10);
    });
  if (stage === 'source')
    collector.pageControl.send.mockImplementation(
      delayed({ frameTree: { frame: { id: 'main', loaderId: 'loader', url: DETAIL } } })
    );
  else {
    const value = handle(snapshot(false));
    value[stage === 'snapshot' ? 'jsonValue' : 'dispose'].mockImplementation(
      delayed(snapshot(false))
    );
    frame.waitForFunction.mockResolvedValue(value);
  }
  const observation = collector.observeDetailCandidate();
  await jest.advanceTimersByTimeAsync(10);
  await observation;
  expect(collector.stopped).toBe(code);
  expect(collector.result).toBeUndefined();
  expect(readObservation()).toBeNull();
});

test('DOM候选过期也必须实际验证主frame来源', async () => {
  freeze();
  jest.setSystemTime(NOW + 6100);
  collector.pageControl.send.mockImplementation(
    () =>
      new Promise(resolve => {
        setTimeout(
          () => resolve({ frameTree: { frame: { id: 'other', loaderId: 'loader', url: DETAIL } } }),
          10
        );
      })
  );
  const observation = collector.observeDetailCandidate();
  await jest.advanceTimersByTimeAsync(10);
  await observation;
  expect(collector.stopped).toBe('RECEIPT_DETAIL_SOURCE_MISMATCH');
  expect(collector.result).toBeUndefined();
  expect(readObservation()).toBeNull();
});

test('没有模型invoiceUrl时不猜路径、不等待或新增请求', async () => {
  const model = JSON.parse(body);
  delete model.orderDetail.orderHeader.d.invoiceUrl;
  body = JSON.stringify(model);
  freeze();
  await collector.observeDetailCandidate();
  expect(collector.stopped).toBe('SUCCEEDED');
  expect(readObservation()).toMatchObject({
    outcome: 'LINK_UNAVAILABLE',
    linkOutcome: 'RECEIPT_LINK_MISSING',
  });
  expect(frame.waitForFunction).not.toHaveBeenCalled();
  expect(collector.pageControl.send).toHaveBeenCalledWith('Page.getFrameTree');
  expect(collector.page.goto).not.toHaveBeenCalled();
  expect(collector.gate.startOrder).not.toHaveBeenCalled();
});

test('模型没有收据链接也不能忽略详情来源漂移', async () => {
  const model = JSON.parse(body);
  delete model.orderDetail.orderHeader.d.invoiceUrl;
  body = JSON.stringify(model);
  freeze();
  collector.page.url.mockReturnValue(DETAIL + '?changed');
  await collector.observeDetailCandidate();
  expect(collector.stopped).toBe('RECEIPT_DETAIL_SOURCE_MISMATCH');
  expect(collector.result).toBeUndefined();
  expect(readObservation()).toBeNull();
});

test.each(['TIME_BUDGET', 'PROXY_LEASE_EXPIRED'])('短于六秒的%s优先，不能提升详情', async code => {
  if (code === 'TIME_BUDGET') collector.started = NOW - 170000 + 300;
  else
    collector.leaseContext.startedAt = new Date(
      NOW - proxyLeaseWindowMs(collector.leaseContext, true) + 300
    ).toISOString();
  frame.waitForFunction.mockImplementation((_fn, _args, options) => {
    jest.setSystemTime(Date.now() + options.timeout);
    return Promise.resolve(handle(snapshot(false)));
  });
  freeze();
  await collector.observeDetailCandidate();
  expect(Date.now() - NOW).toBe(300);
  expect(collector.stopped).toBe(code);
  expect(collector.result).toBeUndefined();
  expect(readObservation()).toBeNull();
});

test.each(['REQUEST_STOPPED', 'HTTP_541', 'HTTP_429', 'HTTP_500', 'REQUEST_BUDGET'])(
  '等待返回可用DOM时%s仍优先于成功',
  async code => {
    const value = handle();
    frame.waitForFunction.mockImplementation(() => {
      if (code === 'REQUEST_STOPPED') fs.writeFileSync(path.join(root, 'private/STOP'), 'stop');
      else if (code === 'REQUEST_BUDGET') collector.gate.requests = collector.gate.runRequestLimit;
      else collector.stopped = code;
      return Promise.resolve(value);
    });
    freeze();
    await collector.observeDetailCandidate();
    expect(collector.stopped).toBe(code);
    expect(collector.result).toBeUndefined();
    expect(collector.detailCandidateState).toBe('failed');
    expect(value.dispose).toHaveBeenCalledTimes(1);
    expect(readObservation()).toBeNull();
  }
);

test.each(['run', 'gate', 'order', 'frame', 'page', 'url', 'loader', 'session'])(
  '候选%s身份改变禁止提升',
  async kind => {
    frame.waitForFunction.mockImplementation(() => {
      if (kind === 'run') collector.id = 12;
      if (kind === 'gate') collector.gate.id = 12;
      if (kind === 'order') collector.sample = { id: 22, orderNumber: 'W9999999999' };
      if (kind === 'frame') collector.page.mainFrame.mockReturnValue({});
      if (kind === 'page') collector.page = { ...collector.page };
      if (kind === 'url') collector.page.url.mockReturnValue(DETAIL + '?changed');
      if (kind === 'loader') collector.documentLoaders.set('main', 'new-loader');
      if (kind === 'session') collector.sessions.clear();
      return Promise.resolve(handle());
    });
    freeze();
    await collector.observeDetailCandidate();
    expect(collector.stopped).toMatch(
      /^(DETAIL_CANDIDATE_CHANGED|RECEIPT_DETAIL_SOURCE_MISMATCH)$/
    );
    expect(collector.result).toBeUndefined();
  }
);

test.each(['id', 'loaderId', 'url'])('只允许当前主frame树%s精确匹配', async field => {
  const actual = { id: 'main', loaderId: 'loader', url: DETAIL, [field]: 'changed' };
  collector.pageControl.send.mockResolvedValue({ frameTree: { frame: actual } });
  freeze();
  await collector.observeDetailCandidate();
  expect(collector.stopped).toBe('RECEIPT_DETAIL_SOURCE_MISMATCH');
  expect(frame.waitForFunction).not.toHaveBeenCalled();
});

test('AES写失败不能变成成功；观察完成后STOP同样不能成功', async () => {
  freeze();
  collector.seal = jest.fn(() => {
    throw new Error('synthetic write failure');
  });
  await collector.observeDetailCandidate();
  expect(collector.stopped).toBe('STATE_WRITE_FAILED');
  expect(collector.result).toBeUndefined();
});

test('观察句柄读取后的STOP在最终提升前仍被识别', async () => {
  frame.waitForFunction.mockResolvedValue({
    jsonValue: jest.fn().mockResolvedValue(snapshot()),
    dispose: jest.fn(() => {
      collector.stopped = 'HTTP_541';
      return Promise.resolve();
    }),
  });
  freeze();
  await collector.observeDetailCandidate();
  expect(collector.stopped).toBe('HTTP_541');
  expect(collector.result).toBeUndefined();
});

async function emitDetail(requestId = 'r1', options = {}) {
  await collector.event({
    method: 'Network.responseReceived',
    sessionId: 's1',
    params: {
      requestId,
      type: 'Document',
      frameId: 'main',
      loaderId: 'loader',
      response: { url: DETAIL, status: 200, headers: {} },
      ...options,
    },
  });
  await collector.event({
    method: 'Network.loadingFinished',
    sessionId: 's1',
    params: { requestId, encodedDataLength: body.length },
  });
}

test('首个有效详情只冻结候选，重复及迟到正文不能覆盖或重复观察', async () => {
  await emitDetail();
  const candidate = collector.detailCandidate;
  expect(candidate).toBeTruthy();
  expect(Object.isFrozen(candidate)).toBe(true);
  expect(collector.stopped).toBeNull();
  expect(collector.result).toBeUndefined();
  body = body.replace('测试商品', '改变商品');
  await emitDetail('r2');
  expect(collector.detailCandidate).toBe(candidate);
  expect(collector.ignoredDetailCandidates).toBe(1);
  await collector.observeDetailCandidate();
  await emitDetail('r3');
  await collector.observeDetailCandidate();
  expect(frame.waitForFunction).toHaveBeenCalledTimes(1);
  expect(collector.resultEvidence.sha256).toBe(candidate.source.sha256);
});

test('captureReceipt=false保留立即成功的原行为', async () => {
  collector.captureReceipt = false;
  await emitDetail();
  expect(collector.stopped).toBe('SUCCEEDED');
  expect(collector.detailCandidate).toBeNull();
  expect(frame.waitForFunction).not.toHaveBeenCalled();
});

test('停止后的迟到详情不会创建候选', async () => {
  collector.stopped = 'HTTP_541';
  await emitDetail();
  expect(collector.detailCandidate).toBeNull();
  expect(collector.stopped).toBe('HTTP_541');
});

test('旧run已收到响应头但迟到的正文不创建新run候选', async () => {
  await collector.event({
    method: 'Network.responseReceived',
    sessionId: 's1',
    params: {
      requestId: 'old-run',
      type: 'Document',
      frameId: 'main',
      loaderId: 'loader',
      response: { url: DETAIL, status: 200, headers: {} },
    },
  });
  collector.id = 12;
  collector.gate.id = 12;
  await collector.event({
    method: 'Network.loadingFinished',
    sessionId: 's1',
    params: { requestId: 'old-run', encodedDataLength: body.length },
  });
  expect(collector.detailCandidate).toBeNull();
  expect(collector.result).toBeUndefined();
  expect(collector.stopped).toBeNull();
});

test('等待期间重复调用观察入口不创建第二次DOM观察', async () => {
  let completeWait;
  frame.waitForFunction.mockImplementation(
    () =>
      new Promise(resolve => {
        completeWait = resolve;
      })
  );
  freeze();
  const first = collector.observeDetailCandidate();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await collector.observeDetailCandidate();
  expect(collector.detailCandidateState).toBe('observing');
  expect(frame.waitForFunction).toHaveBeenCalledTimes(1);
  completeWait(handle());
  await first;
  expect(collector.stopped).toBe('SUCCEEDED');
});

test('主循环先处理候选，不能与loginStep或额外导航竞争', async () => {
  freeze();
  collector.page.goto.mockResolvedValue();
  collector.waitForSiteReady = jest.fn();
  collector.loginStep = jest.fn();
  collector.targetDetailUrl = 'https://secure6.www.apple.com.cn/other';
  await collector.collectCurrent();
  expect(collector.page.goto).toHaveBeenCalledTimes(1);
  expect(collector.waitForSiteReady).not.toHaveBeenCalled();
  expect(collector.loginStep).not.toHaveBeenCalled();
  expect(collector.stopped).toBe('SUCCEEDED');
});

test('主循环就绪检查期间出现候选后不再登录', async () => {
  collector.page.goto.mockResolvedValue();
  collector.waitForSiteReady = jest.fn(() => {
    freeze();
    return Promise.resolve(true);
  });
  collector.loginStep = jest.fn();
  await collector.collectCurrent();
  expect(collector.loginStep).not.toHaveBeenCalled();
  expect(collector.stopped).toBe('SUCCEEDED');
});

test('切换下一订单时清除候选、观察状态及重复计数', async () => {
  collector.accountMode = true;
  collector.captureReceipt = false;
  collector.accountResults = [];
  collector.samples = [collector.sample, { id: 22, orderNumber: 'W9999999999' }];
  collector.gate.recordFailure = jest.fn().mockResolvedValue();
  collector.gate.finishOrder.mockResolvedValue();
  collector.gate.startOrder.mockImplementation(() => {
    collector.gate.id = 12;
    return Promise.resolve(12);
  });
  collector.saveOrderResult = jest.fn(() => 'synthetic-result');
  collector.collectCurrent = jest.fn(() => {
    if (collector.sample.id === 21) {
      collector.detailCandidate = { old: true };
      collector.detailCandidateState = 'promoted';
      collector.ignoredDetailCandidates = 2;
    } else {
      expect(collector.detailCandidate).toBeNull();
      expect(collector.detailCandidateState).toBeNull();
      expect(collector.ignoredDetailCandidates).toBe(0);
    }
    collector.stopped = 'SUCCEEDED';
    collector.result = {};
    return Promise.resolve();
  });
  await collector.collectAccount();
  expect(collector.collectCurrent).toHaveBeenCalledTimes(2);
});

test('DOM函数只匹配明确invoiceUrl，属性、数量有界，不执行任何链接', () => {
  const click = jest.fn();
  const node = (href, attributes = {}) => ({
    href,
    click,
    getClientRects: () => [{}],
    getAttribute: name => attributes[name] ?? null,
    hasAttribute: name => Object.prototype.hasOwnProperty.call(attributes, name),
  });
  global.document = {
    readyState: 'complete',
    querySelectorAll: jest.fn(() => [
      node(INVOICE + '?edit=1', { href: INVOICE + '?edit=1' }),
      node(INVOICE, {
        href: INVOICE,
        target: '_blank',
        rel: 'x'.repeat(2100),
        onclick: 'neverRun()',
      }),
      node(INVOICE, { href: INVOICE }),
      node(INVOICE, { href: INVOICE }),
    ]),
  };
  const value = readReceiptLinks({
    invoiceUrl: INVOICE,
    fallbackAt: NOW + 250,
    maxAnchors: 3,
    maxMatches: 1,
    maxText: 2048,
  });
  expect(value).toMatchObject({
    ready: true,
    matchingCount: 2,
    visibleCount: 2,
    truncatedCount: 1,
    omittedMatchCount: 1,
    unscannedCount: 1,
  });
  expect(value.links).toHaveLength(1);
  expect(value.links[0]).toMatchObject({ href: INVOICE, target: '_blank', hasOnclick: true });
  expect(value.links[0].rel).toHaveLength(2048);
  expect(click).not.toHaveBeenCalled();
});

test('未complete或没有明确链接时等待DOM条件，到切片边界才返回诊断', () => {
  global.document = { readyState: 'interactive', querySelectorAll: () => [] };
  const input = {
    invoiceUrl: INVOICE,
    fallbackAt: NOW + 200,
    maxAnchors: 4096,
    maxMatches: 8,
    maxText: 2048,
  };
  expect(readReceiptLinks(input)).toBe(false);
  jest.setSystemTime(NOW + 200);
  expect(readReceiptLinks(input)).toMatchObject({
    ready: false,
    matchingCount: 0,
    readyState: 'interactive',
  });
});
