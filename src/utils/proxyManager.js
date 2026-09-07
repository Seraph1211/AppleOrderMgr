const { config } = require('./config');
const { createProxyProvider } = require('../services/crawler/proxy/proxyProvider');

const disabledProvider = {
  async initialize() {},
  async refresh() {},
  getNextProxy: () => null,
  recordProxyFailure: () => false,
  recordProxySuccess: () => {},
  markProxyAsBad: () => {},
  getStatus: () => ({ enabled: false, isInitialized: true, total: 0, available: 0, bad: 0 }),
};

const proxyManager = config.proxy.enabled ? createProxyProvider(config.proxy) : disabledProvider;

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

module.exports = proxyManager;
module.exports.maskProxyString = maskProxyString;
module.exports.summarizeProxyResponse = summarizeProxyResponse;
