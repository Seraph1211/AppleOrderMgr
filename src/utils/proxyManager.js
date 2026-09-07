const { config } = require('./config');
const {
  createProxyProvider,
  isSupportedProxyProvider,
} = require('../services/crawler/proxy/proxyProvider');

/** 返回禁用状态的空 Provider。 */
function createDisabledProvider() {
  return {
    async initialize() {},
    async refresh() {},
    getNextProxy: () => null,
    recordProxyFailure: () => false,
    recordProxySuccess: () => {},
    markProxyAsBad: () => {},
    getStatus: () => ({
      provider: 'disabled',
      enabled: false,
      isInitialized: true,
      total: 0,
      available: 0,
      bad: 0,
    }),
  };
}

/** 运行时代理 Provider 门面；候选验证成功后才替换当前实例。 */
class ProxyManager {
  /**
   * @param {Object} proxyConfig - 代理配置
   * @param {Function} providerFactory - Provider 工厂
   */
  constructor(proxyConfig, providerFactory = createProxyProvider) {
    this.proxyConfig = proxyConfig;
    this.providerFactory = providerFactory;
    this.activeProvider = proxyConfig.enabled ? null : createDisabledProvider();
    this.activeProviderName = proxyConfig.enabled ? null : 'disabled';
    this.switchQueue = Promise.resolve();
  }

  /** @returns {Promise<Object>} 初始化环境默认 Provider。 */
  initialize() {
    if (!this.proxyConfig.enabled) return Promise.resolve(this.getStatus());
    if (this.activeProvider?.getStatus().isInitialized) {
      return Promise.resolve(this.getStatus());
    }
    return this.switchProvider(this.proxyConfig.provider);
  }

  /**
   * 串行初始化并验证候选 Provider，成功后原子替换。
   * @param {string} providerName - 目标 Provider
   * @param {Object} options - 切换选项
   * @param {Function} options.validateCandidate - 候选连通性检查
   * @returns {Promise<Object>} 脱敏切换摘要
   */
  switchProvider(providerName, options = {}) {
    const operation = this.switchQueue
      .catch(() => undefined)
      .then(async () => {
        if (!this.proxyConfig.enabled) throw new Error('代理功能未启用');
        if (!isSupportedProxyProvider(providerName)) throw new Error('不支持的代理 Provider');

        if (
          providerName === this.activeProviderName &&
          this.activeProvider?.getStatus().isInitialized &&
          !options.validateCandidate
        ) {
          return {
            changed: false,
            previousProvider: this.activeProviderName,
            activeProvider: this.activeProviderName,
            status: this.getStatus(),
          };
        }

        const candidate = this.providerFactory({ ...this.proxyConfig, provider: providerName });
        await candidate.initialize();
        if (options.validateCandidate) await options.validateCandidate(candidate);

        const previousProvider = this.activeProviderName;
        this.activeProvider = candidate;
        this.activeProviderName = providerName;
        return {
          changed: previousProvider !== providerName,
          previousProvider,
          activeProvider: providerName,
          status: this.getStatus(),
        };
      });
    this.switchQueue = operation;
    return operation;
  }

  /** @returns {Promise<void>} 刷新当前 Provider。 */
  async refresh() {
    if (!this.activeProvider?.getStatus().isInitialized) {
      await this.initialize();
      return;
    }
    await this.activeProvider.refresh();
  }

  /** @returns {Object|null} 下一个代理。 */
  getNextProxy() {
    return this.activeProvider?.getNextProxy() || null;
  }

  /** @param {Object} proxy - 失败代理 @returns {boolean} 是否废弃。 */
  recordProxyFailure(proxy) {
    return this.activeProvider?.recordProxyFailure(proxy) || false;
  }

  /** @param {Object} proxy - 成功代理 @returns {void} */
  recordProxySuccess(proxy) {
    this.activeProvider?.recordProxySuccess(proxy);
  }

  /** @param {Object} proxy - 需要隔离的代理 @returns {void} */
  markProxyAsBad(proxy) {
    this.activeProvider?.markProxyAsBad(proxy);
  }

  /** @returns {Object} 当前 Provider 脱敏状态。 */
  getStatus() {
    const providerStatus = this.activeProvider?.getStatus() || {
      enabled: this.proxyConfig.enabled,
      isInitialized: false,
      total: 0,
      available: 0,
      bad: 0,
    };
    return {
      ...providerStatus,
      provider: this.activeProviderName || this.proxyConfig.provider,
      activeProvider: this.activeProviderName,
    };
  }
}

/**
 * 返回不包含用户名和密码的代理摘要。
 * @param {string} value - 代理字符串
 * @returns {string} host:port
 */
function maskProxyString(value) {
  const [host, port] = String(value || '').split(':');
  return host && port ? `${host}:${port}` : 'invalid_proxy';
}

/**
 * 返回不包含凭据的代理 API 摘要。
 * @param {Object} responseData - 代理 API 响应
 * @returns {Object} 安全摘要
 */
function summarizeProxyResponse(responseData) {
  const list = responseData?.data?.proxy_list;
  return {
    hasData: Boolean(responseData?.data),
    hasProxyList: Array.isArray(list),
    proxyListCount: Array.isArray(list) ? list.length : 0,
    responseCode: responseData?.code,
    hasMessage: Boolean(responseData?.msg),
  };
}

const proxyManager = new ProxyManager(config.proxy);

module.exports = proxyManager;
module.exports.ProxyManager = ProxyManager;
module.exports.maskProxyString = maskProxyString;
module.exports.summarizeProxyResponse = summarizeProxyResponse;
