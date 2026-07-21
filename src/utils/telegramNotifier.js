const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('./logger');
const { config } = require('./config');

/**
 * 构造 Telegram 请求代理配置
 * @param {string|undefined} proxyUrl - 代理 URL
 * @returns {Object} axios 请求配置片段
 */
function buildTelegramAgentConfig(proxyUrl) {
  if (!proxyUrl) {
    return {};
  }

  try {
    const parsedUrl = new URL(proxyUrl);
    const protocol = parsedUrl.protocol.toLowerCase();
    const agent = protocol.startsWith('socks')
      ? new SocksProxyAgent(proxyUrl)
      : new HttpsProxyAgent(proxyUrl);

    return {
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
    };
  } catch (error) {
    logger.error('Telegram 代理配置解析失败', { error: error.message });
    return {};
  }
}

/**
 * 发送 Telegram 告警
 * @param {string} title - 告警标题
 * @param {Object} payload - 告警上下文
 * @returns {Promise<boolean>} 是否发送成功
 */
async function sendTelegramAlert(title, payload = {}) {
  try {
    if (!config.telegram.enabled) {
      return false;
    }

    if (!config.telegram.botToken || !config.telegram.chatId) {
      logger.warn('Telegram 告警未发送：配置缺失', {
        hasBotToken: Boolean(config.telegram.botToken),
        hasChatId: Boolean(config.telegram.chatId),
      });
      return false;
    }

    const lines = [
      `[AppleOrderMgr] ${title}`,
      `时间: ${new Date().toISOString()}`,
    ];

    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      }
    });

    const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
    const messagePayload = {
      text: lines.join('\n'),
    };
    messagePayload['chat_id'] = config.telegram.chatId;
    messagePayload['disable_web_page_preview'] = true;

    await axios.post(url, messagePayload, {
      timeout: config.telegram.timeout,
      ...buildTelegramAgentConfig(config.telegram.proxyUrl),
    });

    logger.info('Telegram 告警发送成功', {
      title,
      hasProxy: Boolean(config.telegram.proxyUrl),
    });
    return true;
  } catch (error) {
    logger.error('Telegram 告警发送失败', {
      title,
      error: error.message,
      statusCode: error.response?.status,
    });
    return false;
  }
}

module.exports = {
  buildTelegramAgentConfig,
  sendTelegramAlert,
};
