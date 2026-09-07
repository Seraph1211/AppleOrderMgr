const KdlTunnelProvider = require('./kdlTunnelProvider');
const KdlPrivateProvider = require('./kdlPrivateProvider');

/**
 * 根据配置创建代理 Provider。
 * @param {Object} proxyConfig - 代理配置
 * @returns {Object} Provider
 */
function createProxyProvider(proxyConfig) {
  if (proxyConfig.provider === 'kdl_tunnel') {
    return new KdlTunnelProvider(proxyConfig.tunnel);
  }
  return new KdlPrivateProvider(proxyConfig);
}

module.exports = { createProxyProvider };
