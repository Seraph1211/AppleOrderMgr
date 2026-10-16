const { readProxy, requestOnce } = require('./inventoryValidationClient');
const InventoryTunnel = require('./inventoryTunnel');
const { PROVIDER_LABEL } = require('./inventoryTunnelPolicy');
const DEFERRED_OUTCOMES = new Set([
  'REQUEST_IN_FLIGHT',
  'TARGET_COOLDOWN',
  'PROXY_PROVIDER_COOLDOWN',
  'ALTERNATE_EGRESS_REQUIRED',
  'RECOVERY_PROBE_REQUIRED',
  'REQUEST_BUDGET_EXHAUSTED',
  'MONITOR_DISABLED',
  'RECOVERY_EXHAUSTED',
  'PROXY_RECOVERY_EXHAUSTED',
  'PROXY_PACKAGE_EXPIRED',
  'PROXY_AUTH_FAILED',
  'PROXY_CONNECT_REJECTED',
]);

/** 仅保留已知保护原因，禁止透传供应商地址或敏感异常。 */
function safeProxyFailure(error) {
  const safe = new Error('NO_HEALTHY_PROXY');
  if (DEFERRED_OUTCOMES.has(error.inventoryOutcome)) {
    safe.inventoryOutcome = error.inventoryOutcome;
    safe.until = Number.isFinite(error.until) ? error.until : null;
  }
  return safe;
}

/** 唯一 IPRoyal 出口驱动，不购买、不开浏览器、不回退直连 Apple。 */
class InventoryDriver {
  constructor(gate, options = {}) {
    this.gate = gate;
    this.options = options;
    this.tunnel = new InventoryTunnel(gate);
  }
  /** 同进程合并候选选择，实际发送仍逐请求经过数据库闸门。 */
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
  /** 只读取显式配置的 IPRoyal 凭据，缺失或非法时关闭请求。 */
  async loadProxy() {
    try {
      const file = this.options.proxyFile || process.env.INVENTORY_PROXY_FILE;
      if (!file) throw new Error('NO_HEALTHY_PROXY');
      const proxy = readProxy(file);
      if (proxy.label !== PROVIDER_LABEL || proxy.tunnel?.provider !== 'iproyal')
        throw new Error('NO_HEALTHY_PROXY');
      return await this.tunnel.select(proxy);
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
