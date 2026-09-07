const axios = require('axios');

const logger = require('../../../utils/logger');

/** 兼容原快代理私密代理提取接口。 */
class KdlPrivateProvider {
  constructor(options) {
    this.apiUrl = options.apiUrl;
    this.maxFailCount = options.maxFailCount || 2;
    this.badProxyTimeout = options.badProxyTimeout || 3600000;
    this.proxies = [];
    this.failures = new Map();
    this.badUntil = new Map();
    this.currentIndex = 0;
    this.isInitialized = false;
  }

  /** @returns {Promise<void>} 加载代理列表。 */
  async initialize() {
    await this.refresh();
  }

  /** @returns {Promise<void>} 从 API 全量刷新短效代理。 */
  async refresh() {
    if (!this.apiUrl) throw new Error('代理 API 配置缺失');
    const response = await axios.get(this.apiUrl, { timeout: 10000 });
    const responseData = this.normalizeProxyResponse(response.data);
    if (Number(responseData?.code) !== 0) {
      throw new Error('代理 API 响应无有效代理列表');
    }
    const proxies = this.parseProxyResponse(responseData);
    if (proxies.length === 0) throw new Error('代理 API 响应无有效代理列表');
    this.proxies = proxies;
    this.pruneBadProxies();
    this.currentIndex = 0;
    this.isInitialized = true;
    logger.info('私密代理列表已刷新', { count: this.proxies.length });
  }

  /**
   * 兼容提取接口以 text/plain 返回 JSON 的情况。
   * @param {Object|string} responseData - 原始响应
   * @returns {Object} 标准响应对象
   */
  normalizeProxyResponse(responseData) {
    if (typeof responseData !== 'string') return responseData;
    try {
      return JSON.parse(responseData);
    } catch (_error) {
      throw new Error('代理 API 响应格式无效');
    }
  }

  /** @param {Object} responseData - API 响应 @returns {Object[]} 代理列表。 */
  parseProxyResponse(responseData) {
    const list = responseData?.data?.proxy_list;
    if (!Array.isArray(list)) {
      logger.error('代理响应格式不正确', {
        responseSummary: {
          hasData: Boolean(responseData?.data),
          hasProxyList: false,
          proxyListCount: 0,
          responseCode: responseData?.code,
          hasMessage: Boolean(responseData?.msg),
        },
      });
      return [];
    }
    const proxies = [];
    let invalidCount = 0;
    for (const value of list) {
      try {
        proxies.push(this.parseProxyValue(value));
      } catch (_error) {
        invalidCount++;
      }
    }
    if (invalidCount > 0) {
      logger.warn('私密代理响应包含无效记录', { invalidCount, total: list.length });
    }
    return proxies;
  }

  /** @param {string|Object} value - 代理记录 @returns {Object} 代理配置。 */
  parseProxyValue(value) {
    if (value && typeof value === 'object') {
      const host = value.ip || value.host;
      const port = Number(value.port);
      const username = value.username || value.user || value.account;
      const password = value.password || value.pass || value.secret;
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('无效的代理格式');
      }
      return {
        host,
        port,
        auth: username && password ? { username, password } : undefined,
        provider: 'kdl_private',
      };
    }
    return this.parseProxyString(value);
  }

  /** @param {string} value - ip:port:user:pass @returns {Object} 代理配置。 */
  parseProxyString(value) {
    const [host, rawPort, username, password] = String(value).trim().split(':');
    const port = Number(rawPort);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('无效的代理格式');
    }
    return {
      host,
      port,
      auth: username && password ? { username, password } : undefined,
      provider: 'kdl_private',
    };
  }

  /** @returns {Object|null} 可用代理。 */
  getNextProxy() {
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
    if (count >= this.maxFailCount) {
      this.badUntil.set(key, Date.now() + this.badProxyTimeout);
    }
    return this.badUntil.has(key);
  }

  /** @param {Object} _proxy - 成功代理 @returns {void} */
  recordProxySuccess(_proxy) {
    if (_proxy) this.failures.delete(`${_proxy.host}:${_proxy.port}`);
  }

  /** @param {Object} proxy - 需要废弃的代理 @returns {void} */
  markProxyAsBad(proxy) {
    if (proxy) {
      this.badUntil.set(`${proxy.host}:${proxy.port}`, Date.now() + this.badProxyTimeout);
    }
  }

  /** @returns {void} 清理已经结束冷却的代理。 */
  pruneBadProxies() {
    const now = Date.now();
    for (const [key, expiresAt] of this.badUntil.entries()) {
      if (expiresAt <= now) {
        this.badUntil.delete(key);
        this.failures.delete(key);
      }
    }
  }

  /** @returns {Object} Provider 状态。 */
  getStatus() {
    this.pruneBadProxies();
    const bad = this.proxies.filter(proxy =>
      this.badUntil.has(`${proxy.host}:${proxy.port}`)
    ).length;
    return {
      provider: 'kdl_private',
      enabled: true,
      isInitialized: this.isInitialized,
      total: this.proxies.length,
      available: this.proxies.length - bad,
      bad,
    };
  }
}

module.exports = KdlPrivateProvider;
