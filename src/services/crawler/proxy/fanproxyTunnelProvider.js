const crypto = require('crypto');

const logger = require('../../../utils/logger');

const SESSION_ID_BYTES = 6;
const MAX_SESSION_ID_LENGTH = 24;
const DEFAULT_SESSION_POOL_SIZE = 5;
const MAX_SESSION_POOL_SIZE = 100;
const DEFAULT_SESSION_MODE = 'sticky_pool';
const VALID_SESSION_MODES = ['basic', 'sticky_pool'];
const MAX_PROXY_PORT = 65535;
const VALID_ACCOUNT = /^[^-:\s]+$/;
const VALID_COUNTRY = /^[A-Z]{2}$/;
const VALID_REGION = /^[a-zA-Z0-9_]+$/;

/** 网帆国内隧道账密 Provider。 */
class FanProxyTunnelProvider {
  /**
   * @param {Object} options - 网帆隧道配置
   * @param {string} options.host - 主隧道入口
   * @param {string} [options.backupHost] - 备用隧道入口
   * @param {number} options.port - 隧道端口
   * @param {string} options.account - 网帆基础账号
   * @param {string} options.password - 网帆隧道密码
   * @param {string} [options.country] - 国家代码，默认 CN
   * @param {string} [options.region] - 可选地区代码
   * @param {number} [options.sessionPoolSize] - 粘性会话槽数量
   * @param {string} [options.sessionMode] - basic 或 sticky_pool
   * @param {Function} [options.sessionIdFactory] - 测试用会话 ID 工厂
   */
  constructor(options = {}) {
    this.hosts = [...new Set([options.host, options.backupHost].filter(Boolean))];
    this.port = options.port;
    this.account = options.account;
    this.password = options.password;
    this.country = String(options.country || 'CN').toUpperCase();
    this.region = options.region ? String(options.region) : null;
    this.sessionPoolSize = options.sessionPoolSize ?? DEFAULT_SESSION_POOL_SIZE;
    this.sessionMode = options.sessionMode || DEFAULT_SESSION_MODE;
    this.sessionIdFactory =
      options.sessionIdFactory || (() => crypto.randomBytes(SESSION_ID_BYTES).toString('hex'));
    this.currentIndex = 0;
    this.currentSessionIndex = 0;
    this.sessionIds = [];
    this.isInitialized = false;
  }

  /** @returns {Promise<void>} 校验网帆隧道配置。 */
  initialize() {
    if (this.hosts.length === 0 || !this.port || !this.account || !this.password) {
      return Promise.reject(new Error('网帆隧道配置缺失'));
    }
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > MAX_PROXY_PORT) {
      return Promise.reject(new Error('网帆隧道端口配置无效'));
    }
    if (!VALID_ACCOUNT.test(this.account)) {
      return Promise.reject(new Error('网帆隧道账号格式无效'));
    }
    if (!VALID_COUNTRY.test(this.country)) {
      return Promise.reject(new Error('网帆隧道国家代码无效'));
    }
    if (this.region && !VALID_REGION.test(this.region)) {
      return Promise.reject(new Error('网帆隧道地区代码无效'));
    }
    if (!VALID_SESSION_MODES.includes(this.sessionMode)) {
      return Promise.reject(new Error('网帆隧道会话模式无效'));
    }
    if (
      this.sessionMode === 'sticky_pool' &&
      (!Number.isInteger(this.sessionPoolSize) ||
        this.sessionPoolSize < 1 ||
        this.sessionPoolSize > MAX_SESSION_POOL_SIZE)
    ) {
      return Promise.reject(new Error('网帆隧道会话槽数量无效'));
    }
    this.sessionIds =
      this.sessionMode === 'sticky_pool'
        ? Array.from({ length: this.sessionPoolSize }, () => this.createSessionId())
        : [];
    this.isInitialized = true;
    logger.info('网帆隧道 Provider 初始化成功', {
      hosts: this.hosts,
      port: this.port,
      authConfigured: true,
      country: this.country,
      regionConfigured: Boolean(this.region),
      sessionPoolSize: this.sessionPoolSize,
      sessionMode: this.sessionMode,
    });
    return Promise.resolve();
  }

  /** @returns {string} 新的网帆会话标识。 */
  createSessionId() {
    const sessionId = String(this.sessionIdFactory())
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, MAX_SESSION_ID_LENGTH);
    if (!sessionId) {
      throw new Error('网帆隧道会话标识生成失败');
    }
    return sessionId;
  }

  /** @param {string} sessionId - 会话槽标识 @returns {string} 网帆账密用户名。 */
  createSessionUsername(sessionId) {
    const parameters = ['acc', this.account, 'cty', this.country];
    if (this.region) parameters.push('reg', this.region);
    if (sessionId) parameters.push('sid', sessionId);
    return parameters.join('-');
  }

  /** @returns {Object|null} 下一个网帆隧道入口。 */
  getNextProxy() {
    if (!this.isInitialized || this.hosts.length === 0) return null;
    const host = this.hosts[this.currentIndex];
    const sessionId = this.sessionIds[this.currentSessionIndex] || null;
    this.currentIndex = (this.currentIndex + 1) % this.hosts.length;
    if (this.sessionIds.length > 0) {
      this.currentSessionIndex = (this.currentSessionIndex + 1) % this.sessionIds.length;
    }
    return {
      host,
      port: this.port,
      auth: { username: this.createSessionUsername(sessionId), password: this.password },
      provider: 'fanproxy_tunnel',
      disableKeepAlive: true,
    };
  }

  /** @returns {Promise<void>} 固定隧道无需提取刷新。 */
  async refresh() {
    if (!this.isInitialized) await this.initialize();
  }

  /** @param {Object} _proxy - 代理入口 @returns {boolean} 是否废弃。 */
  recordProxyFailure(_proxy) {
    return false;
  }

  /** @param {Object} _proxy - 代理入口 @returns {void} */
  recordProxySuccess(_proxy) {}

  /** @param {Object} _proxy - 需要隔离的代理入口 @returns {void} */
  markProxyAsBad(_proxy) {}

  /** @returns {Object} Provider 脱敏状态。 */
  getStatus() {
    return {
      provider: 'fanproxy_tunnel',
      enabled: true,
      isInitialized: this.isInitialized,
      total: this.hosts.length,
      available: this.hosts.length,
      bad: 0,
      country: this.country,
      regionConfigured: Boolean(this.region),
      sessionPoolSize: this.sessionPoolSize,
      sessionMode: this.sessionMode,
    };
  }
}

module.exports = FanProxyTunnelProvider;
