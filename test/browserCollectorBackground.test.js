const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const payload = require('../src/services/crawler/browserOrderPayload');
const background = fs.readFileSync(
  path.join(__dirname, '../frontend/public/browser-collector/background.js'),
  'utf8'
);

function eventSource() {
  const listeners = [];
  return {
    addListener: fn => listeners.push(fn),
    fire: (...args) => listeners.forEach(fn => fn(...args)),
  };
}

function setup(url = 'https://apple.godp.me/orders') {
  const chrome = {
    tabs: {
      create: jest.fn().mockResolvedValue({ id: 88 }),
      remove: jest.fn().mockResolvedValue(),
    },
    debugger: {
      attach: jest.fn().mockResolvedValue(),
      detach: jest.fn().mockResolvedValue(),
      sendCommand: jest.fn().mockResolvedValue({}),
      onEvent: eventSource(),
      onDetach: eventSource(),
    },
    runtime: { onConnectExternal: eventSource() },
  };
  const port = {
    name: 'apple-order-refresh',
    sender: { url, frameId: 0 },
    postMessage: jest.fn(),
    disconnect: jest.fn(),
    onDisconnect: eventSource(),
    onMessage: eventSource(),
  };
  const context = {
    chrome,
    importScripts: jest.fn(),
    self: { browserOrderPayload: payload },
    URL,
    TextDecoder,
    Uint8Array,
    atob,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(background, context);
  chrome.runtime.onConnectExternal.fire(port);
  const start = () =>
    port.onMessage.fire({
      type: 'start',
      orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
      orderNumber: 'W1234567890',
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    });
  return { chrome, port, start };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test.each([541, 429])('扩展识别查询参数详情接口的 %s 并记录真实拒绝原因', async status => {
  const { chrome, port, start } = setup();
  start();
  await flush();
  chrome.debugger.onEvent.fire({ tabId: 88 }, 'Network.responseReceived', {
    requestId: 'detail',
    type: 'Fetch',
    response: {
      url: 'https://secure8.www.apple.com.cn/shop/order/lookup?_a=fetchOrder',
      mimeType: 'application/json',
      status,
    },
  });
  await flush();
  const result = port.postMessage.mock.calls
    .map(([message]) => message)
    .find(message => message.type === 'result');
  expect(result.error).toContain(String(status));
  expect(result.diagnostics.fetchOrderStatuses).toEqual([status]);
  expect(chrome.tabs.remove).toHaveBeenCalledWith(88);
});

test('不接受非授权来源、非顶层页面，不读取已有标签页', () => {
  const { chrome, port } = setup('https://evil.example/orders');
  expect(port.disconnect).toHaveBeenCalled();
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  expect(chrome.debugger.attach).not.toHaveBeenCalled();
});

test('每个受拦截请求先等待服务端许可，成功时仅回传白名单并关闭自己的页面', async () => {
  const { chrome, port, start } = setup();
  start();
  await flush();
  expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 88 }, '1.3');
  chrome.debugger.onEvent.fire({ tabId: 88 }, 'Fetch.requestPaused', { requestId: 'req-one' });
  await flush();
  expect(
    chrome.debugger.sendCommand.mock.calls.some(
      ([, command]) => command === 'Fetch.continueRequest'
    )
  ).toBe(false);
  port.onMessage.fire({ type: 'permit', id: 1, allowed: true });
  await flush();
  expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 88 }, 'Fetch.continueRequest', {
    requestId: 'req-one',
  });
  const json = buildLifecycleJson('PROCESSING');
  json.cookie = 'never-export';
  chrome.debugger.sendCommand.mockImplementation((_target, command) =>
    Promise.resolve(command === 'Network.getResponseBody' ? { body: JSON.stringify(json) } : {})
  );
  chrome.debugger.onEvent.fire({ tabId: 88 }, 'Network.responseReceived', {
    requestId: 'response-one',
    type: 'Document',
    response: {
      url: 'https://secure8.www.apple.com.cn/shop/order/guest/W1234567890/private-token?e=true',
      mimeType: 'application/json',
      status: 200,
    },
  });
  chrome.debugger.onEvent.fire({ tabId: 88 }, 'Network.loadingFinished', {
    requestId: 'response-one',
    encodedDataLength: 2000,
  });
  await flush();
  expect(chrome.tabs.remove).toHaveBeenCalledWith(88);
  const result = port.postMessage.mock.calls
    .map(([message]) => message)
    .find(message => message.type === 'result');
  expect(result.page.pageUrl).toBe(
    'https://secure8.www.apple.com.cn/shop/order/guest/W1234567890/redacted'
  );
  expect(JSON.stringify(result)).not.toMatch(/never-export|private-token/);
});

test('取消等待许可时关闭临时页，迟到许可不会继续请求', async () => {
  const { chrome, port, start } = setup();
  start();
  await flush();
  chrome.debugger.onEvent.fire({ tabId: 88 }, 'Fetch.requestPaused', { requestId: 'waiting' });
  port.onMessage.fire({ type: 'cancel' });
  await flush();
  port.onMessage.fire({ type: 'permit', id: 1, allowed: true });
  await flush();
  expect(
    chrome.debugger.sendCommand.mock.calls.some(
      ([, command]) => command === 'Fetch.continueRequest'
    )
  ).toBe(false);
  expect(chrome.tabs.remove).toHaveBeenCalledTimes(1);
});

test('独立子页面或官网风控触发停止，不继续未限流的子页', async () => {
  const { chrome, port, start } = setup();
  start();
  await flush();
  chrome.debugger.onEvent.fire({ tabId: 88 }, 'Target.attachedToTarget', { sessionId: 'child' });
  await flush();
  expect(chrome.tabs.remove).toHaveBeenCalledWith(88);
  expect(
    port.postMessage.mock.calls.some(
      ([message]) => message.type === 'result' && message.error.includes('子页面')
    )
  ).toBe(true);
});

test('加载页与读取失败保留阶段计数，诊断不含响应正文或访客链接', async () => {
  const { chrome, port, start } = setup();
  start();
  await flush();
  chrome.debugger.sendCommand.mockImplementation((_target, command) =>
    Promise.resolve(
      command === 'Network.getResponseBody' ? { body: '<html>private contact</html>' } : {}
    )
  );
  const documentResponse = {
    requestId: 'loading',
    type: 'Document',
    response: {
      url: 'https://secure8.www.apple.com.cn/shop/order/guest/W1234567890/private-token',
      mimeType: 'text/html',
      status: 200,
    },
  };
  chrome.debugger.onEvent.fire({ tabId: 88 }, 'Network.responseReceived', documentResponse);
  chrome.debugger.onEvent.fire({ tabId: 88 }, 'Network.loadingFinished', {
    requestId: 'loading',
    encodedDataLength: 30,
  });
  await flush();
  chrome.debugger.sendCommand.mockImplementation((_target, command) =>
    command === 'Network.getResponseBody'
      ? Promise.reject(new Error('private response failure'))
      : Promise.resolve({})
  );
  chrome.debugger.onEvent.fire({ tabId: 88 }, 'Network.responseReceived', {
    ...documentResponse,
    requestId: 'lost',
  });
  chrome.debugger.onEvent.fire({ tabId: 88 }, 'Network.loadingFinished', {
    requestId: 'lost',
    encodedDataLength: 30,
  });
  await flush();
  const result = port.postMessage.mock.calls
    .map(([message]) => message)
    .find(message => message.type === 'result');
  expect(result.diagnostics.documentStatuses).toEqual([200, 200]);
  expect(result.diagnostics.unrecognizedBodies).toBe(1);
  expect(result.diagnostics.bodyReadFailures).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/private|secure8|W1234567890/);
});
