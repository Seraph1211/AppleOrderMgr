const fs = require('fs');
const cheerio = require('cheerio');
const { buildGuestActionRequest } = require('./officialOrderGuestAction');
const { parseOfficialOrderDetail } = require('./officialOrderParser');
const { extractOfficialReceiptUrl, parseOfficialReceipt } = require('./officialOrderReceipt');
const { solveShieldChallenge, inspectShieldCookie } = require('./officialOrderShield');
const {
  fault,
  hash,
  safePath,
  permittedUrl,
  encrypt,
  writePrivate,
} = require('./officialOrderSupport');

const MAX_REDIRECTS = 8;
const HTTP_OK = 200;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/** 从本次页面的官方验证脚本定位挑战路由；不执行页面代码。 */
function discoverShieldUrl(body, documentUrl) {
  const $ = cheerio.load(body);
  const sources = $('script#shldVerify[src]').toArray();
  if (sources.length !== 1) throw fault('SHIELD_ROUTE_MISSING');
  const origin = permittedUrl(documentUrl).origin;
  const script = permittedUrl(new URL($(sources[0]).attr('src'), origin).href);
  const match = /^\/shop\/shld\/(v[0-9_]+)\/verify\.js$/.exec(script.pathname);
  if (script.origin !== origin || !match || script.search || script.hash)
    throw fault('SHIELD_ROUTE_INVALID');
  return `${origin}/shop/shld/work/${match[1]}/q`;
}

/** 收集器只允许读取订单、挑战计算和官网给出的详情/收据；不接受结算动作。 */
function validateReadUrl(value, method = 'GET', allowLoginBootstrap = false) {
  const url = permittedUrl(value);
  if (!/^(?:secure\d*\.)?www\.apple\.com\.cn$/.test(url.hostname))
    throw fault('READ_DESTINATION_DENIED');
  const loginBootstrap =
    allowLoginBootstrap === true &&
    method === 'GET' &&
    ((url.hostname === 'www.apple.com.cn' &&
      url.pathname === '/shop/goto/account' &&
      !url.search) ||
      url.href === 'https://www.apple.com.cn/cn/shop/go/account' ||
      /^https:\/\/secure\d*\.www\.apple\.com\.cn\/shop\/account\/home$/.test(url.href) ||
      (/^secure\d*\.www\.apple\.com\.cn$/.test(url.hostname) &&
        ['/shop/signIn', '/shop/signIn/account'].includes(url.pathname)));
  if (loginBootstrap && !url.href.includes('#')) return url;
  const readPath = /^\/(?:xc\/cn\/vieworder\/|shop\/order\/(?:list|guest|detail|print\/invoice)\/)/;
  const challenge = /^\/shop\/shld\/work\/v[0-9_]+\/q$/;
  const action = /^\/shop\/orderx\/guestx\//;
  if (
    (method === 'GET' && !readPath.test(url.pathname) && !challenge.test(url.pathname)) ||
    (method === 'POST' && !challenge.test(url.pathname) && !action.test(url.pathname)) ||
    !['GET', 'POST'].includes(method)
  )
    throw fault('READ_DESTINATION_DENIED');
  if (url.hash) throw fault('READ_DESTINATION_DENIED');
  const queryKeys = [...url.searchParams.keys()];
  if (action.test(url.pathname)) {
    if (
      queryKeys.some(key => !['_a', '_m', 'e'].includes(key)) ||
      url.searchParams.getAll('_a').length !== 1 ||
      url.searchParams.getAll('_m').length !== 1 ||
      url.searchParams.getAll('e').length > 1 ||
      (url.searchParams.has('e') && url.searchParams.get('e') !== 'true') ||
      url.searchParams.get('_a') !== 'fetchOrder' ||
      url.searchParams.get('_m') !== 'guestOrderSpinner'
    )
      throw fault('READ_DESTINATION_DENIED');
  } else if (
    queryKeys.some(key => key !== 'e') ||
    (url.search && (!/\/shop\/order\/guest\//.test(url.pathname) || url.search !== '?e=true'))
  ) {
    throw fault('READ_DESTINATION_DENIED');
  }
  return url;
}

function header(response, name) {
  const entry = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === name);
  return entry ? String(entry[1]) : '';
}

/** 单订单、单代理、单 Cookie 会话；传输层在每个实际请求前申请持久化全局许可。 */
class OfficialOrderHttpCollector {
  constructor({
    transport,
    sample,
    root,
    key,
    runId,
    allowLoginBootstrap = false,
    collectReceipt = true,
  }) {
    this.transport = transport;
    this.sample = sample;
    this.root = root;
    this.key = key;
    this.runId = runId;
    this.allowLoginBootstrap = allowLoginBootstrap === true;
    this.collectReceipt = collectReceipt !== false;
    this.index = 0;
    this.cookies = [];
    this.directory = `${root}/evidence/run-${runId}`;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  async request(url, method = 'GET', headers = {}, body = undefined) {
    try {
      const target = validateReadUrl(url, method, this.allowLoginBootstrap);
      writePrivate(
        `${this.directory}/request-${this.index + 1}.enc`,
        encrypt(
          {
            url: target.href,
            method,
            headers,
            body: body ?? null,
            observedAt: new Date().toISOString(),
          },
          this.key
        )
      );
      const response = await this.transport.request({ url: target.href, method, headers, body });
      if (response.url !== target.href) throw fault('UNEXPECTED_TRANSPORT_REDIRECT');
      const bytes = Buffer.from(response.bodyBase64, 'base64');
      const sha256 = hash(bytes);
      const file = `body-${++this.index}-${sha256.slice(0, 16)}.enc`;
      const observedAt = new Date().toISOString();
      writePrivate(`${this.directory}/${file}`, encrypt(bytes, this.key));
      writePrivate(`${this.directory}/response-${this.index}.enc`, encrypt(response, this.key));
      const source = {
        provider: 'Apple official website',
        status: response.status,
        contentType: header(response, 'content-type'),
        cached: false,
        host: target.hostname,
        path: safePath(target.pathname),
        urlHash: hash(target.href),
        observedAt,
        sha256,
        file,
        runId: this.runId,
      };
      fs.appendFileSync(
        `${this.directory}/events.jsonl`,
        `${JSON.stringify({
          message: 'http_response',
          method,
          bytes: bytes.length,
          ...source,
        })}\n`,
        { mode: 0o600 }
      );
      this.cookies = response.cookies || [];
      if ([401, 403, 407, 409, 412, 429, 541].includes(response.status) || response.status >= 500)
        throw Object.assign(fault(`HTTP_${response.status}`), {
          retryAfter: header(response, 'retry-after').slice(0, 128),
        });
      return { ...response, text: bytes.toString('utf8'), source };
    } catch (error) {
      error.component = 'officialOrderHttpCollector';
      throw error;
    }
  }

  async navigate(url) {
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const response = await this.request(url);
        if (!REDIRECT_STATUSES.includes(response.status)) return response;
        const location = header(response, 'location');
        if (!location) throw fault('REDIRECT_LOCATION_MISSING');
        const destination = permittedUrl(new URL(location, url).href);
        if (/\/signIn\/|\/signin|\/auth\//i.test(destination.pathname))
          throw fault('AUTHENTICATION_REQUIRED');
        validateReadUrl(destination.href);
        url = destination.href;
      }
      throw fault('REDIRECT_LIMIT');
    } catch (error) {
      error.component = 'officialOrderHttpCollector';
      throw error;
    }
  }

  hasShieldCookie(url) {
    const target = new URL(url);
    const host = target.hostname;
    return this.cookies.some(cookie => {
      const domain = String(cookie.domain || '').replace(/^\./, '');
      const path = cookie.path || '/';
      const pathMatches =
        target.pathname === path ||
        target.pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
      return (
        /^(?:[a-z0-9-]+\.)*apple\.com\.cn$/.test(domain) &&
        pathMatches &&
        cookie.name === 'shld_bt_ck' &&
        (host === domain || (cookie.hostOnly !== true && host.endsWith(`.${domain}`))) &&
        inspectShieldCookie(cookie).valid === true
      );
    });
  }

  async ensureShield(document, actionUrl = document.url) {
    try {
      if (permittedUrl(actionUrl).origin !== permittedUrl(document.url).origin)
        throw fault('SHIELD_ROUTE_INVALID');
      if (this.hasShieldCookie(actionUrl)) return;
      const url = discoverShieldUrl(document.text, document.url);
      const challenge = await this.request(url, 'GET', { Referer: document.url });
      if (challenge.status !== HTTP_OK) throw fault('SHIELD_RESPONSE_INVALID');
      const answer = solveShieldChallenge(challenge.text);
      if (!answer.found) throw fault('SHIELD_NOT_SOLVED');
      const model = JSON.parse(challenge.text);
      // 字段来自用户材料的原方法；实际接受必须由 Cookie 与后续完整详情共同证明。
      model.number = answer.number;
      model.took = answer.took;
      model.flagskv = { ...(model.flagskv || {}), patSkip: true };
      model.jsa = { s: 30, f: ['P'] };
      const contentType = Object.hasOwn(model, 'algorithm')
        ? 'text/plain;charset=UTF-8'
        : 'application/json; charset=UTF-8';
      const submitted = await this.request(
        url,
        'POST',
        {
          'Content-Type': contentType,
          Origin: new URL(url).origin,
          Referer: document.url,
        },
        JSON.stringify(model)
      );
      if (submitted.status !== HTTP_OK) throw fault('SHIELD_RESPONSE_INVALID');
      if (!this.hasShieldCookie(actionUrl)) throw fault('SHIELD_NOT_ACCEPTED');
    } catch (error) {
      error.component = 'officialOrderHttpCollector';
      throw error;
    }
  }

  async collect() {
    try {
      let response = await this.navigate(this.sample.url);
      if (response.status !== HTTP_OK) throw fault(`HTTP_${response.status}`);
      let detail = parseOfficialOrderDetail(response.text, this.sample.orderNumber);
      if (!detail) {
        const action = buildGuestActionRequest(
          response.text,
          {
            type: 'Document',
            ...response.source,
          },
          this.sample.orderNumber
        );
        if (!action) throw fault('NO_GUEST_ACTION');
        await this.ensureShield(response, action.url);
        response = await this.request(
          action.url,
          action.method,
          {
            ...action.headers,
            Origin: action.origin,
            Referer: response.url,
          },
          ''
        );
        if (response.status !== HTTP_OK) throw fault(`HTTP_${response.status}`);
        detail = parseOfficialOrderDetail(response.text, this.sample.orderNumber);
      }
      if (!detail) throw fault('NO_VALID_ORDER_DATA');
      const result = { systemOrderId: this.sample.id, ...detail, source: response.source };
      const resultFile = `${this.root}/private/results/order-${this.sample.id}-run-${this.runId}.json`;
      writePrivate(resultFile, JSON.stringify(result));
      if (!this.collectReceipt)
        return {
          outcome: 'SUCCEEDED',
          orderId: this.sample.id,
          runId: this.runId,
          resultFile,
          receiptOutcome: 'RECEIPT_NOT_REQUESTED',
        };
      let receiptOutcome;
      try {
        const receiptUrl = extractOfficialReceiptUrl(
          response.text,
          this.sample.orderNumber,
          response.source.host
        );
        const receipt = await this.request(receiptUrl.href);
        if (REDIRECT_STATUSES.includes(receipt.status))
          throw fault('RECEIPT_AUTHENTICATION_REQUIRED');
        if (receipt.status !== HTTP_OK) throw fault(`HTTP_${receipt.status}`);
        const quantity = detail.products.reduce((sum, product) => sum + product.quantity, 0);
        const parsed = parseOfficialReceipt(receipt.text, this.sample.orderNumber, quantity);
        writePrivate(
          `${this.root}/private/http-receipt-${this.sample.id}-run-${this.runId}.json`,
          JSON.stringify({
            systemOrderId: this.sample.id,
            detailRun: this.runId,
            detailSha256: response.source.sha256,
            urlHash: hash(receiptUrl.href),
            source: receipt.source,
            parsed,
            egressVerifiedAfter: false,
          })
        );
        receiptOutcome = 'RECEIPT_VERIFIED';
      } catch (error) {
        receiptOutcome = /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'RECEIPT_FAILED';
        if (
          [
            'HTTP_429',
            'HTTP_541',
            'HTTP_407',
            'REQUEST_BUDGET',
            'TIME_BUDGET',
            'PROXY_CONNECTION_FAILED',
          ].includes(receiptOutcome)
        ) {
          error.detailResultFile = resultFile;
          throw error;
        }
      }
      return {
        outcome: 'SUCCEEDED',
        orderId: this.sample.id,
        runId: this.runId,
        resultFile,
        receiptOutcome,
      };
    } catch (error) {
      error.component = 'officialOrderHttpCollector';
      throw error;
    }
  }
}

module.exports = { OfficialOrderHttpCollector, discoverShieldUrl, validateReadUrl };
