/**
 * 通用工具函数模块
 * 功能：提供项目中常用的工具函数
 * 作者：Seraph
 * 更新：2026-07-06
 */

const logger = require('./logger');

/**
 * 延迟执行（用于爬虫请求间隔）
 * @param {number} ms - 延迟时间（毫秒）
 * @returns {Promise<void>}
 */
const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * 验证 W 订单号格式
 * @param {string} orderNumber - 订单号
 * @returns {boolean} 是否为有效的 W 订单号
 */
const isValidOrderNumber = (orderNumber) => {
  if (!orderNumber || typeof orderNumber !== 'string') {
    return false;
  }
  return /^W\d{10}$/.test(orderNumber);
};

/**
 * 验证邮箱格式
 * @param {string} email - 邮箱地址
 * @returns {boolean} 是否为有效的邮箱地址
 */
const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return false;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * 验证手机号格式
 * @param {string} phone - 手机号
 * @returns {boolean} 是否为有效的手机号
 */
const isValidPhone = (phone) => {
  if (!phone || typeof phone !== 'string') {
    return false;
  }
  // 支持中国大陆手机号：1开头的11位数字
  const phoneRegex = /^1[3-9]\d{9}$/;
  return phoneRegex.test(phone);
};

/**
 * 验证身份证号格式
 * @param {string} idCard - 身份证号
 * @returns {boolean} 是否为有效的身份证号
 */
const isValidIdCard = (idCard) => {
  if (!idCard || typeof idCard !== 'string') {
    return false;
  }
  // 支持15位或18位身份证号
  const idCardRegex = /(^\d{15}$)|(^\d{18}$)|(^\d{17}(\d|X|x)$)/;
  return idCardRegex.test(idCard);
};

/**
 * 安全地解析 JSON 字符串
 * @param {string} jsonString - JSON 字符串
 * @param {*} defaultValue - 解析失败时的默认值
 * @returns {*} 解析后的对象或默认值
 */
const safeJSONParse = (jsonString, defaultValue = null) => {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    logger.warn('JSON 解析失败', {
      error: error.message,
      jsonString: jsonString?.substring(0, 100),
    });
    return defaultValue;
  }
};

/**
 * 清理字符串中的控制字符
 * @param {string} str - 待清理的字符串
 * @returns {string} 清理后的字符串
 */
const removeControlCharacters = (str) => {
  if (!str || typeof str !== 'string') {
    return '';
  }
  // 移除 0x00-0x1F 和 0x7F 控制字符
  return Array.from(str)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
};

/**
 * 解码 HTML 实体
 * @param {string} html - 包含 HTML 实体的字符串
 * @returns {string} 解码后的字符串
 */
const decodeHTMLEntities = (html) => {
  if (!html || typeof html !== 'string') {
    return '';
  }

  const entities = {
    '&nbsp;': ' ',
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': '\'',
    '&apos;': '\'',
  };

  return html.replace(/&[#\w]+;/g, (entity) => {
    return entities[entity] || entity;
  });
};

/**
 * 清理 HTML 标签
 * @param {string} html - 包含 HTML 标签的字符串
 * @returns {string} 去除 HTML 标签后的纯文本
 */
const stripHTMLTags = (html) => {
  if (!html || typeof html !== 'string') {
    return '';
  }
  return html.replace(/<[^>]*>/g, '');
};

/**
 * 重试函数执行（带指数退避）
 * @param {Function} fn - 要执行的异步函数
 * @param {Object} options - 重试选项
 * @param {number} options.maxRetries - 最大重试次数
 * @param {number} options.initialDelay - 初始延迟（毫秒）
 * @param {number} options.maxDelay - 最大延迟（毫秒）
 * @param {Function} options.shouldRetry - 判断是否应该重试的函数
 * @returns {Promise<*>} 函数执行结果
 * @throws {Error} 当重试次数耗尽后抛出最后一次的错误
 */
const retryWithBackoff = async (fn, options = {}) => {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    shouldRetry = () => true,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 检查是否应该重试
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // 计算延迟时间（指数退避）
      const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);

      logger.warn('函数执行失败，准备重试', {
        attempt: attempt + 1,
        maxRetries,
        delay,
        error: error.message,
      });

      await sleep(delay);
    }
  }

  throw lastError;
};

/**
 * 格式化文件大小
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的文件大小字符串
 */
const formatBytes = (bytes) => {
  if (bytes === 0) {
    return '0 Bytes';
  }

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

/**
 * 生成随机字符串
 * @param {number} length - 字符串长度
 * @returns {string} 随机字符串
 */
const generateRandomString = (length = 8) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
};

/**
 * 深度克隆对象
 * @param {*} obj - 要克隆的对象
 * @returns {*} 克隆后的对象
 */
const deepClone = (obj) => {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }

  if (obj instanceof Array) {
    return obj.map((item) => deepClone(item));
  }

  if (obj instanceof Object) {
    const clonedObj = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        clonedObj[key] = deepClone(obj[key]);
      }
    }
    return clonedObj;
  }

  return obj;
};

/**
 * 截断字符串
 * @param {string} str - 原始字符串
 * @param {number} maxLength - 最大长度
 * @param {string} suffix - 截断后的后缀
 * @returns {string} 截断后的字符串
 */
const truncateString = (str, maxLength = 100, suffix = '...') => {
  if (!str || str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - suffix.length) + suffix;
};

module.exports = {
  sleep,
  isValidOrderNumber,
  isValidEmail,
  isValidPhone,
  isValidIdCard,
  safeJSONParse,
  removeControlCharacters,
  decodeHTMLEntities,
  stripHTMLTags,
  retryWithBackoff,
  formatBytes,
  generateRandomString,
  deepClone,
  truncateString,
};
