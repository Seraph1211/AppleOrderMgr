const axios = require('axios');
const ApiError = require('../utils/ApiError');
const { MAX_TEXT_BYTES } = require('./wecomNotificationContent');

/** 严格校验官方 Webhook，不允许重定向、任意主机或额外参数。 @param {string} value 地址 @returns {string} 规范地址 */
function validateWebhook(value) {
  try {
    if (typeof value !== 'string' || value.length > 512 || value !== value.trim())
      throw new Error();
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'qyapi.weixin.qq.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== '/cgi-bin/webhook/send' ||
      keys.length !== 1 ||
      keys[0] !== 'key' ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(url.searchParams.get('key'))
    )
      throw new Error();
    return url.toString();
  } catch (_error) {
    throw ApiError.badRequest('请输入有效的企业微信官方机器人 Webhook');
  }
}
/** 发送固定文本并返回脱敏结果，不向日志传播 Axios 原始错误。 @param {string} webhook 地址 @param {string} content 内容 @returns {Promise<Object>} 结果 */
async function sendText(webhook, content) {
  try {
    const url = validateWebhook(webhook);
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES)
      return { status: 'failed', errorCode: 'TEXT_TOO_LONG' };
    const response = await axios.post(
      url,
      { msgtype: 'text', text: { content } },
      {
        timeout: 10000,
        maxRedirects: 0,
        proxy: false,
        maxContentLength: 16384,
        validateStatus: () => true,
      }
    );
    if (response.status === 200 && response.data?.errcode === 0) return { status: 'accepted' };
    if (response.status === 429 || (response.status === 200 && response.data?.errcode === 45009))
      return { status: 'pending', errorCode: 'RATE_LIMITED', retryMs: 60000 };
    if (response.status === 200 && [93000, 93004, 40058, 41001].includes(response.data?.errcode))
      return { status: 'failed', errorCode: 'WEBHOOK_REJECTED', pause: true };
    if (
      response.status === 200 &&
      Number.isInteger(response.data?.errcode) &&
      response.data.errcode !== 0
    )
      return { status: 'failed', errorCode: 'API_REJECTED', pause: true };
    return { status: 'unknown', errorCode: 'RESPONSE_UNKNOWN' };
  } catch (error) {
    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error.code))
      return { status: 'pending', errorCode: 'CONNECT_FAILED', retryMs: 10000 };
    return { status: 'unknown', errorCode: 'TRANSPORT_UNKNOWN' };
  }
}
module.exports = { validateWebhook, sendText };
