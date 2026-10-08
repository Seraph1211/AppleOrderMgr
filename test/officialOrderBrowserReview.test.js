/* eslint-disable no-magic-numbers -- 独立复现STOP与收尾错误，全部为本地替身。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
jest.mock('../src/services/officialOrderBrowserReceipt', () => ({
  collectBrowserReceipt: jest.fn(),
}));
const { collectBrowserReceipt } = require('../src/services/officialOrderBrowserReceipt');
const OfficialOrderCollector = require('../src/services/officialOrderCollector');

let root;
let collector;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'official-browser-review-'));
  fs.mkdirSync(path.join(root, 'private'));
  collector = Object.assign(Object.create(OfficialOrderCollector.prototype), {
    root,
    accountMode: true,
    httpBootstrap: true,
    sample: { id: 1 },
    samples: [{ id: 1 }],
    accountResults: [{ orderId: 1, runId: 12, attempted: true, outcome: 'SUCCEEDED' }],
    stopped: 'SUCCEEDED',
    id: 12,
    pending: new Set(),
    gate: {
      requests: 3,
      close: jest.fn().mockResolvedValue(),
      recordFailure: jest.fn().mockResolvedValue(),
    },
    initialize: jest.fn().mockResolvedValue(),
    launch: jest.fn().mockResolvedValue(),
    prepareHttpLogin: jest.fn().mockResolvedValue(),
    collectAccount: jest.fn().mockResolvedValue(),
    captureAuthDiagnostic: jest.fn().mockResolvedValue(),
    saveSession: jest.fn().mockResolvedValue(),
  });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test.each(['close', 'recordFailure'])('accountMode不会把gate.%s失败重新标成功', async operation => {
  collector.gate[operation].mockRejectedValue(new Error('synthetic persistence failure'));
  const result = await collector.run();
  expect(result.results[0].outcome).toBe('SUCCEEDED');
  expect(result.outcome).toBe('STATE_WRITE_FAILED');
});

test('accountMode不会把代理通道收尾失败重新标成功', async () => {
  collector.proxyTunnel = {
    close: jest.fn().mockRejectedValue(new Error('synthetic close failure')),
  };
  const result = await collector.run();
  expect(result.outcome).toBe('PROXY_TUNNEL_CLOSE_FAILED');
});

test('详情成功但收据遭541时顶层必须保留致命错误', async () => {
  collector.collectAccount.mockImplementation(async () => {
    await Promise.resolve();
    collector.stopped = 'HTTP_541';
    collector.accountResults[0].receipt = { outcome: 'HTTP_541' };
  });
  const result = await collector.run();
  expect(result.outcome).toBe('HTTP_541');
});

test('HTTP引导后的浏览器许可仍检查STOP文件', async () => {
  fs.writeFileSync(path.join(root, 'private/STOP'), 'stop', { mode: 0o600 });
  collector.stopped = null;
  collector.logger = { info: jest.fn() };
  collector.gate.permit = jest.fn(async (_url, isStopped) => {
    await Promise.resolve();
    if (isStopped()) throw Object.assign(new Error('REQUEST_STOPPED'), { code: 'REQUEST_STOPPED' });
    return { index: 1 };
  });
  await expect(
    collector.permit('https://www.apple.com.cn/shop/goto/account', 'Document')
  ).rejects.toThrow('REQUEST_STOPPED');
});

function requestStop() {
  fs.writeFileSync(path.join(root, 'private/STOP'), 'stop', { mode: 0o600 });
}

test('initialize在打开gate或登记每日次数前处理STOP', async () => {
  collector.stopped = null;
  collector.gate.openAccount = jest.fn();
  requestStop();
  await expect(OfficialOrderCollector.prototype.initialize.call(collector)).rejects.toThrow(
    'REQUEST_STOPPED'
  );
  expect(collector.gate.openAccount).not.toHaveBeenCalled();
});

test.each(['callback', 'after'])('全局许可等待过程中发生STOP：%s', async stage => {
  collector.stopped = null;
  collector.logger = { info: jest.fn() };
  collector.gate.permit = jest.fn(async (_url, isStopped) => {
    await Promise.resolve();
    requestStop();
    if (stage === 'callback' && isStopped())
      throw Object.assign(new Error('REQUEST_STOPPED'), { code: 'REQUEST_STOPPED' });
    return { index: 1 };
  });
  await expect(
    collector.permit('https://www.apple.com.cn/shop/goto/account', 'Document')
  ).rejects.toThrow('REQUEST_STOPPED');
});

test('Fetch获得许可后临界STOP仍禁止继续请求', async () => {
  collector.stopped = null;
  collector.logger = { info: jest.fn() };
  collector.sessions = new Set(['s1']);
  collector.inFlightHosts = new Map();
  collector.cdp = { send: jest.fn().mockResolvedValue() };
  collector.permit = jest.fn(async () => {
    await Promise.resolve();
    requestStop();
  });
  await collector.event({
    method: 'Fetch.requestPaused',
    sessionId: 's1',
    params: {
      requestId: 'r1',
      resourceType: 'Document',
      request: { url: 'https://www.apple.com.cn/shop/goto/account' },
    },
  });
  expect(collector.cdp.send.mock.calls.map(call => call[0])).toEqual(['Fetch.failRequest']);
  expect(collector.stopped).toBe('REQUEST_STOPPED');
});

test.each(['before-email', 'after-email', 'after-password', 'claim-login'])(
  '登录期间STOP不再填后续凭据或提交：%s',
  async stage => {
    collector.stopped = null;
    collector.sample = { email: 'synthetic@example.test', password: 'synthetic-password' };
    collector.logger = { info: jest.fn() };
    collector.navigateAccount = jest.fn().mockResolvedValue();
    const email = {
      isVisible: jest.fn().mockResolvedValue(true),
      fill: jest.fn(async () => {
        await Promise.resolve();
        if (stage === 'after-email') requestStop();
      }),
    };
    const password = {
      isVisible: jest.fn().mockResolvedValue(true),
      fill: jest.fn(async () => {
        await Promise.resolve();
        if (stage === 'after-password') requestStop();
      }),
    };
    const signIn = {
      isVisible: jest.fn(async () => {
        await Promise.resolve();
        if (stage === 'before-email') requestStop();
        return true;
      }),
      getAttribute: jest.fn().mockResolvedValue('Sign In'),
      click: jest.fn(),
    };
    const nodes = {
      '#password_text_field': password,
      '#account_name_text_field': email,
      '#sign-in': signIn,
    };
    collector.page = {
      frames: () => [{ url: () => 'https://idmsa.apple.com/login', locator: name => nodes[name] }],
    };
    collector.gate.claimLogin = jest.fn(async () => {
      await Promise.resolve();
      if (stage === 'claim-login') requestStop();
    });
    await collector.loginStep();
    expect(signIn.click).not.toHaveBeenCalled();
    expect(collector.passwordSubmitted).toBeFalsy();
    if (stage === 'before-email') expect(email.fill).not.toHaveBeenCalled();
    if (['before-email', 'after-email'].includes(stage))
      expect(password.fill).not.toHaveBeenCalled();
    if (stage !== 'claim-login') expect(collector.gate.claimLogin).not.toHaveBeenCalled();
  }
);

test('页面就绪等待后STOP禁止调用loginStep和详情导航', async () => {
  collector.stopped = null;
  collector.started = Date.now();
  collector.page = { goto: jest.fn().mockResolvedValue() };
  collector.waitForSiteReady = jest.fn(async () => {
    await Promise.resolve();
    requestStop();
    return true;
  });
  collector.loginStep = jest.fn();
  await collector.collectCurrent();
  expect(collector.loginStep).not.toHaveBeenCalled();
  expect(collector.page.goto).toHaveBeenCalledTimes(1);
  expect(collector.stopped).toBe('REQUEST_STOPPED');
});

test.each(['finish-order', 'stop-page'])('前一单结束后STOP不会占用下一单次数：%s', async stage => {
  collector.stopped = null;
  collector.started = Date.now();
  collector.accountResults = [];
  collector.samples = [{ id: 1 }, { id: 2 }];
  collector.requests = new Map();
  collector.pageControl = {
    send: jest.fn(async () => {
      await Promise.resolve();
      if (stage === 'stop-page') requestStop();
    }),
  };
  collector.collectCurrent = jest.fn(async () => {
    await Promise.resolve();
    collector.stopped = 'SUCCEEDED';
    collector.result = {};
  });
  collector.saveOrderResult = jest.fn().mockReturnValue('synthetic.json');
  collector.gate.finishOrder = jest.fn(async () => {
    await Promise.resolve();
    if (stage === 'finish-order') requestStop();
  });
  collector.gate.startOrder = jest.fn();
  await OfficialOrderCollector.prototype.collectAccount.call(collector);
  expect(collector.collectCurrent).toHaveBeenCalledTimes(1);
  expect(collector.gate.startOrder).not.toHaveBeenCalled();
  expect(collector.stopped).toBe('REQUEST_STOPPED');
});

test.each([
  ['RECEIPT_CAPTURED', 'SUCCEEDED'],
  ['HTTP_541', 'HTTP_541'],
  ['STATE_WRITE_FAILED', 'STATE_WRITE_FAILED'],
  ['RECEIPT_TIMEOUT', 'RECEIPT_TIMEOUT'],
  [undefined, 'RECEIPT_CAPTURE_FAILED'],
  ['SUCCEEDED', 'RECEIPT_CAPTURE_FAILED'],
])('独立收据run以实际结果结束：%s', async (receiptOutcome, expected) => {
  collector.stopped = null;
  collector.accountResults = [];
  collector.captureReceipt = true;
  collector.gate.id = 12;
  collector.collectCurrent = jest.fn(async () => {
    await Promise.resolve();
    collector.stopped = 'SUCCEEDED';
    collector.result = {};
  });
  collector.saveOrderResult = jest.fn().mockReturnValue('synthetic.json');
  collector.gate.finishOrder = jest.fn().mockResolvedValue();
  collectBrowserReceipt.mockImplementationOnce(async () => {
    await Promise.resolve();
    collector.gate.id = 13;
    collector.stopped = 'SUCCEEDED';
    return { orderId: 1, detailRun: 12, runId: 13, outcome: receiptOutcome };
  });
  await OfficialOrderCollector.prototype.collectAccount.call(collector);
  expect(collector.accountResults[0].outcome).toBe('SUCCEEDED');
  expect(collector.gate.recordFailure).toHaveBeenLastCalledWith(expected, undefined);
  expect(collector.gate.finishOrder).toHaveBeenLastCalledWith(expected);
});

test('收据URL不存在且未开新run时，仍按真实详情成功关闭详情run', async () => {
  collector.stopped = null;
  collector.accountResults = [];
  collector.captureReceipt = true;
  collector.gate.id = 12;
  collector.collectCurrent = jest.fn(async () => {
    await Promise.resolve();
    collector.stopped = 'SUCCEEDED';
    collector.result = {};
  });
  collector.saveOrderResult = jest.fn().mockReturnValue('synthetic.json');
  collector.gate.finishOrder = jest.fn().mockResolvedValue();
  collectBrowserReceipt.mockResolvedValueOnce({
    orderId: 1,
    detailRun: 12,
    outcome: 'RECEIPT_URL_MISSING',
  });
  await OfficialOrderCollector.prototype.collectAccount.call(collector);
  expect(collector.gate.finishOrder).toHaveBeenLastCalledWith('SUCCEEDED');
  expect(collector.accountResults[0].receipt.runId).toBeUndefined();
});

test('收据run与实际gate不一致时禁止为另一run记成功', async () => {
  collector.stopped = null;
  collector.accountResults = [];
  collector.captureReceipt = true;
  collector.gate.id = 12;
  collector.collectCurrent = jest.fn(async () => {
    await Promise.resolve();
    collector.stopped = 'SUCCEEDED';
    collector.result = {};
  });
  collector.saveOrderResult = jest.fn().mockReturnValue('synthetic.json');
  collector.gate.finishOrder = jest.fn().mockResolvedValue();
  collectBrowserReceipt.mockResolvedValueOnce({
    orderId: 1,
    detailRun: 12,
    runId: 999,
    outcome: 'RECEIPT_CAPTURED',
  });
  await expect(OfficialOrderCollector.prototype.collectAccount.call(collector)).rejects.toThrow(
    'RECEIPT_RUN_MISMATCH'
  );
  expect(collector.gate.finishOrder).not.toHaveBeenCalled();
});
