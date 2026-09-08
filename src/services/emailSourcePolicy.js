const { config } = require('../utils/config');
const { EMAIL_ERROR_CODES } = require('./emailErrors');

/**
 * 判断邮件是否通过主题与可选 From 地址／域名白名单。
 * @param {Object} metadata - MIME 元数据
 * @returns {{ accepted: boolean, errorCode: string|null }} 来源判定
 */
function classifyOrderEmailSource(metadata) {
  const { subject = '', fromAddresses = [] } = metadata;
  const hasOrderKeyword =
    subject.includes('NULL') || subject.includes('预订助手') || subject.includes('预订成功');
  if (!hasOrderKeyword) {
    return { accepted: false, errorCode: EMAIL_ERROR_CODES.SUBJECT_NOT_ALLOWED };
  }

  const allowedSenders = config.imap.allowedSenders || [];
  const allowedSenderDomains = config.imap.allowedSenderDomains || [];
  if (allowedSenders.length === 0 && allowedSenderDomains.length === 0) {
    return { accepted: true, errorCode: null };
  }

  const normalizedAddresses = fromAddresses.map(address => String(address).trim().toLowerCase());
  const isAllowed = normalizedAddresses.some(address => {
    if (allowedSenders.includes(address)) {
      return true;
    }
    const separatorIndex = address.lastIndexOf('@');
    const domain = separatorIndex > 0 ? address.slice(separatorIndex + 1) : '';
    return allowedSenderDomains.includes(domain);
  });
  return isAllowed
    ? { accepted: true, errorCode: null }
    : { accepted: false, errorCode: EMAIL_ERROR_CODES.SENDER_NOT_ALLOWED };
}

/**
 * 判断是否为订单邮件。
 * @param {Object} metadata - MIME 元数据
 * @returns {boolean} 是否通过来源判定
 */
function isOrderEmail(metadata) {
  return classifyOrderEmailSource(metadata).accepted;
}

module.exports = { classifyOrderEmailSource, isOrderEmail };
