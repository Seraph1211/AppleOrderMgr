const { batchError } = require('./batchConfig');
const {
  findBrowserOrderJson,
  projectBrowserOrderJson,
  isBrowserOrderResponse,
} = require('../browserOrderPayload');

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function validateTask(task) {
  try {
    const url = new URL(task.orderUrl);
    const parts = url.pathname.split('/');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.apple.com.cn' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 6 ||
      parts[1] !== 'xc' ||
      parts[2] !== 'cn' ||
      parts[3] !== 'vieworder' ||
      parts[4] !== task.orderNumber ||
      !parts[5] ||
      !/^W\d{10}$/.test(task.orderNumber) ||
      typeof task.ticket !== 'string' ||
      task.maxRequests !== 100 ||
      task.maxDurationMs !== 300000 ||
      !Number.isFinite(Date.parse(task.expiresAt)) ||
      Date.parse(task.expiresAt) <= Date.now()
    ) {
      throw batchError('INVALID_BATCH_TICKET');
    }
  } catch (_error) {
    throw batchError('INVALID_BATCH_TICKET');
  }
}

function parseBody(text, contentType) {
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw batchError('COLLECTION_INVALID');
  if (contentType.includes('json') || /^[\s]*[[{]/.test(text)) return JSON.parse(text);
  const script = text.match(
    /<script\b(?=[^>]*\bid\s*=\s*["']init_data["'])[^>]*>([\s\S]*?)<\/script\s*>/i
  );
  return script ? JSON.parse(script[1]) : null;
}

/** 用全新浏览器上下文及固定代理采集单笔订单；每个请求、重定向都申请全局许可。 */
async function collectBrowserOrder({ browser, task, proxy, permit, signal }) {
  validateTask(task);
  let context;
  let page;
  let session;
  let ended = false;
  let requestCount = 0;
  let pageUrl;
  let orderJson;
  const responses = new Map();
  const controller = new AbortController();
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  function finish(error) {
    if (ended) return;
    ended = true;
    controller.abort();
    if (error) rejectResult(error);
    else resolveResult({ pageUrl, orderJson });
  }
  const cancel = () => finish(batchError('CANCELLED'));
  const disconnect = () => finish(batchError('BROWSER_DISCONNECTED'));
  const timer = setTimeout(
    () => finish(batchError(pageUrl ? 'NO_STRUCTURED_DATA' : 'COLLECTION_TIMEOUT')),
    Math.max(1, Math.min(task.maxDurationMs, Date.parse(task.expiresAt) - Date.now() - 15000))
  );
  signal?.addEventListener('abort', cancel, { once: true });
  browser.on('disconnected', disconnect);
  if (signal?.aborted) cancel();

  async function handle(method, params) {
    if (ended) return;
    try {
      if (method === 'Target.attachedToTarget') {
        finish(batchError('UNSUPPORTED_CHILD_TARGET'));
      } else if (method === 'Fetch.requestPaused') {
        requestCount += 1;
        if (requestCount > task.maxRequests) throw batchError('REQUEST_LIMIT');
        // 这些资源不参与订单业务解析，取消后不会产生实际代理请求。
        if (['Image', 'Media', 'Font'].includes(params.resourceType)) {
          await session.send('Fetch.failRequest', {
            requestId: params.requestId,
            errorReason: 'Aborted',
          });
          return;
        }
        await permit(controller.signal);
        if (!ended) await session.send('Fetch.continueRequest', { requestId: params.requestId });
      } else if (method === 'Network.responseReceived') {
        const response = params.response;
        const url = new URL(response.url);
        const relevant = isBrowserOrderResponse(url, params.type);
        if (relevant && [541, 429].includes(response.status)) {
          throw batchError('APPLE_THROTTLED');
        }
        if (relevant && response.status === 200 && url.hostname.startsWith('secure')) {
          if (params.type === 'Document') {
            const match = url.pathname.match(/^\/shop\/order\/guest\/(W\d{10})\/[^/]+$/);
            if (match) {
              if (match[1] !== task.orderNumber) throw batchError('COLLECTION_INVALID');
              pageUrl = `${url.origin}/shop/order/guest/${task.orderNumber}/redacted`;
              if (orderJson) finish();
            }
          }
          responses.set(params.requestId, response.mimeType || '');
        }
      } else if (method === 'Network.loadingFinished' && responses.has(params.requestId)) {
        const mimeType = responses.get(params.requestId);
        responses.delete(params.requestId);
        if (params.encodedDataLength > MAX_BODY_BYTES) throw batchError('COLLECTION_INVALID');
        const body = await session.send('Network.getResponseBody', { requestId: params.requestId });
        if (ended) return;
        const text = body.base64Encoded
          ? Buffer.from(body.body, 'base64').toString('utf8')
          : body.body;
        const parsed = parseBody(text, mimeType);
        const detail = parsed && findBrowserOrderJson(parsed);
        if (detail) {
          orderJson = projectBrowserOrderJson(detail, task.orderNumber);
          if (pageUrl) finish();
        }
      } else if (method === 'Network.loadingFailed' && params.type === 'Document') {
        throw batchError('NETWORK_FAILED');
      }
    } catch (error) {
      finish(error.code && error.message === error.code ? error : batchError('COLLECTION_INVALID'));
    }
  }
  async function setup() {
    try {
      if (ended) return;
      context = await browser.newContext({
        proxy: { server: proxy },
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      // 任务取消可能先于 newContext 返回；迟到的上下文也必须关闭。
      if (ended) {
        await context.close();
        return;
      }
      await context.routeWebSocket('**/*', socket => socket.close());
      if (ended) return;
      page = await context.newPage();
      if (ended) return;
      context.on('page', child => {
        if (child !== page) finish(batchError('UNSUPPORTED_CHILD_TARGET'));
      });
      page.on('close', () => {
        if (!ended) finish(batchError('NETWORK_FAILED'));
      });
      session = await context.newCDPSession(page);
      if (ended) return;
      for (const event of [
        'Target.attachedToTarget',
        'Fetch.requestPaused',
        'Network.responseReceived',
        'Network.loadingFinished',
        'Network.loadingFailed',
      ]) {
        session.on(event, params => {
          void handle(event, params);
        });
      }
      for (const [method, params] of [
        [
          'Network.enable',
          { maxResourceBufferSize: MAX_BODY_BYTES, maxTotalBufferSize: MAX_BODY_BYTES * 2 },
        ],
        ['Network.setCacheDisabled', { cacheDisabled: true }],
        ['Network.setBypassServiceWorker', { bypass: true }],
        ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
        ['Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }],
        ['Page.navigate', { url: task.orderUrl }],
      ]) {
        if (ended) return;
        const response = await session.send(method, params);
        if (method === 'Page.navigate' && response.errorText) throw batchError('NETWORK_FAILED');
      }
    } catch (_error) {
      finish(batchError(browser.isConnected() ? 'NETWORK_FAILED' : 'BROWSER_DISCONNECTED'));
    }
  }
  try {
    void setup();
    return await result;
  } catch (error) {
    throw error.code && error.message === error.code ? error : batchError('COLLECTION_INVALID');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    browser.removeListener('disconnected', disconnect);
    if (context) {
      try {
        await context.close();
      } catch (_error) {
        /* 已关闭的上下文无需再次清理。 */
      }
    }
  }
}

module.exports = { collectBrowserOrder };
