const cheerio = require('cheerio');
const { OfficialOrderHttpCollector } = require('./officialOrderHttpCollector');
const { fault, permittedUrl } = require('./officialOrderSupport');

const ACCOUNT_ENTRY = 'https://www.apple.com.cn/shop/goto/account';
// run-901 的官方 303 Location；仅接受此无查询、无片段的精确中间入口。
const ACCOUNT_REDIRECT_ENTRY = 'https://www.apple.com.cn/cn/shop/go/account';
// run-918/926 的官方账户首页及数字分片；仍须追随服务端登录入口。
const ACCOUNT_HOME_ENTRY = /^https:\/\/secure\d*\.www\.apple\.com\.cn\/shop\/account\/home$/;
const ACCOUNT_ENTRIES = new Set([ACCOUNT_ENTRY, ACCOUNT_REDIRECT_ENTRY]);
const MAX_REDIRECTS = 8;
const MAX_COOKIES = 256;
const MAX_COOKIE_TEXT = 8192;
const HTTP_OK = 200;
const MILLISECONDS_PER_SECOND = 1000;
const REDIRECT_STATUS = Object.freeze({
  movedPermanently: 301,
  found: 302,
  seeOther: 303,
  temporaryRedirect: 307,
  permanentRedirect: 308,
});
const REDIRECTS = new Set(Object.values(REDIRECT_STATUS));
const COOKIE_FIELDS = ['name', 'value', 'path', 'expires', 'secure'];
const SAME_SITE = new Set(['Strict', 'Lax', 'None']);
// Cookie 控制字符不是凭据内容的一部分。
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function isAccountEntry(value) {
  return ACCOUNT_ENTRIES.has(value) || ACCOUNT_HOME_ENTRY.test(value);
}

/** 仅允许既有账户入口和本次响应明确给出的中国官网登录文档。 */
function loginBootstrapUrl(value) {
  const url = permittedUrl(value);
  if (
    url.href.includes('#') ||
    (!isAccountEntry(url.href) &&
      (!/^secure\d*\.www\.apple\.com\.cn$/.test(url.hostname) ||
        !['/shop/signIn', '/shop/signIn/account'].includes(url.pathname)))
  )
    throw fault('BOOTSTRAP_DESTINATION_DENIED');
  return url;
}

/** 转换服务器当前 Cookie，不将引导 Cookie 当作已认证会话。结果只能在私密内存使用。 */
function browserBootstrapCookies(cookies) {
  if (!Array.isArray(cookies) || !cookies.length || cookies.length > MAX_COOKIES)
    throw fault('BOOTSTRAP_COOKIES_INVALID');
  return cookies.map(cookie => {
    const domain = String(cookie?.domain || '').replace(/^\./, '');
    if (
      !cookie ||
      !/^(?:[a-z0-9-]+\.)*apple\.com\.cn$/.test(domain) ||
      typeof cookie.name !== 'string' ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) ||
      typeof cookie.value !== 'string' ||
      cookie.value.length > MAX_COOKIE_TEXT ||
      CONTROL.test(cookie.value) ||
      typeof cookie.path !== 'string' ||
      !cookie.path.startsWith('/') ||
      CONTROL.test(cookie.path) ||
      !Number.isFinite(cookie.expires) ||
      (cookie.expires !== -1 && cookie.expires <= Date.now() / MILLISECONDS_PER_SECOND) ||
      typeof cookie.secure !== 'boolean' ||
      typeof cookie.hostOnly !== 'boolean' ||
      (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== 'boolean') ||
      (cookie.sameSite !== undefined && !SAME_SITE.has(cookie.sameSite))
    )
      throw fault('BOOTSTRAP_COOKIES_INVALID');
    const result = Object.fromEntries(COOKIE_FIELDS.map(name => [name, cookie[name]]));
    result.domain = cookie.hostOnly ? domain : `.${domain}`;
    if (cookie.httpOnly !== undefined) result.httpOnly = cookie.httpOnly;
    if (cookie.sameSite !== undefined) result.sameSite = cookie.sameSite;
    return result;
  });
}

function locationHeader(response) {
  const entry = Object.entries(response.headers || {}).find(
    ([key]) => key.toLowerCase() === 'location'
  );
  return entry?.[1];
}

/**
 * 在调用方已打开的同一 gate/run/代理上完成登录页前置读取，不创建新运行或提交认证。
 * @param {object} options 现有私密传输会话、目标、证据目录、密钥与运行号。
 * @returns {Promise<object>} 私密 Cookie 和当前登录页 URL；不表示登录或订单成功。
 */
async function bootstrapOfficialOrderHttp({ transport, sample, root, key, runId }) {
  try {
    if (
      !transport?.gate ||
      Number(transport.gate.id) !== Number(runId) ||
      !Number.isSafeInteger(Number(runId)) ||
      Number(runId) <= 0 ||
      transport.gate.accountHash !== sample?.accountHash ||
      !/^[a-f0-9]{64}$/.test(sample?.accountHash || '')
    )
      throw fault('BOOTSTRAP_GATE_MISMATCH');
    const collector = new OfficialOrderHttpCollector({
      transport,
      sample,
      root,
      key,
      runId,
      allowLoginBootstrap: true,
    });
    let url = ACCOUNT_ENTRY;
    const visited = new Set();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      loginBootstrapUrl(url);
      if (visited.has(url)) throw fault('BOOTSTRAP_REDIRECT_LOOP');
      visited.add(url);
      const response = await collector.request(url, 'GET');
      if (REDIRECTS.has(response.status)) {
        const location = locationHeader(response);
        if (typeof location !== 'string' || !location) throw fault('REDIRECT_LOCATION_MISSING');
        url = loginBootstrapUrl(new URL(location, url).href).href;
        continue;
      }
      if (response.status !== HTTP_OK) throw fault(`HTTP_${response.status}`);
      if (isAccountEntry(url)) {
        const $ = cheerio.load(response.text);
        const links = new Set();
        for (const node of $('a[href]').toArray()) {
          try {
            const candidate = loginBootstrapUrl(new URL($(node).attr('href'), url).href);
            if (!isAccountEntry(candidate.href)) links.add(candidate.href);
          } catch (_error) {
            // 普通帮助/商品链接不构成可导航的登录入口。
          }
        }
        if (links.size !== 1) throw fault('BOOTSTRAP_LOGIN_LINK_AMBIGUOUS');
        [url] = links;
        continue;
      }
      await collector.ensureShield(response, url);
      if (!collector.hasShieldCookie(url)) throw fault('SHIELD_NOT_ACCEPTED');
      return {
        outcome: 'HTTP_LOGIN_BOOTSTRAP_READY',
        loginPageUrl: url,
        cookies: browserBootstrapCookies(collector.cookies),
        source: response.source,
      };
    }
    throw fault('BOOTSTRAP_REDIRECT_LIMIT');
  } catch (error) {
    error.component = 'officialOrderHttpBootstrap';
    throw error;
  }
}

module.exports = { bootstrapOfficialOrderHttp, loginBootstrapUrl, browserBootstrapCookies };
