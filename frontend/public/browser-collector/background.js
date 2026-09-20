/* global chrome, importScripts */
importScripts('orderPayload.js');

const ALLOWED_ORIGINS = new Set([
  'https://apple.godp.me',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);
const MAX_REQUESTS = 100;
const MAX_DURATION_MS = 90000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
let activeTask = null;

function isAllowedSender(sender) {
  try {
    return ALLOWED_ORIGINS.has(new URL(sender?.url).origin) && sender.frameId === 0;
  } catch (_error) {
    return false;
  }
}

function validateTask(message) {
  const url = new URL(message.orderUrl);
  const parts = url.pathname.split('/');
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.apple.com.cn' ||
    url.port ||
    url.username ||
    url.password ||
    parts.length !== 6 ||
    parts[1] !== 'xc' ||
    parts[2] !== 'cn' ||
    parts[3] !== 'vieworder' ||
    parts[4] !== message.orderNumber ||
    !/^W\d{10}$/.test(message.orderNumber) ||
    !parts[5]
  ) {
    throw new Error('订单链接格式无效');
  }
  if (
    !Number.isFinite(Date.parse(message.expiresAt)) ||
    Date.parse(message.expiresAt) <= Date.now()
  )
    throw new Error('刷新任务已过期');
}

function send(task, message) {
  if (task.closed) return;
  try {
    task.port.postMessage(message);
  } catch (_error) {
    void finish(task, { error: '管理台连接已断开' });
  }
}

async function finish(task, result) {
  if (task.closed) return;
  task.closed = true;
  clearTimeout(task.timer);
  for (const pending of task.permits.values()) pending.reject(new Error('任务已结束'));
  task.permits.clear();
  // 先关闭自己创建的页面，防止解除调试时有未受限流的请求继续发送。
  if (task.tabId !== null) {
    try {
      await chrome.tabs.remove(task.tabId);
    } catch (_error) {
      /* 页面可能已被用户关闭。 */
    }
    try {
      await chrome.debugger.detach({ tabId: task.tabId });
    } catch (_error) {
      /* 关闭页面已解除调试。 */
    }
  }
  if (activeTask === task) activeTask = null;
  try {
    task.port.postMessage({
      type: 'result',
      ...result,
      diagnostics: { ...task.diagnostics, requestCount: Math.min(task.requestCount, MAX_REQUESTS) },
    });
    task.port.disconnect();
  } catch (_error) {
    /* 管理台关闭时不保留或转发订单结果。 */
  }
}

function requestPermit(task) {
  return new Promise((resolve, reject) => {
    if (task.closed) {
      reject(new Error('任务已结束'));
      return;
    }
    const id = ++task.requestCount;
    if (id > MAX_REQUESTS) {
      reject(new Error('本次请求数已达上限'));
      return;
    }
    task.permits.set(id, { resolve, reject });
    send(task, { type: 'permit', id });
  });
}

async function begin(task, message) {
  try {
    validateTask(message);
    task.orderNumber = message.orderNumber;
    task.timer = setTimeout(
      () => void finish(task, { error: '官网加载超时，本次未更新' }),
      Math.min(MAX_DURATION_MS, Date.parse(message.expiresAt) - Date.now())
    );
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    task.tabId = tab.id;
    if (task.closed) {
      await chrome.tabs.remove(tab.id);
      return;
    }
    const target = { tabId: tab.id };
    await chrome.debugger.attach(target, '1.3');
    await chrome.debugger.sendCommand(target, 'Network.enable');
    await chrome.debugger.sendCommand(target, 'Network.setBypassServiceWorker', { bypass: true });
    // 未实现跨进程子页时暂停它再终止任务，不能漏掉子页请求的全局限流。
    await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await chrome.debugger.sendCommand(target, 'Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    await chrome.debugger.sendCommand(target, 'Page.navigate', {
      url: message.orderUrl,
    });
  } catch (_error) {
    await finish(task, {
      error: '无法启动浏览器采集，请检查扩展权限及页面调试占用',
    });
  }
}

function parseBody(text, contentType) {
  if (text.length > MAX_BODY_BYTES) throw new Error('官网响应过大');
  if (
    contentType.includes('json') ||
    text.trimStart().startsWith('{') ||
    text.trimStart().startsWith('[')
  )
    return JSON.parse(text);
  const script = text.match(
    /<script\b(?=[^>]*\bid\s*=\s*["']init_data["'])[^>]*>([\s\S]*?)<\/script\s*>/i
  );
  return script ? JSON.parse(script[1]) : null;
}

async function handleEvent(source, method, params) {
  const task = activeTask;
  if (!task || task.closed || source.tabId !== task.tabId) return;
  try {
    if (method === 'Target.attachedToTarget') {
      await finish(task, {
        error: '官网使用了独立子页面，当前采集端暂不支持，本次未更新',
      });
    } else if (method === 'Fetch.requestPaused') {
      await requestPermit(task);
      if (!task.closed)
        await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', {
          requestId: params.requestId,
        });
    } else if (method === 'Network.responseReceived') {
      const response = params.response;
      const url = new URL(response.url);
      const relevant = self.browserOrderPayload.isBrowserOrderResponse(url, params.type);
      if (relevant) {
        const statuses =
          params.type === 'Document'
            ? task.diagnostics.documentStatuses
            : task.diagnostics.fetchOrderStatuses;
        if (Number.isInteger(response.status) && statuses.length < 10)
          statuses.push(response.status);
      }
      if (relevant && [541, 429].includes(response.status)) {
        await finish(task, {
          error: `官网暂时拒绝请求（${response.status}），本次未更新`,
        });
      } else if (relevant && response.status === 200) {
        if (
          params.type === 'Document' &&
          url.pathname.startsWith(`/shop/order/guest/${task.orderNumber}/`)
        ) {
          task.pageUrl = `${url.origin}/shop/order/guest/${task.orderNumber}/redacted`;
        }
        task.responses.set(params.requestId, response.mimeType || '');
      }
    } else if (method === 'Network.loadingFinished' && task.responses.has(params.requestId)) {
      const mimeType = task.responses.get(params.requestId);
      task.responses.delete(params.requestId);
      if (params.encodedDataLength > MAX_BODY_BYTES) throw new Error('官网响应过大');
      let body;
      try {
        body = await chrome.debugger.sendCommand(source, 'Network.getResponseBody', {
          requestId: params.requestId,
        });
      } catch (error) {
        task.diagnostics.bodyReadFailures += 1;
        throw error;
      }
      const text = body.base64Encoded
        ? new TextDecoder().decode(Uint8Array.from(atob(body.body), c => c.charCodeAt(0)))
        : body.body;
      let json;
      try {
        json = parseBody(text, mimeType);
      } catch (error) {
        task.diagnostics.bodyParseFailures += 1;
        throw error;
      }
      if (!json) {
        task.diagnostics.unrecognizedBodies += 1;
        return;
      }
      task.diagnostics.parsedBodies += 1;
      const orderJson = self.browserOrderPayload.findBrowserOrderJson(json);
      if (!orderJson) task.diagnostics.missingDetailBodies += 1;
      if (orderJson && task.pageUrl) {
        const projected = self.browserOrderPayload.projectBrowserOrderJson(
          orderJson,
          task.orderNumber
        );
        await finish(task, {
          page: { pageUrl: task.pageUrl, orderJson: projected },
        });
      }
    } else if (method === 'Network.loadingFailed') {
      task.diagnostics.networkFailures += 1;
    }
  } catch (_error) {
    await finish(task, { error: '浏览器采集未完成或响应无效，本次未更新' });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  void handleEvent(source, method, params);
});
chrome.debugger.onDetach.addListener(source => {
  if (activeTask?.tabId === source.tabId)
    void finish(activeTask, { error: '浏览器调试已断开，本次未更新' });
});
chrome.runtime.onConnectExternal.addListener(port => {
  if (!isAllowedSender(port.sender) || port.name !== 'apple-order-refresh') {
    port.disconnect();
    return;
  }
  if (activeTask) {
    port.postMessage({ type: 'result', error: '浏览器正在刷新另一笔订单' });
    port.disconnect();
    return;
  }
  const task = {
    port,
    tabId: null,
    closed: false,
    started: false,
    permits: new Map(),
    responses: new Map(),
    requestCount: 0,
    diagnostics: {
      documentStatuses: [],
      fetchOrderStatuses: [],
      parsedBodies: 0,
      missingDetailBodies: 0,
      unrecognizedBodies: 0,
      bodyReadFailures: 0,
      bodyParseFailures: 0,
      networkFailures: 0,
    },
  };
  activeTask = task;
  task.timer = setTimeout(() => void finish(task, { error: '刷新任务未开始' }), 10000);
  port.onDisconnect.addListener(() => {
    void finish(task, { error: '管理台已关闭' });
  });
  port.onMessage.addListener(message => {
    if (message?.type === 'start' && !task.started) {
      task.started = true;
      clearTimeout(task.timer);
      void begin(task, message);
    } else if (message?.type === 'permit' && task.permits.has(message.id)) {
      const pending = task.permits.get(message.id);
      task.permits.delete(message.id);
      if (message.allowed === true) pending.resolve();
      else pending.reject(new Error('请求许可失败'));
    } else if (message?.type === 'cancel') {
      void finish(task, { error: '已取消，本次未更新' });
    }
  });
  send(task, { type: 'ready', version: '0.1.2' });
});
