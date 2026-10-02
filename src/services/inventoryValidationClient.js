const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const {
  classifyResponse,
  retryAfterMs,
  parsePickupResponse,
} = require('./inventoryValidationPolicy');

/** 固定目标白名单，不允许凭据出现在目标 URL。 */
function targetFor(purpose, context) {
  if (purpose === 'connect') return 'https://api.ipify.org?format=json';
  if (purpose === 'catalog') {
    if (
      !/^\/(?:shop\/buy-iphone(?:\/[a-z0-9-]+)?|retail\/(?:storelist|[a-z0-9-]+)\/)$/.test(
        context.path || ''
      )
    )
      throw new Error('INVALID_CATALOG_PATH');
    return `https://www.apple.com.cn${context.path}`;
  }
  if (purpose === 'inventory') {
    if (
      !Array.isArray(context.skus) ||
      !context.skus.length ||
      context.skus.length > 5 ||
      context.skus.some(s => !/^[A-Z0-9]{5,12}CH\/A$/.test(s)) ||
      !/^\d{6}$/.test(context.location)
    )
      throw new Error('INVALID_INVENTORY_INPUT');
    const parts = context.skus.map((s, i) => `parts.${i}=${s}`).join('&');
    return `https://www.apple.com.cn/shop/retail/pickup-message?${parts}&location=${context.location}`;
  }
  throw new Error('INVALID_PURPOSE');
}

/** 仅从本地私密文件读取已授权的单一出口；不自动提取／采购／直连。 */
function readProxy(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[a-z0-9-]{1,40}$/.test(value.label) || typeof value.url !== 'string')
    throw new Error('INVALID_PROXY_CONFIG');
  const url = new URL(value.url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.username ||
    !url.password
  )
    throw new Error('INVALID_PROXY_CONFIG');
  return { label: value.label, url: value.url };
}

/** 创建保持 TLS 校验的代理 Agent。 */
async function createProxyAgent(url) {
  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    return new HttpsProxyAgent(url);
  } catch (_error) {
    throw new Error('PROXY_AGENT_SETUP_FAILED');
  }
}

/** 单次有界请求；由 gate 统一记录限流、失败与预算，不做隐含重试。 */
async function requestOnce({
  purpose,
  context,
  proxy,
  gate,
  request = axios.get,
  createAgent = createProxyAgent,
}) {
  let result;
  let agent;
  try {
    const url = targetFor(purpose, context);
    agent = await createAgent(proxy.url);
    let tunnelStatus;
    agent.on('proxyConnect', response => {
      tunnelStatus = response.statusCode;
    });
    let permit = await gate.reserve(purpose, proxy.label, context);
    if (permit.waitMs && permit.waitMs <= 2000) {
      await new Promise(resolve => setTimeout(resolve, permit.waitMs));
      permit = await gate.reserve(purpose, proxy.label, context);
    }
    if (!permit.id)
      return { outcome: permit.blocked || 'REQUEST_IN_FLIGHT', until: permit.until || null };
    const started = Date.now();
    result = {
      id: permit.id,
      egress: proxy.label,
      outcome: 'TRANSPORT_UNKNOWN',
      durationMs: 0,
      bytes: 0,
    };
    let response;
    try {
      response = await request(url, {
        httpsAgent: agent,
        proxy: false,
        maxRedirects: 0,
        timeout: 20000,
        responseType: 'text',
        maxContentLength: 5 * 1024 * 1024,
        validateStatus: () => true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
          Accept: purpose === 'catalog' ? 'text/html' : 'application/json',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: 'https://www.apple.com.cn/shop/buy-iphone',
        },
      });
    } catch (error) {
      const status = error.response?.status;
      result.status = Number.isInteger(status) ? status : undefined;
      result.outcome =
        status === 200 ? 'RESPONSE_READ_FAILED' : classifyResponse(status, '', error.code);
      const errorCodes = [
        'ERR_BAD_RESPONSE',
        'ERR_BAD_REQUEST',
        'ECONNRESET',
        'ECONNABORTED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNREFUSED',
        'ERR_TLS_CERT_ALTNAME_INVALID',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      ];
      result.summary = { transportCode: errorCodes.includes(error.code) ? error.code : 'OTHER' };
      if (/maxContentLength|larger than/.test(error.message || ''))
        result.summary.transportReason = 'RESPONSE_TOO_LARGE';
      else if (
        /decompress|incorrect header|unexpected end|invalid distance|invalid block/.test(
          error.message || ''
        )
      )
        result.summary.transportReason = 'DECOMPRESSION_FAILED';
      else if (/stream.*abort|socket hang up/.test(error.message || ''))
        result.summary.transportReason = 'STREAM_INTERRUPTED';
    }
    result.durationMs = Date.now() - started;
    let evidence;
    if (response) {
      result.status = response.status;
      result.bytes = Buffer.byteLength(response.data || '', 'utf8');
      result.outcome = classifyResponse(response.status, response.headers['content-type'] || '');
      result.retryMs = retryAfterMs(response.headers['retry-after'], Date.now());
      if (response.status === 200) {
        try {
          if (purpose === 'catalog') {
            if (!response.data.includes('<html') || !response.data.includes('Apple'))
              throw new Error();
            result.outcome = 'CATALOG_RECEIVED';
            evidence = response.data;
          } else if (purpose === 'connect') {
            const data = JSON.parse(response.data);
            if (typeof data.ip !== 'string' || !require('net').isIP(data.ip)) throw new Error();
            result.outcome = 'PROXY_CONNECTED';
            result.summary = {
              egressHash: crypto.createHash('sha256').update(data.ip).digest('hex'),
            };
          } else {
            const rows = parsePickupResponse(JSON.parse(response.data), context.skus);
            result.summary = {
              rows: rows.length,
              valid: rows.filter(r => r.status !== 'unknown').length,
              inStock: rows.filter(r => r.status === 'in_stock').length,
              unknown: rows.filter(r => r.status === 'unknown').length,
            };
            result.outcome = result.summary.unknown ? 'PARTIAL_RESPONSE' : 'INVENTORY_VALID';
            evidence = rows;
          }
        } catch (_error) {
          result.outcome = 'INVALID_RESPONSE';
          // 仅保存结构诊断和摘要，不保存未识别的响应正文或原始异常。
          let payload;
          try {
            payload = JSON.parse(response.data);
          } catch (_parseError) {
            payload = null;
          }
          const reasons = [
            'INVALID_SKU',
            'INVALID_STORES',
            'INVALID_STORE',
            'CONFLICTING_DUPLICATE_STORE',
          ];
          result.summary = {
            invalidReason: reasons.includes(_error.message) ? _error.message : 'INVALID_BODY',
            bodyHash: crypto
              .createHash('sha256')
              .update(response.data || '')
              .digest('hex'),
            format: payload ? 'json' : /<html/i.test(response.data || '') ? 'html' : 'other',
            headStatus: Number.isInteger(payload?.head?.status) ? payload.head.status : null,
            hasStores: Array.isArray(payload?.body?.stores),
            storeCount: Array.isArray(payload?.body?.stores) ? payload.body.stores.length : null,
          };
        }
      }
    }
    if (tunnelStatus !== undefined) {
      result.summary = { ...result.summary, tunnelStatus };
      if (tunnelStatus !== 200) {
        result.status = tunnelStatus;
        result.outcome = tunnelStatus === 407 ? 'PROXY_AUTH_FAILED' : 'PROXY_CONNECT_REJECTED';
        result.summary.responseSource = 'proxy_connect';
        delete result.retryMs;
        evidence = undefined;
      } else {
        result.summary.responseSource = 'target';
      }
    }
    await gate.finish(result);
    return { ...result, evidence };
  } catch (_error) {
    // 不把 Axios／代理异常、请求对象或连接参数传播给 CLI 日志。
    throw new Error(result ? 'VALIDATION_PERSISTENCE_FAILED' : 'VALIDATION_SETUP_FAILED');
  } finally {
    agent?.destroy();
  }
}

module.exports = { targetFor, readProxy, requestOnce };
