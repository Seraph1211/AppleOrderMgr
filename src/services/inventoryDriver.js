const fs = require('fs');
const { encrypt, decrypt } = require('../utils/fieldEncryption');
const { readProxy, requestOnce } = require('./inventoryValidationClient');
const { acquireProxy } = require('./inventoryValidationProxy');
const DEFERRED_OUTCOMES = new Set([
  'REQUEST_IN_FLIGHT',
  'TARGET_COOLDOWN',
  'REQUEST_BUDGET_EXHAUSTED',
  'MONITOR_DISABLED',
]);

/** 仅保留已知闸门原因，禁止透传供应商地址或敏感异常。 */
function safeProxyFailure(error) {
  const safe = new Error('NO_HEALTHY_PROXY');
  if (DEFERRED_OUTCOMES.has(error.inventoryOutcome)) {
    safe.inventoryOutcome = error.inventoryOutcome;
    safe.until = Number.isFinite(error.until) ? error.until : null;
  }
  return safe;
}

/** 已配置出口驱动，不购买、不开浏览器、不回退直连 Apple。 */
class InventoryDriver {
  constructor(gate, options = {}) {
    this.gate = gate;
    this.options = options;
  }
  /** 选择健康的既有主/备出口，动态端点按供应商身份固定计费计风险。 */
  async proxy() {
    try {
      if (!this.proxyPending) this.proxyPending = this.loadProxy();
      return await this.proxyPending;
    } catch (error) {
      throw safeProxyFailure(error);
    } finally {
      this.proxyPending = null;
    }
  }
  /** 合并同进程的端点提取；网络发送仍需逐请求经过数据库闸门。 */
  async loadProxy() {
    try {
      const state = await this.gate.locked(body => ({ ...body }));
      const files = [
        this.options.proxyFile || process.env.INVENTORY_PROXY_FILE,
        this.options.backupFile || process.env.INVENTORY_BACKUP_PROXY_FILE,
      ].filter(Boolean);
      for (const file of files) {
        const proxy = readProxy(file);
        if (!state.pausedEgress?.[proxy.label] && state.requiredAlternateEgress !== proxy.label)
          return proxy;
      }
      const apiFile = this.options.apiFile || process.env.INVENTORY_PROXY_API_FILE;
      if (
        !apiFile ||
        state.pausedEgress?.['yiyou-main'] ||
        state.requiredAlternateEgress === 'yiyou-main'
      )
        throw new Error('NO_HEALTHY_PROXY');
      if (state.proxyCache?.expiresAt > Date.now() + 30000)
        return { label: 'yiyou-main', url: decrypt(state.proxyCache.cipher) };
      const data = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
      const endpoint = await acquireProxy({ apiUrl: data.apiUrl || data.url, gate: this.gate });
      await this.gate.locked(async (body, _now, transaction) => {
        try {
          body.proxyCache = { expiresAt: endpoint.expiresAt, cipher: encrypt(endpoint.url) };
          await this.gate.save(body, transaction);
        } catch (_error) {
          throw new Error('PROXY_CACHE_FAILED');
        }
      });
      return { label: 'yiyou-main', url: endpoint.url };
    } catch (error) {
      throw safeProxyFailure(error);
    }
  }
  /** 单个请求的实际发送，保护许可不足时不产生隐含重试。 */
  async request(purpose, context) {
    try {
      return await requestOnce({ purpose, context, proxy: await this.proxy(), gate: this.gate });
    } catch (error) {
      if (DEFERRED_OUTCOMES.has(error.inventoryOutcome))
        return { outcome: error.inventoryOutcome, until: error.until };
      return { outcome: 'NO_HEALTHY_PROXY' };
    }
  }
}
module.exports = InventoryDriver;
