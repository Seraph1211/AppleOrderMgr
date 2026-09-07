const axios = require('axios');

const logger = require('../../../utils/logger');

/** 兼容原快代理私密代理提取接口。 */
class KdlPrivateProvider {
  constructor(options) {
    this.apiUrl = options.apiUrl;
    this.maxFailCount = options.maxFailCount || 2;
    this.proxies = [];
    this.failures = new Map();
    this.bad = new Set();
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
    if (response.data?.code !== 0) {
      throw new Error('代理 API 响应无有效代理列表');
    }
    this.proxies = this.parseProxyResponse(response.data);
    if (this.proxies.length === 0) throw new Error('代理 API 响应无有效代理列表');
    this.failures.clear();
    this.bad.clear();
    this.isInitialized = true;
    logger.info('私密代理列表已刷新', { count: this.proxies.length });
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
    return list.map(value => this.parseProxyString(value));
  }

  /** @param {string} value - ip:port:user:pass @returns {Object} 代理配置。 */
  parseProxyString(value) {
    const [host, rawPort, username, password] = String(value).trim().split(':');
    const port = Number(rawPort);
    if (!host || !Number.isInteger(port)) throw new Error('无效的代理格式');
    return {
      host,
      port,
      auth: username && password ? { username, password } : undefined,
      provider: 'kdl_private',
    };
  }

  /** @returns {Object|null} 可用代理。 */
  getNextProxy() {
    for (let index = 0; index < this.proxies.length; index++) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      if (!this.bad.has(`${proxy.host}:${proxy.port}`)) return proxy;
    }
    return null;
  }

  /** @param {Object} proxy - 失败代理 @returns {boolean} 是否废弃。 */
  recordProxyFailure(proxy) {
    if (!proxy) return false;
    const key = `${proxy.host}:${proxy.port}`;
    const count = (this.failures.get(key) || 0) + 1;
    this.failures.set(key, count);
    if (count >= this.maxFailCount) this.bad.add(key);
    return this.bad.has(key);
  }

  /** @param {Object} _proxy - 成功代理 @returns {void} */
  recordProxySuccess(_proxy) {}

  /** @param {Object} proxy - 需要废弃的代理 @returns {void} */
  markProxyAsBad(proxy) {
    if (proxy) this.bad.add(`${proxy.host}:${proxy.port}`);
  }

  /** @returns {Object} Provider 状态。 */
  getStatus() {
    return {
      provider: 'kdl_private',
      enabled: true,
      isInitialized: this.isInitialized,
      total: this.proxies.length,
      available: this.proxies.length - this.bad.size,
      bad: this.bad.size,
    };
  }
}

module.exports = KdlPrivateProvider;
