const crypto = require('crypto');

const logger = require('../../../utils/logger');

const SESSION_ID_BYTES = 3;
const MAX_SESSION_ID_LENGTH = 6;
const VALID_STICKY_PERIOD = /^(?:0\.25|0\.5|[1-9]|[12]\d|30)$/;
const VALID_POOL_PRIORITY = /^(?:q|s)(?:[1-9]|10)$/;

/** 快代理隧道代理 Pro Provider。 */
class KdlTunnelProvider {
  constructor(options) {
    this.hosts = [options.host, options.backupHost].filter(Boolean);
    this.port = options.port;
    this.username = options.username;
    this.password = options.password;
    this.stickyPeriod = String(options.stickyPeriod || '0.5');
    this.poolType = String(options.poolType || 'std').toLowerCase();
    this.poolPriority = String(options.poolPriority || 'q10').toLowerCase();
    this.sessionIdFactory =
      options.sessionIdFactory || (() => crypto.randomBytes(SESSION_ID_BYTES).toString('hex'));
    this.currentIndex = 0;
    this.isInitialized = false;
  }

  /** @returns {Promise<void>} 校验隧道配置。 */
  initialize() {
    if (this.hosts.length === 0 || !this.port || !this.username || !this.password) {
      return Promise.reject(new Error('快代理隧道配置缺失'));
    }
    if (!VALID_STICKY_PERIOD.test(this.stickyPeriod)) {
      return Promise.reject(new Error('快代理隧道固定周期配置无效'));
    }
    if (!['std', 'enh'].includes(this.poolType)) {
      return Promise.reject(new Error('快代理隧道资源池类型配置无效'));
    }
    if (!VALID_POOL_PRIORITY.test(this.poolPriority)) {
      return Promise.reject(new Error('快代理隧道资源池优先级配置无效'));
    }
    this.isInitialized = true;
    logger.info('快代理隧道 Provider 初始化成功', {
      hosts: this.hosts,
      port: this.port,
      authConfigured: true,
      stickyPeriod: this.stickyPeriod,
      poolType: this.poolType,
      poolPriority: this.poolPriority,
    });
    return Promise.resolve();
  }

  /** @returns {string} 本次尝试使用的带会话参数用户名。 */
  createSessionUsername() {
    const sessionId = String(this.sessionIdFactory())
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, MAX_SESSION_ID_LENGTH);
    if (!sessionId) {
      throw new Error('快代理隧道会话标识生成失败');
    }
    return [
      this.username,
      `period-${this.stickyPeriod}`,
      `sid-${sessionId}`,
      `type-${this.poolType}`,
      `pool-${this.poolPriority}`,
    ].join('-');
  }

  /** @returns {Object|null} 下一个隧道入口。 */
  getNextProxy() {
    if (!this.isInitialized || this.hosts.length === 0) return null;
    const host = this.hosts[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.hosts.length;
    return {
      host,
      port: this.port,
      auth: { username: this.createSessionUsername(), password: this.password },
      provider: 'kdl_tunnel',
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

  /** @param {Object} _proxy - 代理入口 @returns {void} */
  markProxyAsBad(_proxy) {}

  /** @returns {Object} Provider 状态。 */
  getStatus() {
    return {
      provider: 'kdl_tunnel',
      enabled: true,
      isInitialized: this.isInitialized,
      total: this.hosts.length,
      available: this.hosts.length,
      bad: 0,
      stickyPeriod: this.stickyPeriod,
      poolType: this.poolType,
      poolPriority: this.poolPriority,
    };
  }
}

module.exports = KdlTunnelProvider;
