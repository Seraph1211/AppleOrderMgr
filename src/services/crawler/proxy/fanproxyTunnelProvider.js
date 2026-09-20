const crypto = require('crypto');

const logger = require('../../../utils/logger');
const { waitForRefresh } = require('../refreshBudget');

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
const FAILURE_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 60000;
const LEASE_POLL_MS = 100;
const TRANSPORT_ERRORS = new Set([
  'REQUEST_TIMEOUT',
  'RESPONSE_STREAM',
  'PROXY_TRANSPORT',
  'HTTP_631',
]);

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
   * @param {number} [options.cooldownMs] - 冷却时间，不短于套餐粘性周期
   * @param {Function} [options.now] - 测试用时钟
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
    this.slots = [];
    this.proxySlots = new WeakMap();
    this.now = options.now || Date.now;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
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
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs < DEFAULT_COOLDOWN_MS) {
      return Promise.reject(new Error('会话冷却时间不得少于 60 秒'));
    }
    this.sessionIds =
      this.sessionMode === 'sticky_pool'
        ? Array.from({ length: this.sessionPoolSize }, () => this.createSessionId())
        : [];
    this.slots = Array.from({ length: this.sessionIds.length || 1 }, (_, index) => ({
      index,
      sessionId: this.sessionIds[index] || null,
      lease: null,
      failures: 0,
      loadingCount: 0,
      lastSuccessAt: null,
      cooldownUntil: 0,
      renewSession: false,
    }));
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

  /**
   * 取得可用槽位；兼容诊断调用默认不租用，Worker 必须使用 acquireProxy。
   * @param {Object} options - 是否租用槽位
   * @returns {Object|null} 可用代理
   */
  getNextProxy(options = {}) {
    if (!this.isInitialized || this.hosts.length === 0) return null;
    for (let offset = 0; offset < this.slots.length; offset++) {
      const index = (this.currentSessionIndex + offset) % this.slots.length;
      const slot = this.slots[index];
      if (slot.lease || slot.cooldownUntil > this.now()) continue;
      if (slot.renewSession && this.sessionMode === 'sticky_pool') {
        slot.sessionId = this.createSessionId();
        this.sessionIds[index] = slot.sessionId;
      }
      slot.renewSession = false;
      slot.cooldownUntil = 0;
      const host = this.hosts[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.hosts.length;
      this.currentSessionIndex = (index + 1) % this.slots.length;
      const proxy = {
        host,
        port: this.port,
        auth: { username: this.createSessionUsername(slot.sessionId), password: this.password },
        provider: 'fanproxy_tunnel',
        disableKeepAlive: true,
        sessionSlot: index + 1,
      };
      this.proxySlots.set(proxy, { slot, sessionId: slot.sessionId });
      slot.latestProxy = proxy;
      if (options.lease) slot.lease = proxy;
      return proxy;
    }
    return null;
  }

  /**
   * 等待并独占一个槽位；取消后不再租用，不重建或扩大会话池。
   * @param {Object} options - 抓取预算信号
   * @returns {Promise<Object|null>} 已租用代理
   */
  async acquireProxy(options = {}) {
    try {
      while (this.isInitialized) {
        options.signal?.throwIfAborted();
        const proxy = this.getNextProxy({ lease: true });
        if (proxy) return proxy;
        await waitForRefresh(LEASE_POLL_MS, options.signal);
      }
      return null;
    } catch (error) {
      logger.debug('网帆会话等待结束', { errorCode: error.refreshErrorCode || 'PROXY_TRANSPORT' });
      throw error;
    }
  }

  /** @param {Object} proxy - 已租用代理 @returns {void} 释放本次租用。 */
  releaseProxy(proxy) {
    const slot = this.proxySlots.get(proxy)?.slot;
    if (slot?.lease === proxy) slot.lease = null;
  }

  /** @returns {Promise<void>} 固定隧道刷新不清除冷却和租用状态。 */
  async refresh() {
    try {
      if (!this.isInitialized) await this.initialize();
    } catch (error) {
      logger.warn('网帆会话初始化失败');
      throw error;
    }
  }

  /** @param {Object} proxy - 代理 @returns {Object|null} 当前代际槽位。 */
  getProxySlot(proxy) {
    const entry = this.proxySlots.get(proxy);
    return entry && entry.slot.latestProxy === proxy && entry.sessionId === entry.slot.sessionId
      ? entry.slot
      : null;
  }

  /**
   * 仅传输失败累计线路失败；解析／加载页不污染线路健康。
   * @param {Object} proxy - 失败代理
   * @param {Object} options - 错误分类
   * @returns {boolean} 是否进入冷却
   */
  recordProxyFailure(proxy, options = {}) {
    const slot = this.getProxySlot(proxy);
    if (!slot) return false;
    if (options.errorCode === 'PAGE_LOADING') slot.loadingCount++;
    if (!TRANSPORT_ERRORS.has(options.errorCode || 'PROXY_TRANSPORT')) return false;
    slot.failures++;
    if (slot.failures < FAILURE_THRESHOLD) return false;
    this.markProxyAsBad(proxy);
    return true;
  }

  /** @param {Object} proxy - 成功代理 @returns {void} 重置连续线路失败。 */
  recordProxySuccess(proxy) {
    const slot = this.getProxySlot(proxy);
    if (!slot) return;
    slot.failures = 0;
    slot.lastSuccessAt = this.now();
  }

  /** @param {Object} proxy - 失败代理 @returns {void} 隔离槽位，冷却后更换会话。 */
  markProxyAsBad(proxy) {
    const slot = this.getProxySlot(proxy);
    if (!slot) return;
    slot.cooldownUntil = this.now() + this.cooldownMs;
    slot.renewSession = true;
    slot.failures = 0;
  }

  /** @returns {Object} Provider 脱敏状态。 */
  getStatus() {
    return {
      provider: 'fanproxy_tunnel',
      enabled: true,
      isInitialized: this.isInitialized,
      total: this.slots.length,
      available: this.slots.filter(slot => !slot.lease && slot.cooldownUntil <= this.now()).length,
      bad: this.slots.filter(slot => slot.cooldownUntil > this.now()).length,
      leased: this.slots.filter(slot => slot.lease).length,
      cooldownMs: this.cooldownMs,
      loadingCount: this.slots.reduce((count, slot) => count + slot.loadingCount, 0),
      country: this.country,
      regionConfigured: Boolean(this.region),
      sessionPoolSize: this.sessionPoolSize,
      sessionMode: this.sessionMode,
    };
  }
}

module.exports = FanProxyTunnelProvider;
