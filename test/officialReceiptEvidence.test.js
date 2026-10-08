/* eslint-disable no-magic-numbers -- 合成证据边界。 */
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const {
  verifyReceiptEvidence,
  receiptQuantity,
} = require('../src/services/officialReceiptEvidence');
const {
  hash,
  encrypt,
  writePrivate,
  readPrivate,
} = require('../src/services/officialOrderSupport');
const { deviceSetHash } = require('../src/services/officialReceiptBinding');
const url = 'https://secure6.www.apple.com.cn/shop/order/print/invoice/test/token';
let root;
let intent;
let proof;
const store = (name, value) => writePrivate(`${root}/${name}`, JSON.stringify(value));
beforeEach(() => {
  root = fs.mkdtempSync(`${os.tmpdir()}/receipt-proof-`);
  const key = crypto.randomBytes(32);
  writePrivate(`${root}/private/evidence.key`, key);
  const orderNumber = 'W1234567890';
  const sample = {
    id: 1,
    orderNumber,
    email: 'test@example.invalid',
    password: 'synthetic',
    url: `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/test@example.invalid`,
    beforeRowHash: 'a'.repeat(32),
    accountHash: hash('test@example.invalid'),
  };
  store('private/input.json', {
    samples: [sample],
    actorUserId: 1,
    devicesBeforeHash: deviceSetHash([]),
  });
  const detail = JSON.stringify({
    orderDetail: {
      orderHeader: { d: { orderNumber, invoiceUrl: url } },
      orderItems: {
        c: ['orderItem-1'],
        'orderItem-1': {
          orderItemDetails: { d: { productName: 'Synthetic phone', quantity: 2 } },
          orderItemStatusTracker: { d: { currentStatus: 'PICKED_UP' } },
        },
      },
    },
  });
  const body = JSON.stringify({
    orderInvoices: {
      c: ['orderInvoice-1'],
      'orderInvoice-1': {
        invoiceOrderSummary: { d: { orderNumber } },
        invoiceLineItems: {
          c: ['invoiceLineItem-1'],
          'invoiceLineItem-1': {
            d: {
              hasLineItemSerialInfo: true,
              quantityShipped: 2,
              quantityOrdered: 2,
              lineItemSerialInfo: ['TESTSN0001', 'TESTSN0002'],
              partNumber: 'TEST/A',
              productName: 'Synthetic phone',
            },
          },
        },
      },
    },
  });
  writePrivate(`${root}/evidence/run-4/detail.enc`, encrypt(Buffer.from(detail), key));
  writePrivate(`${root}/evidence/run-4/receipt.enc`, encrypt(Buffer.from(body), key));
  intent = { requestKey: crypto.randomUUID(), batchId: crypto.randomUUID() };
  proof = {
    version: 1,
    status: 200,
    runId: 4,
    systemOrderId: 1,
    orderNumber,
    transport: 'native-controlled-click',
    sha256: hash(body),
    detailSha256: hash(detail),
    detailFile: 'detail.enc',
    file: 'receipt.enc',
    urlHash: hash(url),
    observedAt: new Date().toISOString(),
    egressHash: 'e'.repeat(64),
    permits: [{ index: 10 }],
  };
  store('private/receipt-4.json', proof);
  store('private/result.json', {
    runId: 4,
    systemOrderId: 1,
    requests: 10,
    outcome: 'SUCCEEDED',
    receipt: { outcome: 'RECEIPT_VERIFIED', receiptSha256: proof.sha256 },
  });
  store('private/gate.json', {
    runId: 4,
    orderId: 1,
    accountHash: sample.accountHash,
    orderHash: hash(orderNumber),
    outcome: 'SUCCEEDED',
    requests: 10,
    finishedAt: new Date().toISOString(),
  });
  store('private/audit.json', {
    cleanupConfirmed: true,
    egressBefore: proof.egressHash,
    egressAfter: proof.egressHash,
    orderId: 1,
    attemptId: intent.requestKey,
  });
  store('private/results/order-1-run-4.json', {
    systemOrderId: 1,
    source: {
      runId: 4,
      sha256: proof.detailSha256,
      host: 'secure6.www.apple.com.cn',
      cached: false,
    },
  });
  writePrivate(
    `${root}/evidence/run-4/events.jsonl`,
    [
      { message: 'permit', index: 10, urlHash: proof.urlHash },
      { message: 'receipt_permit', index: 10, urlHash: proof.urlHash, runId: 4 },
      { message: 'body', urlHash: proof.urlHash, sha256: proof.sha256, status: 200, cached: false },
    ]
      .map(value => JSON.stringify(value))
      .join('\n') + '\n'
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
test('一行两个商品按 quantity 求和，并从加密原文独立取得 SN', () => {
  proof.parsed = { items: [{ serialNumber: 'FORGED0001' }] };
  store('private/receipt-4.json', proof);
  expect(verifyReceiptEvidence(root, intent).items.map(item => item.serialNumber)).toEqual([
    'TESTSN0001',
    'TESTSN0002',
  ]);
});
test.each([
  ['private/gate.json', { requests: 9 }, 'RECEIPT_AUDIT_INVALID'],
  ['private/gate.json', { accountHash: 'f'.repeat(64) }, 'RECEIPT_AUDIT_INVALID'],
  ['private/audit.json', { egressAfter: 'f'.repeat(64) }, 'RECEIPT_AUDIT_INVALID'],
  ['private/audit.json', { cleanupConfirmed: false }, 'RECEIPT_AUDIT_INVALID'],
  ['private/receipt-4.json', { sha256: 'f'.repeat(64) }, 'RECEIPT_AUDIT_INVALID'],
  ['private/receipt-4.json', { file: '../another.enc' }, 'RECEIPT_FILE_INVALID'],
  ['private/receipt-4.json', { permits: [] }, 'RECEIPT_REQUEST_COVERAGE_INVALID'],
  [
    'private/receipt-4.json',
    { observedAt: '2020-01-01T00:00:00Z' },
    'RECEIPT_BINDING_PROOF_INVALID',
  ],
])('证据篡改 %s %j 拒绝写入', (name, change, code) => {
  store(name, { ...readPrivate(`${root}/${name}`), ...change });
  expect(() => verifyReceiptEvidence(root, intent)).toThrow(code);
});
test('缺失收据许可即使正文正确也拒绝', () => {
  const file = `${root}/evidence/run-4/events.jsonl`;
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => !line.includes('receipt_permit'))
      .join('\n')
  );
  expect(() => verifyReceiptEvidence(root, intent)).toThrow('RECEIPT_REQUEST_COVERAGE_INVALID');
});
test('不能把部分已取货或零数量当作完整收据', () => {
  expect(() =>
    receiptQuantity({ products: [{ quantity: 1, rawStatus: 'READY_FOR_PICKUP' }] })
  ).toThrow('RECEIPT_DETAIL_NOT_PICKED_UP');
  expect(() => receiptQuantity({ products: [{ quantity: 0, rawStatus: 'PICKED_UP' }] })).toThrow(
    'RECEIPT_DETAIL_NOT_PICKED_UP'
  );
});
