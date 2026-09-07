const axios = require('axios');

const logger = require('../../../utils/logger');
const { config } = require('../../../utils/config');
const crawlerRateLimiter = require('../crawlerRateLimiter');

const APPLE_HEALTH_CHECK_URL = 'https://www.apple.com.cn/';
const HEALTH_CHECK_ATTEMPTS = 3;

/**
 * 创建不包含代理凭据和目标 URL 的稳定切换错误。
 * @param {string} code - 稳定错误码
 * @param {string} message - 脱敏错误说明
 * @returns {Error} 切换错误
 */
function createProxyHealthError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 通过全局限流器验证候选 Provider 能否访问 Apple 中国首页。
 * @param {Object} provider - 候选 Provider
 * @returns {Promise<Object>} 脱敏检查摘要
 * @throws {Error} 三次内无法建立有效连接
 */
async function validateProxyProviderCandidate(provider) {
  const providerName = provider.getStatus().provider;
  let lastCode = 'PROXY_HEALTH_CHECK_FAILED';

  for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt++) {
    let proxy = provider.getNextProxy();
    if (!proxy) {
      await provider.refresh();
      proxy = provider.getNextProxy();
    }
    if (!proxy) {
      lastCode = 'PROXY_POOL_EMPTY';
      continue;
    }

    try {
      await crawlerRateLimiter.acquire();
      const response = await axios.get(APPLE_HEALTH_CHECK_URL, {
        proxy: {
          host: proxy.host,
          port: proxy.port,
          protocol: 'http',
          auth: proxy.auth,
        },
        headers: {
          'User-Agent': config.crawler.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip',
          Connection: proxy.disableKeepAlive ? 'close' : 'keep-alive',
        },
        timeout: Math.min(config.crawler.timeout || 30000, 15000),
        validateStatus: status => status >= 200 && status < 400,
      });
      provider.recordProxySuccess(proxy);
      logger.info('候选代理 Provider 连通性检查通过', {
        provider: providerName,
        statusCode: response.status,
        attempt,
      });
      return { provider: providerName, statusCode: response.status, attempt };
    } catch (error) {
      const statusCode = error.response?.status;
      if (statusCode === 407) lastCode = 'PROXY_407';
      else if (statusCode === 441) lastCode = 'PROXY_441';
      else if (statusCode === 517) lastCode = 'PROXY_517';
      else if (statusCode === 541) lastCode = 'APPLE_541';
      else lastCode = 'PROXY_TRANSPORT';

      if (statusCode === 541) provider.markProxyAsBad(proxy);
      else if (statusCode !== 407 && statusCode !== 441) provider.recordProxyFailure(proxy);

      logger.warn('候选代理 Provider 连通性检查失败', {
        provider: providerName,
        statusCode: statusCode || null,
        errorCode: lastCode,
        attempt,
      });
      if (statusCode === 407 || statusCode === 441) break;
    }
  }

  throw createProxyHealthError(lastCode, '候选代理 Provider 连通性检查失败');
}

module.exports = { validateProxyProviderCandidate, createProxyHealthError };
