/* global window, location */
const OfficialOrderCollector = require('./officialOrderCollector');
const { OfficialOrderHttpTransport } = require('./officialOrderHttpTransport');
const { OfficialOrderHttpCollector } = require('./officialOrderHttpCollector');
const { browserBootstrapCookies } = require('./officialOrderHttpBootstrap');
const { readOfficialModel } = require('./officialOrderParser');
const { captureOfficialReceipt } = require('./officialReceiptCapture');
const {
  fault,
  permittedUrl,
  safePath,
  hash,
  proxyLeaseWindowMs,
} = require('./officialOrderSupport');

const STORE_HOST = /^secure\d*\.www\.apple\.com\.cn$/;
const BRIDGE_PATH = /^\/shop\/(?:signIn(?:\/|$)|order\/(?:detail|list)(?:\/|$)|shld\/work\/)/;
const STRIPPED_HEADERS =
  /^(?:host|connection|content-length|transfer-encoding|proxy-authorization|proxy-connection|user-agent|sec-ch-ua(?:-mobile|-platform)?|accept-encoding|cookie)$/i;

/** 使用目标订单原始响应的登录入口，不猜测账号或访问令牌。 */
function receiptLoginUrl(body, responseUrl, orderNumber) {
  const detail = readOfficialModel(body, 'orderDetail');
  if (detail?.orderHeader?.d?.orderNumber !== orderNumber || !detail?.d?.signInURL)
    throw fault('RECEIPT_LOGIN_DESTINATION_UNAVAILABLE');
  const source = permittedUrl(responseUrl);
  const target = permittedUrl(new URL(detail.d.signInURL, source).href);
  if (
    target.hostname !== source.hostname ||
    !STORE_HOST.test(target.hostname) ||
    !target.pathname.startsWith('/shop/order/detail/') ||
    !target.pathname.endsWith(`/${orderNumber}`) ||
    target.searchParams.get('_a') !== 'fetchOrder' ||
    target.searchParams.get('_m') !== 'guestOrderSpinner' ||
    [...target.searchParams.keys()].length !== 2 ||
    target.hash
  )
    throw fault('RECEIPT_LOGIN_DESTINATION_DENIED');
  return target.href;
}

/** 批量收据单次采集器：认证沿用官网浏览器，收据原生传输且导航前启用拦截。 */
class OfficialReceiptCollector extends OfficialOrderCollector {
  constructor(options) {
    super({
      ...options,
      accountMode: false,
      captureReceipt: true,
      browserMode: 'headless-shell',
      persistSessions: false,
    });
    this.receiptDomWindowMs = 20000;
    if (!this.proxy.preemptiveAuth) throw fault('RECEIPT_PROXY_AUTH_REQUIRED');
  }

  async launch() {
    try {
      await super.launch();
      await this.installTargetGuard();
    } catch (error) {
      error.component = 'officialReceiptLaunch';
      throw error;
    }
  }

  /** 上下文级守卫先拒绝未完成 CDP 初始化的新窗口首请求；许可仍只由 CDP 申请一次。 */
  async installTargetGuard() {
    try {
      this.guardedPages = new WeakSet([this.page]);
      await this.context.route('**/*', async route => {
        try {
          const page = route.request().frame().page();
          if (!this.guardedPages.has(page)) {
            this.log('receipt_unknown_target_blocked');
            if (this.receiptPhase) this.stop('RECEIPT_UNCONTROLLED_TARGET');
            await route.abort();
            return;
          }
          await route.continue();
        } catch (_error) {
          await route.abort().catch(() => {});
        }
      });
    } catch (error) {
      error.component = 'officialReceiptTargetGuard';
      throw error;
    }
  }

  /** 在已受控详情页点击原链接，保留网站的同源导航上下文；仅将显示目标改为当前页。 */
  async navigateReceipt(url) {
    try {
      const link = this.page.locator(`a[href=${JSON.stringify(url)}]:visible`);
      if (
        (await link.count()) !== 1 ||
        new URL(await link.getAttribute('href'), this.page.url()).href !== url
      )
        throw fault('RECEIPT_VISIBLE_LINK_MISMATCH');
      // 官网点击处理器还可能显式 window.open；只把这一个已验证 URL 的显示目标固定到受控页。
      await this.page.evaluate(expected => {
        const original = window.open;
        window.open = function (value, target, features) {
          if (new URL(value, location.href).href === expected) {
            window.open = original;
            return original.call(window, value, '_self', features);
          }
          return original.call(window, value, target, features);
        };
      }, url);
      await link.evaluate(element => element.setAttribute('target', '_self'));
      this.log('receipt_controlled_link_click');
      await link.click({ timeout: 25000 });
      await this.page.waitForLoadState('load', { timeout: 25000 }).catch(() => {});
    } catch (error) {
      error.component = 'officialReceiptNavigation';
      throw error;
    }
  }

  async prepareHttpLogin() {
    try {
      this.httpTransport = new OfficialOrderHttpTransport({
        gate: this.gate,
        proxy: this.proxy,
        pythonPath: this.httpPythonPath,
        isStopped: () => this.isStopRequested() || !!this.stopped,
      });
      await this.httpTransport.start();
      const collector = new OfficialOrderHttpCollector({
        transport: this.httpTransport,
        sample: this.sample,
        root: this.root,
        key: this.key,
        runId: Number(this.id),
        collectReceipt: false,
      });
      const originalRequest = collector.request.bind(collector);
      let last;
      collector.request = async (...args) => {
        try {
          last = await originalRequest(...args);
          return last;
        } catch (error) {
          error.component = 'receiptGuestRequest';
          throw error;
        }
      };
      const result = await collector.collect();
      if (result.outcome !== 'SUCCEEDED' || !last)
        throw fault(result.outcome || 'GUEST_DETAIL_FAILED');
      this.bootstrapLoginUrl = receiptLoginUrl(last.text, last.url, this.sample.orderNumber);
      await this.context.addCookies(browserBootstrapCookies(collector.cookies));
      this.log('receipt_login_ready', { urlHash: hash(this.bootstrapLoginUrl) });
    } catch (error) {
      error.component = 'officialReceiptBootstrap';
      throw error;
    }
  }

  async bridgeRequest(params, sessionId) {
    try {
      if (this.stopped || this.isStopRequested()) throw fault('REQUEST_STOPPED');
      if (
        Date.now() - Date.parse(this.leaseContext.startedAt) >
        proxyLeaseWindowMs(this.leaseContext, true)
      )
        throw fault('PROXY_LEASE_EXPIRED');
      const url = permittedUrl(params.request.url);
      if (
        !['GET', 'POST'].includes(params.request.method) ||
        (params.request.method === 'POST' &&
          !/^\/shop\/(?:signIn\/idms\/authx|shld\/work\/)/.test(url.pathname))
      )
        throw fault('RECEIPT_ACTION_DENIED');
      const headers = Object.fromEntries(
        Object.entries(params.request.headers).filter(([key]) => !STRIPPED_HEADERS.test(key))
      );
      const cookies = await this.context.cookies(url.href);
      if (cookies.length)
        headers.Cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      const input = { url: url.href, method: params.request.method, headers };
      if (params.request.postData !== undefined) input.body = params.request.postData;
      if (params.request.hasPostData && params.request.postData === undefined)
        throw fault('RECEIPT_POST_BODY_MISSING');
      const response = await this.httpTransport.request(input);
      const sealed = this.seal(response, 'receipt-bridge');
      this.log('receipt_store_bridge', {
        host: url.hostname,
        path: safePath(url.pathname),
        status: response.status,
        ...sealed,
      });
      await this.cdp.send(
        'Fetch.fulfillRequest',
        {
          requestId: params.requestId,
          responseCode: response.status,
          responseHeaders: response.rawHeaders
            .filter(
              ([key]) => !/^(?:content-encoding|content-length|transfer-encoding)$/i.test(key)
            )
            .map(([name, value]) => ({ name, value })),
          body: response.bodyBase64,
        },
        sessionId
      );
    } catch (error) {
      const code = /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'RECEIPT_BRIDGE_FAILED';
      this.log('receipt_bridge_failed', { code });
      this.stop(code);
      await this.cdp
        .send(
          'Fetch.failRequest',
          { requestId: params.requestId, errorReason: 'Aborted' },
          sessionId
        )
        .catch(() => {});
    }
  }

  async event(item) {
    try {
      if (item.method !== 'Fetch.requestPaused' || !this.httpTransport || this.receiptPhase)
        return await super.event(item);
      const url = new URL(item.params.request.url);
      if (!STORE_HOST.test(url.hostname) || !BRIDGE_PATH.test(url.pathname))
        return await super.event(item);
      this.bridgeChain = (this.bridgeChain || Promise.resolve()).then(() =>
        this.bridgeRequest(item.params, item.sessionId)
      );
      return await this.bridgeChain;
    } catch (error) {
      error.component = 'officialReceiptEvent';
      throw error;
    }
  }

  async permit(value, type) {
    try {
      await super.permit(value, type);
      if (this.receiptPhase) {
        const proof = {
          index: this.gate.requests,
          urlHash: hash(value),
          type,
          runId: Number(this.id),
        };
        this.receiptPhase.permits.push(proof);
        this.log('receipt_permit', proof);
      }
    } catch (error) {
      error.component = 'officialReceiptPermit';
      throw error;
    }
  }

  async collectReceipt() {
    try {
      return await captureOfficialReceipt(this);
    } catch (error) {
      error.component = 'officialReceiptCapture';
      throw error;
    }
  }

  async run() {
    try {
      return await super.run();
    } catch (error) {
      error.component = 'officialReceiptCollector';
      throw error;
    } finally {
      if (this.httpTransport) await this.httpTransport.close();
    }
  }
}

module.exports = { OfficialReceiptCollector, receiptLoginUrl };
