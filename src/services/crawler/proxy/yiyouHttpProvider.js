const axios = require('axios');

const logger = require('../../../utils/logger');

const YIYOU_API_HOST = 'api.yiyouip.com';
const DEFAULT_POOL_TTL_MS = 240000;

/** 亦优 HTTP 短效直连代理 Provider。 */
class YiyouHttpProvider {
  constructor(options) {
    this.apiUrl = options.apiUrl;
    this.maxFailCount = options.maxFailCount || 2;
    this.badProxyTimeout = options.badProxyTimeout || DEFAULT_POOL_TTL_MS;
    this.poolTtlMs = options.poolTtlMs || DEFAULT_POOL_TTL_MS;
    this.proxies = [];
    this.failures = new Map();
    this.badUntil = new Map();
    this.currentIndex = 0;
    this.expiresAt = 0;
    this.isInitialized = false;
  }

  /** @returns {Promise<void>} 加载代理列表。 */
  async initialize() {
    await this.refresh();
  }

  /** @returns {Promise<void>} 从亦优 API 全量刷新短效代理。 */
  async refresh() {
    this.validateApiUrl();
    const response = await axios.get(this.apiUrl, {
      timeout: 10000,
      responseType: 'text',
      transformResponse: [value => value],
    });
    const proxies = this.parseProxyResponse(response.data);
    if (proxies.length === 0) throw new Error('亦优代理 API 响应无有效代理列表');

    this.proxies = proxies;
    this.pruneBadProxies();
    this.currentIndex = 0;
    this.expiresAt = Date.now() + this.poolTtlMs;
    this.isInitialized = true;
    logger.info('亦优 HTTP 代理列表已刷新', { count: this.proxies.length });
  }

  /** @returns {void} 校验提取 API 地址。 */
  validateApiUrl() {
    if (!this.apiUrl) throw new Error('亦优代理 API 配置缺失');
    let parsed;
    try {
      parsed = new URL(this.apiUrl);
    } catch (_error) {
      throw new Error('亦优代理 API 地址无效');
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== YIYOU_API_HOST) {
      throw new Error('亦优代理 API 必须使用官方 HTTPS 域名');
    }
  }

  /**
   * 解析 `IP:端口 用户名 密码` 换行文本，无效记录仅记数。
   * @param {string} responseData - API 响应文本
   * @returns {Object[]} 代理列表
   */
  parseProxyResponse(responseData) {
    if (typeof responseData !== 'string') return [];
    const lines = responseData
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const proxies = [];
    let invalidCount = 0;
    for (const line of lines) {
      try {
        proxies.push(this.parseProxyLine(line));
      } catch (_error) {
        invalidCount++;
      }
    }
    if (invalidCount > 0) {
      logger.warn('亦优代理响应包含无效记录', {
        invalidCount,
        total: lines.length,
      });
    }
    return proxies;
  }

  /** @param {string} line - IP:端口 用户名 密码 @returns {Object} 代理配置。 */
  parseProxyLine(line) {
    const [endpoint, username, password, ...extra] = String(line).trim().split(/\s+/);
    const [host, rawPort, ...endpointExtra] = String(endpoint || '').split(':');
    const port = Number(rawPort);
    const octets = String(host || '')
      .split('.')
      .map(Number);
    const isValidIpv4 =
      octets.length === 4 &&
      octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255);
    if (
      !isValidIpv4 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !username ||
      !password ||
      extra.length > 0 ||
      endpointExtra.length > 0
    ) {
      throw new Error('无效的亦优代理格式');
    }
    return {
      host,
      port,
      auth: { username, password },
      provider: 'yiyou_http',
      disableKeepAlive: true,
    };
  }

  /** @returns {Object|null} 可用代理。 */
  getNextProxy() {
    if (Date.now() >= this.expiresAt) return null;
    this.pruneBadProxies();
    for (let index = 0; index < this.proxies.length; index++) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      if (!this.badUntil.has(`${proxy.host}:${proxy.port}`)) return proxy;
    }
    return null;
  }

  /** @param {Object} proxy - 失败代理 @returns {boolean} 是否废弃。 */
  recordProxyFailure(proxy) {
    if (!proxy) return false;
    const key = `${proxy.host}:${proxy.port}`;
    const count = (this.failures.get(key) || 0) + 1;
    this.failures.set(key, count);
    if (count >= this.maxFailCount) this.badUntil.set(key, Date.now() + this.badProxyTimeout);
    return this.badUntil.has(key);
  }

  /** @param {Object} proxy - 成功代理 @returns {void} */
  recordProxySuccess(proxy) {
    if (proxy) this.failures.delete(`${proxy.host}:${proxy.port}`);
  }

  /** @param {Object} proxy - 需要废弃的代理 @returns {void} */
  markProxyAsBad(proxy) {
    if (proxy) this.badUntil.set(`${proxy.host}:${proxy.port}`, Date.now() + this.badProxyTimeout);
  }

  /** @returns {void} 清理已结束冷却的代理。 */
  pruneBadProxies() {
    const now = Date.now();
    for (const [key, expiresAt] of this.badUntil.entries()) {
      if (expiresAt <= now) {
        this.badUntil.delete(key);
        this.failures.delete(key);
      }
    }
  }

  /** @returns {Object} Provider 脱敏状态。 */
  getStatus() {
    this.pruneBadProxies();
    const expired = Date.now() >= this.expiresAt;
    const bad = expired
      ? this.proxies.length
      : this.proxies.filter(proxy => this.badUntil.has(`${proxy.host}:${proxy.port}`)).length;
    return {
      provider: 'yiyou_http',
      enabled: true,
      isInitialized: this.isInitialized,
      total: this.proxies.length,
      available: expired ? 0 : this.proxies.length - bad,
      bad,
    };
  }
}

module.exports = YiyouHttpProvider;
