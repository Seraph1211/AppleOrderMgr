/* eslint-disable no-magic-numbers -- CLI 解析下标、HTTP 范围和文件权限属于结构常量。 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const axios = require('axios');
const cheerio = require('cheerio');

const { removeControlCharacters } = require('../src/utils/helpers');

process.env.LOG_TO_FILES = 'false';
process.env.LOG_LEVEL = 'error';

const DEFAULT_OUTPUT_ROOT = path.resolve(__dirname, '../test-artifacts/order-lifecycle');
const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 60;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30000;
const APPLE_HOME_URL = 'https://www.apple.com.cn/';
const HIDDEN_SELECTORS = [
  'script',
  'style',
  'template',
  'noscript',
  'footer',
  '[hidden]',
  '[aria-hidden="true"]',
  '[style*="display:none"]',
  '[style*="display: none"]',
].join(', ');
const SENSITIVE_KEY_PATTERN = new RegExp(
  [
    'address',
    'apple.?id',
    'barcode',
    'contact',
    'email',
    'first.?name',
    'last.?name',
    'name',
    'order.?number',
    'password',
    'phone',
    'pickup.?code',
    'postal',
    'recipient',
    'security',
    'stk',
    'token',
    'url',
  ].join('|'),
  'i'
);

/** @returns {Promise<string>} 读取标准输入。 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let content = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      content += chunk;
    });
    process.stdin.on('end', () => resolve(content));
    process.stdin.on('error', reject);
  });
}

/**
 * 读取命令行参数。
 * @param {string[]} argv - 命令行参数
 * @returns {Object} 参数对象
 */
function parseArguments(argv) {
  const values = {};
  const flags = new Set();
  argv.forEach(argument => {
    if (!argument.startsWith('--')) return;
    const separatorIndex = argument.indexOf('=');
    if (separatorIndex === -1) {
      flags.add(argument.slice(2));
      return;
    }
    values[argument.slice(2, separatorIndex)] = argument.slice(separatorIndex + 1);
  });
  return { values, flags };
}

/**
 * 校验 Apple 中国订单查询链接并提取身份。
 * @param {string} orderUrl - 订单查询链接
 * @returns {{orderNumber:string,appleId:string,url:URL}} 订单身份
 */
function parseOrderIdentity(orderUrl) {
  const parsed = new URL(String(orderUrl || '').trim());
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const validPath =
    parts.length === 5 && parts[0] === 'xc' && parts[1] === 'cn' && parts[2] === 'vieworder';
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'www.apple.com.cn' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    !validPath ||
    !/^W\d{10}$/.test(parts[3]) ||
    !parts[4]
  ) {
    throw new Error('订单 URL 格式或来源无效');
  }
  return { orderNumber: parts[3], appleId: parts[4], url: parsed };
}

/**
 * 生成不包含明文身份的订单指纹。
 * @param {{orderNumber:string,appleId:string}} identity - 订单身份
 * @returns {string} 短指纹
 */
function createOrderFingerprint(identity) {
  return crypto
    .createHash('sha256')
    .update(`${identity.orderNumber}\n${identity.appleId.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 校验目录或标签片段，阻止路径穿越。
 * @param {string} value - 原始值
 * @param {string} fieldName - 字段名
 * @returns {string} 安全值
 */
function validateSafeSegment(value, fieldName) {
  const normalized = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(normalized)) {
    throw new Error(`${fieldName} 只能包含字母、数字、下划线和短横线`);
  }
  return normalized;
}

/**
 * 将代理配置标准化为网帆国内隧道格式。
 * @param {Object} input - 输入配置
 * @returns {Object} 标准配置
 */
function normalizeProxyConfig(input = {}) {
  const proxy = input.proxy || input.fanproxyTunnel || {};
  const normalized = {
    host: proxy.host || process.env.FANPROXY_TUNNEL_HOST,
    backupHost: proxy.backupHost || process.env.FANPROXY_TUNNEL_BACKUP_HOST || null,
    port: Number(proxy.port || process.env.FANPROXY_TUNNEL_PORT),
    account: proxy.account || process.env.FANPROXY_TUNNEL_ACCOUNT,
    password: proxy.password || process.env.FANPROXY_TUNNEL_PASSWORD,
    country: String(proxy.country || process.env.FANPROXY_TUNNEL_COUNTRY || 'CN').toUpperCase(),
    region: proxy.region || process.env.FANPROXY_TUNNEL_REGION || null,
  };
  if (
    !normalized.host ||
    !Number.isInteger(normalized.port) ||
    !normalized.account ||
    !normalized.password
  ) {
    throw new Error('网帆国内隧道配置不完整');
  }
  return normalized;
}

/**
 * 脱敏字符串。
 * @param {unknown} value - 原始值
 * @param {string[]} secretValues - 已知敏感值
 * @returns {unknown} 脱敏值
 */
function redactValue(value, secretValues = []) {
  if (typeof value !== 'string') return value;
  let redacted = value;
  secretValues
    .filter(secret => typeof secret === 'string' && secret.length >= 3)
    .sort((left, right) => right.length - left.length)
    .forEach(secret => {
      redacted = redacted.split(secret).join('[REDACTED]');
    });
  return redacted
    .replace(/https:\/\/secure\d+\.www\.apple\.com\.cn/gi, 'https://secure*.www.apple.com.cn')
    .replace(
      /https:\/\/www\.apple\.com\.cn\/xc\/cn\/vieworder\/[^\s"'<>]+/gi,
      '[REDACTED_ORDER_URL]'
    )
    .replace(/W\d{10}/g, '[REDACTED_ORDER_NUMBER]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[REDACTED_PHONE]');
}

/**
 * 收集 JSON 中敏感键对应的字符串值，供 HTML 脱敏。
 * @param {unknown} value - JSON 值
 * @param {string} keyPath - 当前路径
 * @param {Set<string>} secrets - 结果集合
 * @returns {Set<string>} 敏感值集合
 */
function collectSecretValues(value, keyPath = '$', secrets = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSecretValues(item, `${keyPath}[${index}]`, secrets));
    return secrets;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      const childPath = `${keyPath}.${key}`;
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof child === 'string' && child.length >= 3) {
        secrets.add(child);
      }
      collectSecretValues(child, childPath, secrets);
    });
  }
  return secrets;
}

/**
 * 展开 JSON 叶子字段，保留字段可用性和脱敏值。
 * @param {unknown} value - JSON 值
 * @param {string} keyPath - 当前路径
 * @param {string[]} secretValues - 敏感值
 * @param {Object[]} result - 结果数组
 * @returns {Object[]} 字段清单
 */
function flattenJson(value, keyPath = '$', secretValues = [], result = []) {
  if (Array.isArray(value)) {
    if (value.length === 0) result.push({ path: keyPath, type: 'array', value: [] });
    value.forEach((item, index) => flattenJson(item, `${keyPath}[${index}]`, secretValues, result));
    return result;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) result.push({ path: keyPath, type: 'object', value: {} });
    entries.forEach(([key, child]) => {
      const childPath = `${keyPath}.${key}`;
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result.push({
          path: childPath,
          type: child === null ? 'null' : Array.isArray(child) ? 'array' : typeof child,
          value: child === null ? null : '[REDACTED]',
        });
        return;
      }
      flattenJson(child, childPath, secretValues, result);
    });
    return result;
  }
  result.push({
    path: keyPath,
    type: value === null ? 'null' : typeof value,
    value: redactValue(value, secretValues),
  });
  return result;
}

/**
 * 生成元素的近似 CSS 路径。
 * @param {Object} element - Cheerio 元素
 * @param {Function} $ - Cheerio 实例
 * @returns {string} 路径
 */
function createElementPath(element, $) {
  const segments = [];
  let current = element;
  while (current && current.type === 'tag' && segments.length < 8) {
    const node = $(current);
    let segment = current.name;
    const id = node.attr('id');
    if (id) {
      segments.unshift(`${segment}#${id}`);
      break;
    }
    const className = String(node.attr('class') || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join('.');
    if (className) segment += `.${className}`;
    const siblings = node.parent().children(current.name);
    if (siblings.length > 1) segment += `:nth-of-type(${siblings.index(current) + 1})`;
    segments.unshift(segment);
    current = current.parent;
  }
  return segments.join(' > ');
}

/**
 * 收集可见 DOM 中的文本节点和业务相关属性。
 * @param {string} html - 页面 HTML
 * @param {string[]} secretValues - 敏感值
 * @returns {Object[]} DOM 清单
 */
function collectDomInventory(html, secretValues) {
  const $ = cheerio.load(html);
  const body = $('body').clone();
  body.find(HIDDEN_SELECTORS).remove();
  const inventory = [];
  body.find('*').each((_index, element) => {
    const node = $(element);
    const directText = node
      .contents()
      .filter((_childIndex, child) => child.type === 'text')
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const attributes = {};
    Object.entries(element.attribs || {}).forEach(([key, value]) => {
      if (/^(?:id|class|href|datetime|title|role|aria-|data-)/i.test(key)) {
        attributes[key] = redactValue(value, secretValues);
      }
    });
    if (!directText && Object.keys(attributes).length === 0) return;
    inventory.push({
      selector: createElementPath(element, $),
      tag: element.name,
      attributes,
      text: redactValue(directText, secretValues),
    });
  });
  return inventory;
}

/**
 * 从 HTML 中提取订单 JSON。
 * @param {string} html - 页面 HTML
 * @returns {Object} 订单 JSON
 */
function extractOrderJson(html) {
  const $ = cheerio.load(html);
  let orderJson = null;
  $('script').each((_index, element) => {
    const scriptContent = $(element).html();
    if (!scriptContent || !scriptContent.includes('orderItem-')) return;
    try {
      orderJson = JSON.parse(
        removeControlCharacters(scriptContent.trim()).replace(/[\n\r\t]/g, ' ')
      );
      return false;
    } catch (_error) {
      return undefined;
    }
  });
  if (!orderJson) throw new Error('页面中未找到可解析的订单 JSON');
  return orderJson;
}

/**
 * 生成字段可用性摘要。
 * @param {Object[]} jsonInventory - JSON 字段清单
 * @param {Object[]} domInventory - DOM 清单
 * @returns {Object} 摘要
 */
function createAvailabilitySummary(jsonInventory, domInventory) {
  return {
    jsonLeafPaths: jsonInventory.map(item => item.path).sort(),
    jsonNonNullPaths: jsonInventory
      .filter(item => item.value !== null && item.value !== '' && item.value !== undefined)
      .map(item => item.path)
      .sort(),
    domSelectors: [...new Set(domInventory.map(item => item.selector))].sort(),
    domTextSelectors: [
      ...new Set(domInventory.filter(item => item.text).map(item => item.selector)),
    ].sort(),
  };
}

/**
 * 比较两次字段可用性。
 * @param {Object|null} previous - 上一次摘要
 * @param {Object} current - 当前摘要
 * @returns {Object} 差异
 */
function compareAvailability(previous, current) {
  if (!previous) {
    return {
      firstObservation: true,
      addedJsonPaths: current.jsonLeafPaths,
      removedJsonPaths: [],
      addedDomSelectors: current.domSelectors,
      removedDomSelectors: [],
    };
  }
  const difference = (left, right) => left.filter(item => !new Set(right).has(item));
  return {
    firstObservation: false,
    addedJsonPaths: difference(current.jsonLeafPaths, previous.jsonLeafPaths),
    removedJsonPaths: difference(previous.jsonLeafPaths, current.jsonLeafPaths),
    addedDomSelectors: difference(current.domSelectors, previous.domSelectors),
    removedDomSelectors: difference(previous.domSelectors, current.domSelectors),
  };
}

/**
 * 确保私有目录存在。
 * @param {string} directory - 目录
 * @returns {void}
 */
function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

/**
 * 写入权限为 0600 的文件。
 * @param {string} filePath - 文件路径
 * @param {string} content - 文件内容
 * @returns {void}
 */
function writePrivateFile(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

/**
 * 追加权限为 0600 的 NDJSON。
 * @param {string} filePath - 文件路径
 * @param {Object} value - 记录
 * @returns {void}
 */
function appendPrivateJson(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

/**
 * 从上一次摘要读取字段可用性。
 * @param {string} sessionDirectory - 会话目录
 * @returns {Object|null} 上一次摘要
 */
function readPreviousSummary(sessionDirectory) {
  const filePath = path.join(sessionDirectory, 'latest-summary.json');
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 通过网帆国内隧道发起只读 GET。
 * @param {string} targetUrl - 目标 URL
 * @param {Object} proxy - 代理配置
 * @returns {Promise<Object>} HTTP 响应
 */
async function fetchThroughProxy(targetUrl, proxy) {
  try {
    return await axios.get(targetUrl, {
      headers: {
        'User-Agent': [
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
        ].join(' '),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip',
        Connection: 'close',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 10,
      responseType: 'text',
      proxy: {
        host: proxy.host,
        port: proxy.port,
        protocol: 'http',
        auth: proxy.auth,
      },
      validateStatus: status => status >= 200 && status < 400,
    });
  } catch (error) {
    const status = error.response?.status;
    const safeError = new Error(status ? `HTTP_${status}` : error.code || 'PROXY_REQUEST_FAILED');
    safeError.code = error.code;
    safeError.httpStatus = status;
    throw safeError;
  }
}

/**
 * 最多三次请求，每次使用新 sid。
 * @param {string} targetUrl - 目标 URL
 * @param {Object} provider - 网帆 Provider
 * @returns {Promise<{response:Object,attempt:number}>} 成功响应
 */
async function fetchWithRetry(targetUrl, provider) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const proxy = provider.getNextProxy();
      if (!proxy) throw new Error('网帆隧道未初始化');
      const response = await fetchThroughProxy(targetUrl, proxy);
      return { response, attempt };
    } catch (error) {
      lastError = error;
      if (error.httpStatus === 407) break;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1000 + 250));
      }
    }
  }
  throw lastError;
}

/**
 * 构造网帆 Provider。
 * @param {Object} config - 标准配置
 * @returns {Object} Provider
 */
function createProvider(config) {
  try {
    const hosts = [...new Set([config.host, config.backupHost].filter(Boolean))];
    let hostIndex = 0;
    if (hosts.length === 0) throw new Error('缺少隧道入口');
    return {
      getNextProxy() {
        const parameters = ['acc', config.account];
        if (config.region) parameters.push('cty', config.country, 'reg', config.region);
        parameters.push('sid', crypto.randomBytes(6).toString('hex'));
        const host = hosts[hostIndex];
        hostIndex = (hostIndex + 1) % hosts.length;
        return {
          host,
          port: config.port,
          auth: { username: parameters.join('-'), password: config.password },
          provider: 'fanproxy_tunnel',
        };
      },
    };
  } catch (error) {
    throw new Error(`网帆 Provider 初始化失败: ${error.message}`);
  }
}

/**
 * 使用当前系统解析器生成对照结果，不执行数据库写入。
 * @param {Object} orderJson - 官网 JSON
 * @param {string} html - 官网 HTML
 * @param {Object} identity - 订单身份
 * @returns {Object} 当前系统解析结果
 */
function parseWithCurrentSystem(orderJson, html, identity) {
  const logger = require('../src/utils/logger');
  logger.silent = true;
  const crawlerService = require('../src/services/crawlerService');
  const parsed = crawlerService.parseOrderData(orderJson, html);
  crawlerService.validateCrawledOrderIdentity(parsed, identity.orderNumber);
  return {
    orderStatus: parsed.orderStatus,
    paymentStatus: parsed.paymentStatus,
    pickupStatus: parsed.pickupStatus,
    orderDate: parsed.orderDate,
    officialOrderCreatedAt: parsed.officialOrderCreatedAt,
    productCount: parsed.products.length,
    products: parsed.products,
    pickupStore: parsed.pickupStore ? '[PRESENT_REDACTED]' : null,
    storeDirectionsUrl: parsed.storeDirectionsUrl ? '[PRESENT_REDACTED]' : null,
    officialOrderAmount: parsed.officialOrderAmount,
    officialOrderAmountCurrency: parsed.officialOrderAmountCurrency,
    officialOrderAmountParseError: parsed.officialOrderAmountParseError,
  };
}

/**
 * 执行一次订单快照。
 * @param {Object} context - 运行上下文
 * @returns {Promise<Object>} 脱敏摘要
 */
async function captureOnce(context) {
  try {
    const { orderUrl, identity, provider, sessionDirectory, stage, orderFingerprint } = context;
    const observedAt = new Date().toISOString();
    const { response, attempt } = await fetchWithRetry(orderUrl, provider);
    const html = String(response.data || '');
    const orderJson = extractOrderJson(html);
    const returnedOrderNumber = orderJson.orderDetail?.orderHeader?.d?.orderNumber;
    if (returnedOrderNumber !== identity.orderNumber) throw new Error('官网返回订单身份不匹配');

    const secretValues = [
      identity.orderNumber,
      identity.appleId,
      ...collectSecretValues(orderJson),
    ];
    const jsonInventory = flattenJson(orderJson, '$', secretValues);
    const domInventory = collectDomInventory(html, secretValues);
    const availability = createAvailabilitySummary(jsonInventory, domInventory);
    const currentSystem = parseWithCurrentSystem(orderJson, html, identity);
    const visibleText = domInventory
      .map(item => item.text)
      .filter(Boolean)
      .join(' ');
    const semanticJsonInventory = jsonInventory.filter(item => !item.path.startsWith('$.meta.'));
    const semanticFingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({ jsonInventory: semanticJsonInventory, visibleText }))
      .digest('hex');
    const previous = readPreviousSummary(sessionDirectory);
    const changed = previous?.semanticFingerprint !== semanticFingerprint;
    const finalUrl = response.request?.res?.responseUrl || orderUrl;
    const summary = {
      schemaVersion: 1,
      observedAt,
      stage,
      orderFingerprint,
      provider: 'fanproxy_tunnel',
      request: {
        attempt,
        responseStatus: response.status,
        finalUrl: redactValue(finalUrl, secretValues),
        contentType: response.headers?.['content-type'] || null,
        contentLength: Buffer.byteLength(html),
      },
      currentSystem,
      semanticFingerprint,
      changed,
      counts: {
        jsonLeafFields: jsonInventory.length,
        jsonNonNullFields: availability.jsonNonNullPaths.length,
        domEntries: domInventory.length,
        domTextEntries: availability.domTextSelectors.length,
      },
      availability,
      availabilityDiff: compareAvailability(previous?.availability || null, availability),
    };

    if (changed) {
      const timestamp = observedAt.replace(/[:.]/g, '-');
      const snapshotDirectory = path.join(
        sessionDirectory,
        `${timestamp}-${semanticFingerprint.slice(0, 8)}`
      );
      ensurePrivateDirectory(snapshotDirectory);
      writePrivateFile(path.join(snapshotDirectory, '原始页面.html'), html);
      writePrivateFile(
        path.join(snapshotDirectory, '原始订单数据.json'),
        `${JSON.stringify(orderJson, null, 2)}\n`
      );
      writePrivateFile(
        path.join(snapshotDirectory, '脱敏DOM清单.json'),
        `${JSON.stringify(domInventory, null, 2)}\n`
      );
      writePrivateFile(
        path.join(snapshotDirectory, '脱敏JSON字段清单.json'),
        `${JSON.stringify(jsonInventory, null, 2)}\n`
      );
      writePrivateFile(
        path.join(snapshotDirectory, '脱敏摘要.json'),
        `${JSON.stringify(summary, null, 2)}\n`
      );
      writePrivateFile(
        path.join(sessionDirectory, 'latest-summary.json'),
        `${JSON.stringify(summary, null, 2)}\n`
      );
      summary.snapshotDirectory = snapshotDirectory;
    }
    appendPrivateJson(path.join(sessionDirectory, 'polls.ndjson'), {
      observedAt,
      stage,
      orderFingerprint,
      semanticFingerprint,
      changed,
      attempt,
      responseStatus: response.status,
      orderStatus: currentSystem.orderStatus,
      paymentStatus: currentSystem.paymentStatus,
      pickupStatus: currentSystem.pickupStatus,
    });
    return summary;
  } catch (error) {
    throw new Error(`订单观测失败: ${error.message}`);
  }
}

/**
 * 输出不含订单和代理明文的运行结果。
 * @param {Object} summary - 观测摘要
 * @returns {void}
 */
function printSafeSummary(summary) {
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      observedAt: summary.observedAt,
      stage: summary.stage,
      orderFingerprint: summary.orderFingerprint,
      provider: summary.provider,
      changed: summary.changed,
      attempt: summary.request.attempt,
      responseStatus: summary.request.responseStatus,
      currentSystem: {
        orderStatus: summary.currentSystem.orderStatus,
        paymentStatus: summary.currentSystem.paymentStatus,
        pickupStatus: summary.currentSystem.pickupStatus,
      },
      counts: summary.counts,
      snapshotDirectory: summary.snapshotDirectory || null,
    })}\n`
  );
}

/**
 * 执行一次观测并输出脱敏结果；持续模式下保留失败记录后继续。
 * @param {Object} context - 运行上下文
 * @param {boolean} continueOnFailure - 失败后是否继续
 * @returns {Promise<boolean>} 是否成功
 */
async function captureAndReport(context, continueOnFailure) {
  try {
    const summary = await captureOnce(context);
    printSafeSummary(summary);
    return true;
  } catch (error) {
    const failedAt = new Date().toISOString();
    const safeFailure = {
      observedAt: failedAt,
      stage: context.stage,
      orderFingerprint: context.orderFingerprint,
      provider: 'fanproxy_tunnel',
      success: false,
      error: error.message,
    };
    appendPrivateJson(path.join(context.sessionDirectory, 'polls.ndjson'), safeFailure);
    process.stderr.write(`${JSON.stringify({ ok: false, ...safeFailure })}\n`);
    if (!continueOnFailure) throw error;
    return false;
  }
}

/** @returns {void} 执行内置无网络自检。 */
function runSelfTest() {
  const identity = parseOrderIdentity(
    'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com'
  );
  if (identity.orderNumber !== 'W1234567890') throw new Error('订单身份解析自检失败');
  const redacted = redactValue('W1234567890 test@example.com 13800138000', [
    identity.orderNumber,
    identity.appleId,
  ]);
  if (/W1234567890|test@example\.com|13800138000/.test(redacted)) {
    throw new Error('脱敏自检失败');
  }
  const flattened = flattenJson({ orderNumber: 'W1234567890', status: 'PROCESSING' });
  if (flattened[0].value !== '[REDACTED]' || flattened[1].value !== 'PROCESSING') {
    throw new Error('JSON 字段清单自检失败');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, selfTest: 'passed' })}\n`);
}

/** @returns {Promise<void>} CLI 入口。 */
async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.flags.has('self-test')) {
      runSelfTest();
      return;
    }

    const stdinInput = args.flags.has('stdin') ? JSON.parse(await readStdin()) : {};
    const proxyConfig = normalizeProxyConfig(stdinInput);
    const provider = createProvider(proxyConfig);

    if (args.flags.has('check-proxy')) {
      const { response, attempt } = await fetchWithRetry(APPLE_HOME_URL, provider);
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          check: 'fanproxy_apple_home',
          responseStatus: response.status,
          attempt,
          contentType: response.headers?.['content-type'] || null,
        })}\n`
      );
      return;
    }

    const orderUrl = stdinInput.orderUrl || process.env.APPLE_ORDER_OBSERVATION_URL;
    const identity = parseOrderIdentity(orderUrl);
    const orderFingerprint = createOrderFingerprint(identity);
    const session = validateSafeSegment(
      stdinInput.session || args.values.session || orderFingerprint,
      'session'
    );
    const stage = validateSafeSegment(
      stdinInput.stage || args.values.stage || 'automatic',
      'stage'
    );
    const outputRoot = path.resolve(args.values.output || DEFAULT_OUTPUT_ROOT);
    const sessionDirectory = path.join(outputRoot, session);
    if (!sessionDirectory.startsWith(`${outputRoot}${path.sep}`)) {
      throw new Error('输出目录越界');
    }
    ensurePrivateDirectory(outputRoot);
    ensurePrivateDirectory(sessionDirectory);
    const context = {
      orderUrl,
      identity,
      provider,
      sessionDirectory,
      stage,
      orderFingerprint,
    };

    const intervalSeconds = Number(
      stdinInput.intervalSeconds || args.values['interval-seconds'] || DEFAULT_INTERVAL_SECONDS
    );
    if (args.flags.has('watch') && intervalSeconds < MIN_INTERVAL_SECONDS) {
      throw new Error(`持续观测间隔不得低于 ${MIN_INTERVAL_SECONDS} 秒`);
    }

    const watchEnabled = args.flags.has('watch');
    await captureAndReport(context, watchEnabled);
    while (args.flags.has('watch')) {
      await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
      await captureAndReport(context, true);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  collectDomInventory,
  collectSecretValues,
  compareAvailability,
  createAvailabilitySummary,
  createOrderFingerprint,
  extractOrderJson,
  flattenJson,
  normalizeProxyConfig,
  parseArguments,
  parseOrderIdentity,
  redactValue,
};
