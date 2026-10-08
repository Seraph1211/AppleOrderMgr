/* eslint-disable no-magic-numbers -- 合成浏览器证据、篡改和文件边界。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { encrypt, hash, writePrivate, safePath } = require('../src/services/officialOrderSupport');
const { parseOfficialOrderDetail } = require('../src/services/officialOrderParser');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const { verifyBrowserReceipt } = require('../scripts/officialPickupBackfill/verifyBrowserReceipt');

const ID = 11;
const RUN = 25;
const RECEIPT_RUN = 26;
const HTTP_RUN = 20;
const ORDER = 'W1234567890';
const HOST = 'secure6.www.apple.com.cn';
const URL = `https://${HOST}/shop/order/print/invoice/Invoice/Token`;
const AUDIT_FILE = `browser-sample-${ID}-${'a'.repeat(32)}.json`;
const HTTP_AUDIT = `http-sample-${ID}-${'b'.repeat(32)}.json`;
const BASIS_FILE = `http-apply-basis-${ID}-run-${HTTP_RUN}.json`;
let root;
let key;
let now;
let plan;
let audit;
let source;
let result;
let receipt;
let events;

function save(relative, value) {
  writePrivate(
    path.join(root, relative),
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
  );
}

function read(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function invoice(orderNumber = ORDER, serials = ['A123456789', 'B123456789']) {
  return JSON.stringify({
    orderInvoices: {
      c: ['orderInvoice-1'],
      'orderInvoice-1': {
        invoiceOrderSummary: { d: { orderNumber } },
        invoiceLineItems: {
          c: ['invoiceLineItem-1'],
          'invoiceLineItem-1': {
            d: {
              hasLineItemSerialInfo: true,
              lineItemSerialInfo: serials,
              quantityOrdered: String(serials.length),
              quantityShipped: String(serials.length),
              partNumber: 'TESTCH/A',
              productName: '测试手机',
            },
          },
        },
      },
    },
  });
}

function saveAudit() {
  save(`private/${AUDIT_FILE}`, audit);
  receipt.browserAuditSha256 = hash(fs.readFileSync(path.join(root, `private/${AUDIT_FILE}`)));
  save(`private/receipt-probe-${ID}.json`, receipt);
}

function saveEvents() {
  save(
    `evidence/run-${RUN}/events.jsonl`,
    events.map(event => JSON.stringify(event)).join('\n') + '\n'
  );
}

function replaceReceipt(body) {
  receipt.sha256 = hash(body);
  save(`evidence/${receipt.file}`, encrypt(Buffer.from(body), key));
  const event = events.find(value => value.phase === 'receipt');
  event.file = `body-2-${receipt.sha256.slice(0, 16)}.enc`;
  event.sha256 = receipt.sha256;
  event.bytes = Buffer.byteLength(body);
  save(`evidence/run-${RUN}/${event.file}`, encrypt(Buffer.from(body), key));
  saveEvents();
  save(`private/receipt-probe-${ID}.json`, receipt);
}

function verify(options = {}) {
  return verifyBrowserReceipt({ root, orderId: ID, auditFile: AUDIT_FILE, now, ...options });
}

function snapshot(directory = root) {
  const output = {};
  for (const name of fs.readdirSync(directory)) {
    const filename = path.join(directory, name);
    if (fs.lstatSync(filename).isDirectory()) Object.assign(output, snapshot(filename));
    else output[path.relative(root, filename)] = hash(fs.readFileSync(filename));
  }
  return output;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-receipt-verification-'));
  key = Buffer.alloc(32, 7);
  now = Date.now();
  plan = {
    schemaVersion: 3,
    scope: 'missing-fields',
    cutoff: null,
    startedAt: new Date(now - 60000).toISOString(),
    policy: { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 },
    entries: [
      {
        id: ID,
        orderNumber: ORDER,
        rowHash: 'c'.repeat(32),
        accountKey: 'd'.repeat(32),
        dateMissing: true,
        serialsMissing: true,
        previousDate: null,
        previousDevices: [],
      },
    ],
  };
  const model = buildLifecycleJson('PICKED_UP');
  model.orderDetail.orderHeader.d.invoiceUrl = URL;
  model.orderDetail.orderItems[model.orderDetail.orderItems.c[0]].orderItemDetails.d.quantity = 2;
  const body = JSON.stringify(model);
  source = {
    provider: 'Apple official website',
    runId: RUN,
    sampleId: ID,
    status: 200,
    cached: false,
    host: HOST,
    path: '/shop/order/detail/synthetic/[ORDER]',
    action: null,
    urlHash: hash(`https://${HOST}/shop/order/detail/synthetic/${ORDER}`),
    contentType: 'text/html',
    type: 'Document',
    phase: 'post-login',
    observedAt: new Date(now - 2000).toISOString(),
    sha256: hash(body),
    file: `body-1-${hash(body).slice(0, 16)}.enc`,
  };
  result = { ...parseOfficialOrderDetail(body, ORDER), systemOrderId: ID, source };
  receipt = {
    systemOrderId: ID,
    orderNumber: ORDER,
    runId: RECEIPT_RUN,
    detailRun: RUN,
    detailSha256: source.sha256,
    file: `receipt-probe-${RECEIPT_RUN}.enc`,
    sha256: hash(invoice()),
    status: 200,
    contentType: 'text/html',
    observedAt: new Date(now - 500).toISOString(),
    egressHash: 'e'.repeat(64),
    urlHash: hash(URL),
    transport: 'same-browser',
    egressVerifiedAfter: true,
    egressAfterHash: 'e'.repeat(64),
    proxyHash: 'f'.repeat(64),
    browserAuditFile: AUDIT_FILE,
    browserAttemptId: 'a'.repeat(32),
    leaseStartedAt: new Date(now - 10000).toISOString(),
  };
  audit = {
    outcome: 'SUCCEEDED',
    orderId: ID,
    targetOrderId: ID,
    runId: RUN,
    detailRunId: RUN,
    receiptRunId: RECEIPT_RUN,
    receiptOutcome: 'RECEIPT_CAPTURED',
    receiptFile: `/research/private/receipt-probe-${ID}.json`,
    resultFile: `/research/private/results/order-${ID}-run-${RUN}.json`,
    receipt: { orderId: ID, detailRun: RUN, runId: RECEIPT_RUN, outcome: 'RECEIPT_CAPTURED' },
    startedAt: (now - 4000) / 1000,
    finishedAt: (now - 100) / 1000,
    attemptId: 'a'.repeat(32),
    egressHash: receipt.egressHash,
    egressAfterHash: receipt.egressHash,
    egressVerifiedAfter: true,
    proxyHash: receipt.proxyHash,
    cleanup: { removed: true },
    businessWrites: 0,
    auditFile: AUDIT_FILE,
    receiptEgressVerifiedAfter: true,
    leaseContext: {
      provider: 'iproyal',
      proxyHash: receipt.proxyHash,
      egressHash: receipt.egressHash,
      startedAt: receipt.leaseStartedAt,
    },
  };
  const detailEvent = {
    ...source,
    message: 'body',
    timestamp: source.observedAt,
    bytes: Buffer.byteLength(body),
  };
  delete detailEvent.provider;
  delete detailEvent.runId;
  delete detailEvent.observedAt;
  events = [
    detailEvent,
    {
      ...detailEvent,
      phase: 'receipt',
      urlHash: receipt.urlHash,
      path: safePath(new global.URL(URL).pathname),
      file: `body-2-${receipt.sha256.slice(0, 16)}.enc`,
      sha256: receipt.sha256,
      bytes: Buffer.byteLength(invoice()),
      timestamp: new Date(now - 1000).toISOString(),
    },
  ];
  save('private/plan.json', plan);
  save('private/evidence.key', key);
  save(`private/results/order-${ID}-run-${RUN}.json`, result);
  save(`evidence/run-${RUN}/${source.file}`, encrypt(Buffer.from(body), key));
  saveAudit();
  replaceReceipt(invoice());
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('同浏览器两次运行密文和审计通过，只读返回原bindReceipt完整载荷', () => {
  const before = snapshot();
  expect(verify()).toMatchObject({
    scope: 'missing-fields',
    schemaVersion: 3,
    entry: plan.entries[0],
    receipt: { runId: RECEIPT_RUN, detailRun: RUN },
    parsed: {
      orderNumber: ORDER,
      items: [{ serialNumber: 'A123456789' }, { serialNumber: 'B123456789' }],
    },
  });
  expect(snapshot()).toEqual(before);
});

test.each([
  ['outcome', 'PARTIAL'],
  ['orderId', 12],
  ['targetOrderId', 12],
  ['attemptId', 'b'.repeat(32)],
  ['cleanup', { removed: false }],
  ['businessWrites', 1],
  ['egressVerifiedAfter', false],
  ['egressAfterHash', '0'.repeat(64)],
  ['egressHash', null],
  ['runId', 21],
  ['detailRunId', 21],
  ['receiptRunId', RUN],
  ['receiptOutcome', 'HTTP_541'],
  ['receipt', null],
  ['resultFile', '/research/private/results/other.json'],
  ['receiptFile', '/tmp/receipt.json'],
  ['startedAt', '100'],
  ['finishedAt', null],
  ['auditFile', 'other.json'],
  ['proxyHash', 'invalid'],
])('审计身份、独立运行、出口或清理错误拒绝 %s', (field, value) => {
  audit[field] = value;
  saveAudit();
  expect(() => verify()).toThrow();
});

test.each([
  ['schemaVersion', 2],
  ['scope', 'all-picked-up'],
  ['cutoff', '2026-09-23'],
  ['startedAt', 'invalid'],
  ['entries', []],
  ['policy', {}],
])('冻结范围不可扩大 %s', (field, value) => {
  plan[field] = value;
  save('private/plan.json', plan);
  expect(() => verify()).toThrow('BROWSER_RECEIPT_SCOPE_INVALID');
});

test.each([
  ['systemOrderId', 12],
  ['orderNumber', 'W9999999999'],
  ['runId', 27],
  ['detailRun', 20],
  ['status', 302],
  ['contentType', 'application/pdf'],
  ['file', '../x.enc'],
  ['transport', 'other'],
  ['egressVerifiedAfter', false],
  ['egressAfterHash', '0'.repeat(64)],
  ['proxyHash', '0'.repeat(64)],
  ['browserAuditSha256', '0'.repeat(64)],
  ['browserAttemptId', 'b'.repeat(32)],
  ['detailSha256', '0'.repeat(64)],
  ['urlHash', '0'.repeat(64)],
])('收据私密元数据必须同订单/详情/浏览器审计 %s', (field, value) => {
  receipt[field] = value;
  save(`private/receipt-probe-${ID}.json`, receipt);
  expect(() => verify()).toThrow();
});

test.each(['source-old', 'receipt-old', 'receipt-before-detail', 'future', 'sample-too-long'])(
  '严格5分钟和本轮时间窗 %s',
  kind => {
    if (kind === 'source-old') result.source.observedAt = new Date(now - 300001).toISOString();
    if (kind === 'receipt-old') receipt.observedAt = new Date(now - 300001).toISOString();
    if (kind === 'receipt-before-detail') receipt.observedAt = new Date(now - 3000).toISOString();
    if (kind === 'future') audit.finishedAt = (now + 1000) / 1000;
    if (kind === 'sample-too-long') audit.startedAt -= 400;
    save(`private/results/order-${ID}-run-${RUN}.json`, result);
    saveAudit();
    expect(() => verify()).toThrow();
  }
);

test.each([
  ['cached', true],
  ['sampleId', 12],
  ['runId', 20],
  ['status', 404],
  ['provider', 'cache'],
  ['host', 'example.test'],
  ['phase', 'receipt'],
  ['contentType', 'text/plain'],
])('详情来源字段严格验证 %s', (field, value) => {
  result.source[field] = value;
  save(`private/results/order-${ID}-run-${RUN}.json`, result);
  expect(() => verify()).toThrow();
});

test.each([
  'missing',
  'duplicate',
  'wrong-url',
  'cached',
  'wrong-order',
  'wrong-type',
  'wrong-time',
])('浏览器收据body事件完整绑定 %s', kind => {
  if (kind === 'missing') events.pop();
  if (kind === 'duplicate') events.push({ ...events[1] });
  if (kind === 'wrong-url') events[1].urlHash = '0'.repeat(64);
  if (kind === 'cached') events[1].cached = true;
  if (kind === 'wrong-order') events[1].sampleId = 12;
  if (kind === 'wrong-type') events[1].contentType = 'application/pdf';
  if (kind === 'wrong-time') events[1].timestamp = 'invalid';
  saveEvents();
  expect(() => verify()).toThrow();
});

test.each([
  invoice('W9999999999'),
  invoice(ORDER, ['A123456789']),
  invoice(ORDER, ['A123456789', 'A123456789']),
  'W1234567890 A123456789 B123456789',
])('即使密文和日志一致，收据身份/SN数量/明确字段不符仍整体拒绝 %#', body => {
  replaceReceipt(body);
  expect(() => verify()).toThrow();
});

test('持久结果伪造状态与真实详情不一致拒绝', () => {
  result.products[0].rawStatus = 'CANCELLED';
  save(`private/results/order-${ID}-run-${RUN}.json`, result);
  expect(() => verify()).toThrow('BROWSER_RECEIPT_DETAIL_INVALID');
});

test.each([
  { provider: 'other' },
  { proxyHash: '0'.repeat(64) },
  { egressHash: '0'.repeat(64) },
  { startedAt: 'invalid' },
  { startedAt: '2099-01-01T00:00:00.000Z' },
  { startedAt: '2000-01-01T00:00:00.000Z' },
])('同一次浏览器租约身份、未来或过期起点拒绝 %#', overrides => {
  Object.assign(audit.leaseContext, overrides);
  saveAudit();
  expect(() => verify()).toThrow('BROWSER_RECEIPT_LEASE_INVALID');
});

test('receiptEgressVerifiedAfter 必须由sampler确认，不能只依赖通用出口布尔值', () => {
  delete audit.receiptEgressVerifiedAfter;
  saveAudit();
  expect(() => verify()).toThrow('BROWSER_RECEIPT_AUDIT_INVALID');
});

test('receipt租约起点不符不能被摘要相同掩盖', () => {
  receipt.leaseStartedAt = new Date(now - 20000).toISOString();
  save(`private/receipt-probe-${ID}.json`, receipt);
  expect(() => verify()).toThrow('BROWSER_RECEIPT_METADATA_INVALID');
});

test.each(['key-public', 'receipt-link', 'body-tampered'])('私密文件及密文完整性边界 %s', kind => {
  if (kind === 'key-public') fs.chmodSync(path.join(root, 'private/evidence.key'), 0o644);
  if (kind === 'receipt-link') {
    const filename = path.join(root, `evidence/${receipt.file}`);
    fs.renameSync(filename, filename + '.original');
    fs.symlinkSync(filename + '.original', filename);
  }
  if (kind === 'body-tampered') save(`evidence/${receipt.file}`, Buffer.alloc(64, 1));
  expect(() => verify()).toThrow();
});

function buildAppliedBasis() {
  const oldAudit = {
    ...audit,
    runId: HTTP_RUN,
    attemptId: 'b'.repeat(32),
    startedAt: (now - 30000) / 1000,
    finishedAt: (now - 29000) / 1000,
    resultFile: `/research/private/results/order-${ID}-run-${HTTP_RUN}.json`,
  };
  save(`private/${HTTP_AUDIT}`, oldAudit);
  const basis = {
    version: 1,
    planSha256: hash(fs.readFileSync(path.join(root, 'private/plan.json'))),
    orderId: ID,
    originalRowHash: plan.entries[0].rowHash,
    stableRowHash: '7'.repeat(32),
    runId: HTTP_RUN,
    auditSha256: hash(fs.readFileSync(path.join(root, `private/${HTTP_AUDIT}`))),
  };
  const payload = {
    version: 1,
    plan,
    planSha256: basis.planSha256,
    entry: plan.entries[0],
    result: { ...result, source: { ...source, runId: HTTP_RUN } },
    audit: oldAudit,
    evidence: { auditSha256: basis.auditSha256 },
  };
  const prefix = `http-apply-${ID}-${'8'.repeat(32)}`;
  const preview = {
    version: 1,
    mode: 'dry-run',
    businessWrites: 0,
    orderId: ID,
    runId: HTTP_RUN,
    payloadSha256: hash(JSON.stringify(payload)),
    basis,
    stableRowHash: basis.stableRowHash,
    beforeHash: '9'.repeat(32),
    devicesHash: hash('[]'),
  };
  const appliedResult = { ...preview, mode: 'apply', businessWrites: 1, afterHash: '0'.repeat(32) };
  const appliedAudit = {
    ...appliedResult,
    outcome: 'SUCCEEDED',
    resultFile: `${prefix}-result.json`,
    basisFile: BASIS_FILE,
  };
  const intent = {
    state: 'APPLIED',
    sourceAudit: HTTP_AUDIT,
    attemptId: '8'.repeat(32),
    orderId: ID,
    runId: HTTP_RUN,
  };
  for (const [name, value] of Object.entries({
    payload,
    preview,
    result: appliedResult,
    audit: appliedAudit,
  })) {
    intent[`${name}File`] = `${prefix}-${name}.json`;
    save(`private/${prefix}-${name}.json`, value);
  }
  save(`private/http-apply-intent-${ID}.json`, intent);
  save(`private/${BASIS_FILE}`, basis);
  return { basis, intent, appliedResult, appliedAudit, payload, preview };
}

test('已确认HTTP旧run的basis可用于新browser run，全部链路只读验证', () => {
  const { basis } = buildAppliedBasis();
  const before = snapshot();
  const output = verify({ basisFile: BASIS_FILE, httpSourceAudit: HTTP_AUDIT });
  expect(output.entry).toEqual({ ...plan.entries[0], stableRowHash: basis.stableRowHash });
  expect(output.receipt).toMatchObject({
    basisFile: BASIS_FILE,
    httpSourceAudit: HTTP_AUDIT,
    runId: RECEIPT_RUN,
    detailRun: RUN,
  });
  expect(snapshot()).toEqual(before);
});

test.each([
  'version',
  'planSha256',
  'orderId',
  'originalRowHash',
  'stableRowHash',
  'runId',
  'auditSha256',
])('旧basis任一绑定字段错误拒绝 %s', field => {
  const { basis } = buildAppliedBasis();
  basis[field] = field === 'runId' ? RUN : 'invalid';
  save(`private/${BASIS_FILE}`, basis);
  expect(() => verify({ basisFile: BASIS_FILE, httpSourceAudit: HTTP_AUDIT })).toThrow();
});

test.each(['intent', 'payload', 'preview', 'result', 'audit'])(
  '不能仅凭stable摘要接受不完整或未提交HTTP回写链 %s',
  kind => {
    const fixtures = buildAppliedBasis();
    if (kind === 'intent') {
      fixtures.intent.state = 'APPLY_STARTED';
      save(`private/http-apply-intent-${ID}.json`, fixtures.intent);
    } else {
      const filename = fixtures.intent[`${kind}File`];
      const value = read(`private/${filename}`);
      if (kind === 'payload') value.entry = { ...value.entry, rowHash: '1'.repeat(32) };
      if (kind === 'preview') value.payloadSha256 = '1'.repeat(64);
      if (kind === 'result') value.basis.stableRowHash = '1'.repeat(32);
      if (kind === 'audit') value.outcome = 'MANUAL_RECONCILIATION_REQUIRED';
      save(`private/${filename}`, value);
    }
    expect(() => verify({ basisFile: BASIS_FILE, httpSourceAudit: HTTP_AUDIT })).toThrow(
      'BROWSER_RECEIPT_BASIS_INVALID'
    );
  }
);

test.each([
  { basisFile: BASIS_FILE },
  { httpSourceAudit: HTTP_AUDIT },
  { basisFile: '../basis.json', httpSourceAudit: HTTP_AUDIT },
])('basis和明确HTTP审计必须成对且不能逃逸 %#', options => {
  buildAppliedBasis();
  expect(() => verify(options)).toThrow();
});

test('CLI成功仅输出私密payload，错误不泄露订单与序列号', () => {
  const file = path.resolve(__dirname, '../scripts/officialPickupBackfill/verifyBrowserReceipt.js');
  const good = spawnSync(process.execPath, [file, root, String(ID), AUDIT_FILE], {
    encoding: 'utf8',
  });
  expect(good.status).toBe(0);
  expect(JSON.parse(good.stdout).parsed.items).toHaveLength(2);
  const bad = spawnSync(process.execPath, [file, root, '../11', AUDIT_FILE], { encoding: 'utf8' });
  expect(bad.status).toBe(1);
  expect(bad.stdout).toBe('');
  expect(bad.stderr).toBe('BROWSER_RECEIPT_INPUT_INVALID');
});
