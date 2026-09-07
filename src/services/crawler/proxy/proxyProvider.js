const KdlTunnelProvider = require('./kdlTunnelProvider');
const KdlPrivateProvider = require('./kdlPrivateProvider');

const SUPPORTED_PROXY_PROVIDERS = ['kdl_tunnel', 'kdl_private'];

/**
 * 判断 Provider 名称是否受支持。
 * @param {string} providerName - Provider 名称
 * @returns {boolean} 是否受支持
 */
function isSupportedProxyProvider(providerName) {
  return SUPPORTED_PROXY_PROVIDERS.includes(providerName);
}

/**
 * 判断指定 Provider 的环境配置是否完整。
 * @param {Object} proxyConfig - 代理配置
 * @param {string} providerName - Provider 名称
 * @returns {boolean} 是否具备初始化条件
 */
function isProxyProviderConfigured(proxyConfig, providerName) {
  if (providerName === 'kdl_tunnel') {
    const tunnel = proxyConfig?.tunnel || {};
    return Boolean(
      (tunnel.host || tunnel.backupHost) && tunnel.port && tunnel.username && tunnel.password
    );
  }
  if (providerName === 'kdl_private') return Boolean(proxyConfig?.apiUrl);
  return false;
}

/**
 * 根据配置创建代理 Provider。
 * @param {Object} proxyConfig - 代理配置
 * @returns {Object} Provider
 * @throws {Error} Provider 未知或配置对象缺失
 */
function createProxyProvider(proxyConfig) {
  if (!proxyConfig || !isSupportedProxyProvider(proxyConfig.provider)) {
    throw new Error('不支持的代理 Provider');
  }
  if (proxyConfig.provider === 'kdl_tunnel') {
    return new KdlTunnelProvider(proxyConfig.tunnel);
  }
  if (proxyConfig.provider === 'kdl_private') return new KdlPrivateProvider(proxyConfig);
  throw new Error('不支持的代理 Provider');
}

module.exports = {
  SUPPORTED_PROXY_PROVIDERS,
  isSupportedProxyProvider,
  isProxyProviderConfigured,
  createProxyProvider,
};
