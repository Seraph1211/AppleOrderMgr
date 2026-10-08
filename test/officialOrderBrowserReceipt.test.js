/* eslint-disable no-magic-numbers -- 合成收据运行边界。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { collectBrowserReceipt } = require('../src/services/officialOrderBrowserReceipt');
const { encrypt, hash, readPrivate, decrypt } = require('../src/services/officialOrderSupport');
const DETAIL_URL = 'https://secure6.www.apple.com.cn/shop/order/detail/Abc/W1234567890';
let root;
let collector;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-receipt-'));
  fs.mkdirSync(`${root}/evidence/run-1`, { recursive: true });
  const key = crypto.randomBytes(32);
  const body = JSON.stringify({
    orderDetail: {
      orderHeader: {
        d: {
          orderNumber: 'W1234567890',
          invoiceUrl: 'https://secure6.www.apple.com.cn/shop/order/print/invoice/123/Abc',
        },
      },
    },
  });
  fs.writeFileSync(`${root}/evidence/run-1/body.enc`, encrypt(Buffer.from(body), key));
  collector = {
    root,
    id: 1,
    directory: `${root}/evidence/run-1`,
    key,
    sample: { id: 11, orderNumber: 'W1234567890' },
    resultEvidence: {
      file: 'body.enc',
      sha256: hash(body),
      host: 'secure6.www.apple.com.cn',
      urlHash: hash(DETAIL_URL),
    },
    leaseContext: { startedAt: new Date().toISOString(), egressHash: 'a'.repeat(64) },
    pending: new Set(),
    stopped: 'SUCCEEDED',
    pageControl: { send: jest.fn() },
    gate: {
      finishOrder: jest.fn(),
      startOrder: jest.fn().mockResolvedValue(2),
      recordFailure: jest.fn(),
    },
    page: {
      url: jest.fn(() => DETAIL_URL),
      goto: jest.fn().mockImplementation(() => {
        collector.receiptPhase.captured = {
          bytes: Buffer.from('<html>receipt</html>'),
          status: 200,
          contentType: 'text/html',
        };
        return Promise.resolve();
      }),
    },
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
test('同一 page 获取收据、独立登记尝试、保存密文并等待出口复核', async () => {
  const receipt = await collectBrowserReceipt(collector);
  expect(receipt).toMatchObject({ outcome: 'RECEIPT_CAPTURED', runId: 2, detailRun: 1 });
  expect(collector.gate.startOrder).toHaveBeenCalledWith(collector.sample);
  expect(collector.page.goto).toHaveBeenCalledWith(
    'https://secure6.www.apple.com.cn/shop/order/print/invoice/123/Abc',
    { referer: DETAIL_URL, waitUntil: 'load', timeout: 20000 }
  );
  const metadata = readPrivate(`${root}/private/receipt-probe-11.json`);
  expect(metadata.egressVerifiedAfter).toBe(false);
  expect(
    decrypt(fs.readFileSync(`${root}/evidence/${metadata.file}`), collector.key).toString()
  ).toContain('receipt');
  expect(collector.stopped).toBe('SUCCEEDED');
});
test.each([
  ['其他主机', DETAIL_URL.replace('secure6.', 'secure7.'), true],
  ['其他订单', DETAIL_URL.replace('W1234567890', 'W9999999999'), true],
  ['其他路径', DETAIL_URL.replace('/detail/', '/guest/'), true],
  ['摘要不匹配', DETAIL_URL, false],
  ['查询不匹配', DETAIL_URL + '?r=changed', false],
  ['片段不匹配', DETAIL_URL + '#changed', false],
])('来源%s在结束详情或申请收据次数前拒绝', async (_name, currentUrl, matchHash) => {
  collector.page.url.mockReturnValue(currentUrl);
  collector.resultEvidence.urlHash = matchHash ? hash(currentUrl) : hash(DETAIL_URL + '?original');
  const receipt = await collectBrowserReceipt(collector);
  expect(receipt.outcome).toBe('RECEIPT_DETAIL_SOURCE_MISMATCH');
  expect(receipt.runId).toBeUndefined();
  expect(collector.pageControl.send).not.toHaveBeenCalled();
  expect(collector.gate.finishOrder).not.toHaveBeenCalled();
  expect(collector.gate.startOrder).not.toHaveBeenCalled();
  expect(collector.page.goto).not.toHaveBeenCalled();
  expect(fs.existsSync(`${root}/private/receipt-probe-11.json`)).toBe(false);
});
test('缺少详情URL摘要时不构造Referer或申请次数', async () => {
  delete collector.resultEvidence.urlHash;
  expect((await collectBrowserReceipt(collector)).outcome).toBe('RECEIPT_DETAIL_SOURCE_MISMATCH');
  expect(collector.gate.finishOrder).not.toHaveBeenCalled();
  expect(collector.gate.startOrder).not.toHaveBeenCalled();
  expect(collector.page.goto).not.toHaveBeenCalled();
});
test('当前详情查询与证据完全一致时原样保留Referer', async () => {
  const currentUrl = DETAIL_URL + '?r=synthetic-current-server-value';
  collector.page.url.mockReturnValue(currentUrl);
  collector.resultEvidence.urlHash = hash(currentUrl);
  expect((await collectBrowserReceipt(collector)).outcome).toBe('RECEIPT_CAPTURED');
  expect(collector.page.goto.mock.calls[0][1].referer).toBe(currentUrl);
});
test('停止页面加载期间来源改变也在申请次数前拒绝', async () => {
  collector.pageControl.send.mockImplementation(() => {
    collector.page.url.mockReturnValue(DETAIL_URL + '?changed');
    return Promise.resolve();
  });
  expect((await collectBrowserReceipt(collector)).outcome).toBe('RECEIPT_DETAIL_SOURCE_MISMATCH');
  expect(collector.gate.finishOrder).not.toHaveBeenCalled();
  expect(collector.gate.startOrder).not.toHaveBeenCalled();
  expect(collector.page.goto).not.toHaveBeenCalled();
});
test('租期不足不消耗请求或尝试', async () => {
  collector.leaseContext.startedAt = new Date(Date.now() - 400000).toISOString();
  expect((await collectBrowserReceipt(collector)).outcome).toBe('RECEIPT_LEASE_TOO_SHORT');
  expect(collector.gate.startOrder).not.toHaveBeenCalled();
  expect(collector.page.goto).not.toHaveBeenCalled();
});
test('IPRoyal 收据不受旧十分钟租期限制，但仍拒绝过期和未来起点', async () => {
  collector.leaseContext.provider = 'iproyal';
  collector.leaseContext.startedAt = new Date(Date.now() - 700000).toISOString();
  expect((await collectBrowserReceipt(collector)).outcome).toBe('RECEIPT_CAPTURED');
  collector.leaseContext.startedAt = new Date(Date.now() - 86400000).toISOString();
  expect((await collectBrowserReceipt(collector)).outcome).toBe('RECEIPT_LEASE_TOO_SHORT');
  collector.leaseContext.startedAt = new Date(Date.now() + 60000).toISOString();
  expect((await collectBrowserReceipt(collector)).outcome).toBe('RECEIPT_LEASE_TOO_SHORT');
});
test('次数耗尽保留详情成功，不发送收据请求', async () => {
  collector.gate.startOrder.mockRejectedValue(
    Object.assign(new Error(), { code: 'ORDER_ATTEMPT_LIMIT' })
  );
  expect((await collectBrowserReceipt(collector)).outcome).toBe('ORDER_ATTEMPT_LIMIT');
  expect(collector.page.goto).not.toHaveBeenCalled();
  expect(collector.stopped).toBe('SUCCEEDED');
});
test('重定向不保存可绑定收据且不会重新登录', async () => {
  collector.page.goto.mockImplementation(() => {
    collector.receiptPhase.outcome = 'RECEIPT_SESSION_REDIRECT';
    return Promise.resolve();
  });
  expect((await collectBrowserReceipt(collector)).outcome).toBe('RECEIPT_SESSION_REDIRECT');
  expect(fs.existsSync(`${root}/private/receipt-probe-11.json`)).toBe(false);
  expect(collector.gate.startOrder).toHaveBeenCalledTimes(1);
});
test.each(['RECEIPT_SESSION_REDIRECT', 'HTTP_541', 'REQUEST_STOPPED', 'TIME_BUDGET'])(
  '已有200正文也不能提升后续拒绝状态：%s',
  async outcome => {
    collector.page.goto.mockImplementation(() => {
      collector.receiptPhase.captured = {
        bytes: Buffer.from('<html>receipt</html>'),
        status: 200,
        contentType: 'text/html',
      };
      collector.receiptPhase.outcome = 'RECEIPT_CAPTURED';
      collector.stopped = outcome;
      return Promise.resolve();
    });
    expect((await collectBrowserReceipt(collector)).outcome).toBe(outcome);
    expect(fs.existsSync(`${root}/private/receipt-probe-11.json`)).toBe(false);
    expect(fs.existsSync(`${root}/evidence/receipt-probe-2.enc`)).toBe(false);
    expect(collector.gate.recordFailure).toHaveBeenCalledWith(outcome, undefined);
  }
);
test('正常RECEIPT_CAPTURED停止仍保存收据，不误判失败', async () => {
  collector.page.goto.mockImplementation(() => {
    collector.receiptPhase.captured = {
      bytes: Buffer.from('<html>receipt</html>'),
      status: 200,
      contentType: 'text/html',
    };
    collector.receiptPhase.outcome = 'RECEIPT_CAPTURED';
    collector.stopped = 'RECEIPT_CAPTURED';
    return Promise.resolve();
  });
  expect((await collectBrowserReceipt(collector)).outcome).toBe('RECEIPT_CAPTURED');
  expect(fs.existsSync(`${root}/private/receipt-probe-11.json`)).toBe(true);
});
test('phase已拒绝但迟到正常stop不能覆盖拒绝', async () => {
  collector.page.goto.mockImplementation(() => {
    collector.receiptPhase.captured = {
      bytes: Buffer.from('<html>receipt</html>'),
      status: 200,
      contentType: 'text/html',
    };
    collector.receiptPhase.outcome = 'RECEIPT_SESSION_REDIRECT';
    collector.stopped = 'RECEIPT_CAPTURED';
    return Promise.resolve();
  });
  expect((await collectBrowserReceipt(collector)).outcome).toBe('RECEIPT_SESSION_REDIRECT');
  expect(fs.existsSync(`${root}/private/receipt-probe-11.json`)).toBe(false);
});
test('风控响应保留失败分类及门禁，不伪装成详情失败', async () => {
  collector.page.goto.mockImplementation(() => {
    collector.stopped = 'HTTP_429';
    return Promise.resolve();
  });
  expect((await collectBrowserReceipt(collector)).outcome).toBe('HTTP_429');
  expect(collector.gate.recordFailure).toHaveBeenCalledWith('HTTP_429', undefined);
  expect(collector.stopped).toBe('SUCCEEDED');
});
