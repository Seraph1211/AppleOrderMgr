/* global window, document */
const crypto = require('crypto');
const cheerio = require('cheerio');
const { fault, permittedUrl } = require('./officialOrderSupport');
const { buildGuestRequestEvidence } = require('./officialOrderRequestEvidence');

const GUEST_ACTION_BUNDLE =
  'https://store.storeimages.cdn-apple.com/8756/store.apple.com/static-resources/rs-olss-5.18.5-9a078/dist/order-detail.js';
const GUEST_ACTION_INTEGRITY =
  'sha384-Z2U2oseFgonlxN8cWOdlal3cN8M722pJUT/ESiSKLi4ENYIovcoks1IoCL2laQBK';
const MODEL_HEADERS = Object.freeze(['x-aos-model-page', 'modelVersion', 'x-aos-stk', 'syntax']);
const MAX_HEADER_LENGTH = 1024;
const MAX_DOCUMENT_BYTES = 2097152;
const TRACE_BYTES = 5;
const HTTP_OK = 200;
const BINDING_PROPERTY_COUNT = 2;
const TRACE_RADIX = 36;

/** 只识别本次中国官网访客文档，不能从缓存或普通页面构造动作。 */
function isGuestActionDocument(meta) {
  return (
    meta?.type === 'Document' &&
    meta.status === HTTP_OK &&
    meta.cached === false &&
    /^(?:secure\d*\.)?www\.apple\.com\.cn$/.test(meta.host || '') &&
    /^\/shop\/order\/guest\/\[ORDER\]\/\[TOKEN\]$/.test(meta.path || '')
  );
}

/**
 * 从当前响应构造私密只读动作；结果含当前动态令牌，只能密封保存。
 * @param {string} html 本次响应原文。
 * @param {object} meta 本次非缓存响应元信息。
 * @param {string} orderNumber 已验证的目标订单号。
 * @returns {object|null} 私密请求；不是访客详情文档时为 null。
 */
function buildGuestActionRequest(html, meta, orderNumber) {
  if (!isGuestActionDocument(meta)) return null;
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_DOCUMENT_BYTES)
    throw fault('GUEST_ACTION_DOCUMENT_INVALID');
  try {
    const $ = cheerio.load(html);
    if ($('#init_data').length !== 1 || $('#uiConfig').length !== 1)
      throw fault('GUEST_ACTION_MODEL_INVALID');
    const model = JSON.parse($('#init_data').text());
    const config = JSON.parse($('#uiConfig').text());
    const spinner = model.guestOrderSpinner;
    const action = spinner?.a?.fetchOrder;
    const events = spinner?.b?.fetchOrder?.events;
    if (
      !action ||
      typeof action !== 'object' ||
      Object.keys(action).length !== 1 ||
      typeof action.url !== 'string' ||
      !Array.isArray(events) ||
      events.length !== 1 ||
      events[0]?.on !== 'click' ||
      events[0]?.do !== 'a.fetchOrder' ||
      Object.keys(events[0]).length !== BINDING_PROPERTY_COUNT
    )
      throw fault('GUEST_ACTION_MODEL_INVALID');
    const origin = `https://${meta.host}`;
    const url = permittedUrl(new URL(action.url, origin).href);
    if (url.origin !== origin) throw fault('GUEST_ACTION_IDENTITY_MISMATCH');
    const dynamicHeaders = model.meta?.h;
    if (
      !dynamicHeaders ||
      Array.isArray(dynamicHeaders) ||
      Object.keys(dynamicHeaders).length !== MODEL_HEADERS.length ||
      MODEL_HEADERS.some(
        name =>
          typeof dynamicHeaders[name] !== 'string' ||
          !dynamicHeaders[name].length ||
          dynamicHeaders[name].length > MAX_HEADER_LENGTH ||
          /[^\x20-\x7e]/.test(dynamicHeaders[name])
      )
    )
      throw fault('GUEST_ACTION_HEADERS_INVALID');
    const bundles = $('script[src]')
      .toArray()
      .filter(node => new URL($(node).attr('src'), origin).pathname.endsWith('/order-detail.js'));
    if (
      bundles.length !== 1 ||
      new URL($(bundles[0]).attr('src'), origin).href !== GUEST_ACTION_BUNDLE ||
      $(bundles[0]).attr('integrity') !== GUEST_ACTION_INTEGRITY
    )
      throw fault('GUEST_ACTION_SCRIPT_VERSION_UNSUPPORTED');
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'Fetch',
      ...dynamicHeaders,
    };
    if (config.fetchHeaders?.sendHeaders === true)
      headers['x-aos-ui-fetch-call-1'] =
        crypto.randomBytes(TRACE_BYTES).toString('hex') + '-' + Date.now().toString(TRACE_RADIX);
    if (
      !buildGuestRequestEvidence(
        { url: url.href, method: 'POST', headers, hasPostData: false },
        orderNumber
      )
    )
      throw fault('GUEST_ACTION_IDENTITY_MISMATCH');
    return {
      url: url.href,
      origin,
      method: 'POST',
      credentials: 'include',
      body: null,
      headers,
      dynamicHeaders: { ...dynamicHeaders },
      bundle: { url: GUEST_ACTION_BUNDLE, integrity: GUEST_ACTION_INTEGRITY },
    };
  } catch (error) {
    if (/^GUEST_ACTION_/.test(error.code || '')) throw error;
    throw fault('GUEST_ACTION_MODEL_INVALID');
  }
}

/** 页面初始化前安装观察器；只观察自然事件，不产生或模拟站点验证信号。 */
function installGuestActionReadiness({ key, settleMs }) {
  const state = {
    document,
    readyAt: null,
    used: false,
    acceptedSignals: 0,
    ignoredSignals: 0,
    readySource: null,
  };
  Object.defineProperty(window, key, { value: state });
  window.addEventListener('shldDone', event => {
    if (event?.detail?.id !== 'shld-no-ck') {
      state.acceptedSignals += 1;
      state.readyAt = Date.now() + settleMs;
      state.readySource = 'native_event';
    } else state.ignoredSignals += 1;
  });
  const ready = () => {
    if (window.shldConfig?.isEnabled === false) {
      state.readyAt = Date.now();
      state.readySource = 'explicitly_disabled';
    }
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
}

/**
 * 在原浏览器上下文只派发一次动作；网络仍经过原 CDP 许可，不在此重试。
 * @param {object} options 私密请求及有界等待配置，不写普通日志。
 * @returns {Promise<object>} 脱敏状态码；自然就绪超时可附只读枚举、布尔和计数摘要。
 */
async function dispatchGuestActionInPage({
  key,
  request,
  readyTimeoutMs,
  pollMs,
  requestTimeoutMs,
  scriptBlocked,
}) {
  let timer;
  try {
    const state = window[key];
    if (!state || state.document !== document) return { outcome: 'GUEST_ACTION_CONTEXT_CHANGED' };
    const started = Date.now();
    const readinessSnapshot = () => {
      try {
        const now = Date.now();
        const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
        return {
          available: true,
          waitedMs: Math.max(0, now - started),
          documentState: ['loading', 'interactive', 'complete'].includes(document.readyState)
            ? document.readyState
            : 'unknown',
          visibility: ['visible', 'hidden', 'prerender'].includes(document.visibilityState)
            ? document.visibilityState
            : 'unknown',
          hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() === true : null,
          configPresent: !!window.shldConfig && typeof window.shldConfig === 'object',
          configEnabled:
            typeof window.shldConfig?.isEnabled === 'boolean' ? window.shldConfig.isEnabled : null,
          readyObserved: Number.isFinite(state.readyAt),
          settlePending: Number.isFinite(state.readyAt) && now < state.readyAt,
          readySource: ['native_event', 'explicitly_disabled'].includes(state.readySource)
            ? state.readySource
            : null,
          acceptedSignals: count(state.acceptedSignals),
          ignoredSignals: count(state.ignoredSignals),
        };
      } catch (_error) {
        return { available: false };
      }
    };
    while (
      document.readyState === 'loading' ||
      state.readyAt === null ||
      Date.now() < state.readyAt
    ) {
      if (Date.now() - started >= readyTimeoutMs)
        return { outcome: 'GUEST_ACTION_READINESS_TIMEOUT', readiness: readinessSnapshot() };
      await new Promise(resolve => setTimeout(resolve, pollMs));
      if (window[key] !== state || state.document !== document)
        return { outcome: 'GUEST_ACTION_CONTEXT_CHANGED' };
    }
    if (scriptBlocked !== true) return { outcome: 'GUEST_ACTION_SCRIPT_NOT_BLOCKED' };
    if (state.used) return { outcome: 'GUEST_ACTION_ALREADY_SENT' };
    const model = JSON.parse(document.querySelector('#init_data')?.textContent || '{}');
    const action = model.guestOrderSpinner?.a?.fetchOrder;
    const bundles = [...document.querySelectorAll('script[src]')].filter(node =>
      new URL(node.getAttribute('src'), window.location.origin).pathname.endsWith(
        '/order-detail.js'
      )
    );
    if (
      window.location.origin !== request.origin ||
      !action ||
      Object.keys(action).length !== 1 ||
      new URL(action.url, window.location.origin).href !== request.url ||
      Object.entries(request.dynamicHeaders).some(
        ([name, value]) => model.meta?.h?.[name] !== value
      ) ||
      bundles.length !== 1 ||
      new URL(bundles[0].getAttribute('src'), window.location.origin).href !== request.bundle.url ||
      bundles[0].getAttribute('integrity') !== request.bundle.integrity
    )
      return { outcome: 'GUEST_ACTION_CONTEXT_CHANGED' };
    state.used = true;
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const response = await window.fetch(request.url, {
      method: 'POST',
      credentials: 'include',
      headers: request.headers,
      body: null,
      signal: controller.signal,
    });
    await response.arrayBuffer();
    return { outcome: 'GUEST_ACTION_RESPONSE', status: response.status };
  } catch (_error) {
    return { outcome: 'GUEST_ACTION_REQUEST_FAILED' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  GUEST_ACTION_BUNDLE,
  GUEST_ACTION_INTEGRITY,
  isGuestActionDocument,
  buildGuestActionRequest,
  installGuestActionReadiness,
  dispatchGuestActionInPage,
};
