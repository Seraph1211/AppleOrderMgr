/* eslint-disable no-magic-numbers -- 合成网络与证据样本。 */
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { captureOfficialReceipt } = require('../src/services/officialReceiptCapture');
const { receiptLoginUrl } = require('../src/services/officialReceiptCollector');
const { encrypt, hash, readPrivate } = require('../src/services/officialOrderSupport');

const DETAIL = 'https://secure6.www.apple.com.cn/shop/order/detail/context/W1234567890';
const RECEIPT = 'https://secure6.www.apple.com.cn/shop/order/print/invoice/invoice/token';
const receiptBody = JSON.stringify({
  orderInvoices: {
    c: ['orderInvoice-1'],
    'orderInvoice-1': {
      invoiceOrderSummary: { d: { orderNumber: 'W1234567890' } },
      invoiceLineItems: {
        c: ['invoiceLineItem-1'],
        'invoiceLineItem-1': {
          d: {
            hasLineItemSerialInfo: true,
            quantityOrdered: 1,
            quantityShipped: 1,
            lineItemSerialInfo: ['TESTSN0001'],
            partNumber: 'TEST/A',
            productName: 'TEST PHONE',
          },
        },
      },
    },
  },
});
let root;
let collector;
let receiptPage;
beforeEach(() => {
  root = fs.mkdtempSync(`${os.tmpdir()}/receipt-capture-`);
  fs.mkdirSync(`${root}/evidence/run-4`, { recursive: true });
  const key = crypto.randomBytes(32);
  const body = JSON.stringify({
    orderDetail: { orderHeader: { d: { orderNumber: 'W1234567890', invoiceUrl: RECEIPT } } },
  });
  fs.writeFileSync(`${root}/evidence/run-4/detail.enc`, encrypt(Buffer.from(body), key));
  receiptPage = {
    url: () => 'about:blank',
    close: jest.fn().mockResolvedValue(),
    goto: jest.fn().mockImplementation(() => {
      collector.receiptPhase.permits.push({
        index: 10,
        urlHash: hash(RECEIPT),
        runId: 4,
        type: 'Document',
      });
      collector.receiptPhase.captured = {
        bytes: Buffer.from(receiptBody),
        status: 200,
        contentType: 'text/html',
      };
      collector.receiptPhase.outcome = 'RECEIPT_CAPTURED';
      return Promise.resolve();
    }),
  };
  collector = {
    id: 4,
    root,
    key,
    directory: `${root}/evidence/run-4`,
    sample: { id: 7, orderNumber: 'W1234567890' },
    result: { completeItemCount: 1, products: [{ quantity: 1, rawStatus: 'PICKED_UP' }] },
    resultEvidence: {
      file: 'detail.enc',
      sha256: hash(body),
      urlHash: hash(DETAIL),
      host: 'secure6.www.apple.com.cn',
    },
    leaseContext: { egressHash: 'e'.repeat(64) },
    page: { url: () => DETAIL },
    pageControl: { send: jest.fn().mockResolvedValue() },
    context: {
      newPage: jest.fn().mockResolvedValue(receiptPage),
      newCDPSession: jest
        .fn()
        .mockResolvedValue({
          send: jest.fn().mockResolvedValue({ targetInfo: { targetId: 'controlled' } }),
          detach: jest.fn().mockResolvedValue(),
        }),
    },
    readyTargets: new Set(['controlled']),
    pending: new Set(),
    isStopRequested: () => false,
    log: jest.fn(),
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('预建页面与同 run 许可取得收据，原文身份和数量独立验证', async () => {
  const result = await captureOfficialReceipt(collector);
  expect(result).toMatchObject({
    outcome: 'RECEIPT_VERIFIED',
    runId: 4,
    detailRun: 4,
    serialCount: 1,
  });
  expect(receiptPage.goto).toHaveBeenCalledWith(
    RECEIPT,
    expect.objectContaining({ referer: DETAIL })
  );
  const proof = readPrivate(result.proofFile);
  expect(proof).toMatchObject({
    status: 200,
    transport: 'native-controlled-page',
    egressVerifiedAfter: false,
  });
  expect(proof.parsed.items[0].serialNumber).toBe('TESTSN0001');
  expect(proof.permits).toHaveLength(1);
  expect(collector.stopped).toBe('SUCCEEDED');
  expect(receiptPage.close).toHaveBeenCalled();
});

test.each([
  ['漏计', []],
  [
    '重复许可',
    [
      { index: 1, urlHash: hash(RECEIPT) },
      { index: 2, urlHash: hash(RECEIPT) },
    ],
  ],
  ['错误目的', [{ index: 1, urlHash: hash(DETAIL) }]],
])('%s 即使收到合法收据也拒绝产出成功证明', async (_name, permits) => {
  const original = receiptPage.goto.getMockImplementation();
  receiptPage.goto.mockImplementation(() => {
    original();
    collector.receiptPhase.permits = permits;
    return Promise.resolve();
  });
  expect((await captureOfficialReceipt(collector)).outcome).toBe(
    'RECEIPT_REQUEST_COVERAGE_INVALID'
  );
  expect(fs.existsSync(`${root}/private/receipt-4.json`)).toBe(false);
});

test('原文序列号与预期数量不符时整单拒绝', async () => {
  collector.result.products[0].quantity = 2;
  expect((await captureOfficialReceipt(collector)).outcome).toBe('RECEIPT_QUANTITY_MISMATCH');
});
test('新页不是空白页时不发导航请求', async () => {
  receiptPage.url = () => RECEIPT;
  expect((await captureOfficialReceipt(collector)).outcome).toBe('RECEIPT_PAGE_NOT_BLANK');
  expect(receiptPage.goto).not.toHaveBeenCalled();
});
test('停止请求在目标就绪等待期间阻止导航', async () => {
  collector.readyTargets.clear();
  collector.isStopRequested = () => true;
  expect((await captureOfficialReceipt(collector)).outcome).toBe('REQUEST_STOPPED');
  expect(receiptPage.goto).not.toHaveBeenCalled();
});
test('错误页重定向不重新登录也不保留可写结果', async () => {
  receiptPage.goto.mockImplementation(() => {
    collector.receiptPhase.outcome = 'RECEIPT_SESSION_REDIRECT';
    return Promise.resolve();
  });
  expect((await captureOfficialReceipt(collector)).outcome).toBe('RECEIPT_SESSION_REDIRECT');
  expect(collector.stopped).toBe('RECEIPT_SESSION_REDIRECT');
});
test('来源详情在停止加载期间变化时拒绝', async () => {
  collector.pageControl.send.mockImplementation(() => {
    collector.page.url = () => DETAIL + '?new';
    return Promise.resolve();
  });
  expect((await captureOfficialReceipt(collector)).outcome).toBe('RECEIPT_DETAIL_SOURCE_MISMATCH');
  expect(collector.context.newPage).not.toHaveBeenCalled();
});

test('使用本次正确订单的官方登录入口', () => {
  const target = DETAIL + '?_a=fetchOrder&_m=guestOrderSpinner';
  const body = JSON.stringify({
    orderDetail: { d: { signInURL: target }, orderHeader: { d: { orderNumber: 'W1234567890' } } },
  });
  expect(receiptLoginUrl(body, DETAIL, 'W1234567890')).toBe(target);
  expect(() => receiptLoginUrl(body, DETAIL, 'W9999999999')).toThrow(
    'RECEIPT_LOGIN_DESTINATION_UNAVAILABLE'
  );
  for (const value of [
    target.replace('secure6', 'secure7'),
    target + '&extra=1',
    target.replace('fetchOrder', 'cancelOrder'),
  ]) {
    const altered = JSON.parse(body);
    altered.orderDetail.d.signInURL = value;
    expect(() => receiptLoginUrl(JSON.stringify(altered), DETAIL, 'W1234567890')).toThrow(
      'RECEIPT_LOGIN_DESTINATION_DENIED'
    );
  }
});
