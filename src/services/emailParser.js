/**
 * 邮件解析器。
 * @description 对 MIME 只解析一次，并严格提取 NULL AOS Helper 订单字段。
 */

const cheerio = require('cheerio');
const { simpleParser } = require('mailparser');

const logger = require('../utils/logger');
const { decodeHTMLEntities, isValidEmail, isValidOrderNumber } = require('../utils/helpers');
const { EMAIL_ERROR_CODES, EmailProcessingError } = require('./emailErrors');

const MAX_MIME_BYTES = 10 * 1024 * 1024;
const MAX_PRODUCTS = 50;
const ORDER_TIMEZONE_OFFSET = '+08:00';
const APPLE_ORDER_HOST = 'www.apple.com.cn';
const ORDER_PATH_PATTERN = /^\/xc\/cn\/vieworder\/(W\d{10})\/[^/\s]+$/i;
const PRODUCT_PATTERN = /^([A-Z0-9][A-Z0-9/]{1,49})\s*-\s*(.{1,300}?)\s+x\s+([1-9]\d{0,2})$/i;
const ORDER_BLOCK_PATTERN =
  /^(.+\sx\s+[1-9]\d{0,2})\/([^/]{1,100})\/([^/]{4})\/([^/]{1,50})\/([^/]*)\/([^/]*)\/([^/]{1,100})$/i;

/**
 * 将外部 MIME 输入统一为 Buffer。
 * @param {Buffer|string} rawEmail - 原始 MIME
 * @returns {Buffer} MIME Buffer
 */
function normalizeRawEmail(rawEmail) {
  if (Buffer.isBuffer(rawEmail)) {
    return rawEmail;
  }
  if (typeof rawEmail === 'string') {
    return Buffer.from(rawEmail, 'utf8');
  }
  throw new EmailProcessingError(
    EMAIL_ERROR_CODES.MIME_PARSE_FAILED,
    '原始邮件必须是 Buffer 或字符串'
  );
}

/**
 * 解析 MIME；调用方应复用返回对象完成元数据过滤和订单解析。
 * @param {Buffer|string} rawEmail - 原始 MIME
 * @param {number|null} [emailRecordId=null] - 内部邮件记录 ID
 * @returns {Promise<{ parsed: Object, rawBuffer: Buffer }>} MIME 结果
 */
async function parseMimeEmail(rawEmail, emailRecordId = null) {
  const rawBuffer = normalizeRawEmail(rawEmail);
  if (rawBuffer.length === 0) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.BODY_MISSING, '原始邮件为空');
  }
  if (rawBuffer.length > MAX_MIME_BYTES) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.MIME_TOO_LARGE, '原始邮件超过 10MB 限制');
  }

  try {
    const parsed = await simpleParser(rawBuffer);
    return { parsed, rawBuffer };
  } catch (error) {
    logger.warn('MIME 解析失败', {
      emailRecordId,
      errorCode: EMAIL_ERROR_CODES.MIME_PARSE_FAILED,
    });
    throw new EmailProcessingError(EMAIL_ERROR_CODES.MIME_PARSE_FAILED, 'MIME 无法解析', {
      cause: error,
    });
  }
}

function normalizeLines(value) {
  return decodeHTMLEntities(String(value || ''))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t\u00a0 ]+/g, ' ').trim())
    .filter(Boolean);
}

function htmlToLines(html) {
  if (!html || typeof html !== 'string') {
    return [];
  }
  const $ = cheerio.load(html);
  $('br').replaceWith('\n');
  $('p,div,tr,li,section,article').each((_index, element) => {
    $(element).append('\n');
  });
  return normalizeLines($.root().text());
}

function getBodyLines(parsed) {
  const lines = [...normalizeLines(parsed.text), ...htmlToLines(parsed.html)];
  if (lines.length === 0) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.BODY_MISSING, '邮件正文为空');
  }
  return [...new Set(lines)];
}

function extractAppleId(lines) {
  for (const line of lines) {
    const match = line.match(/\*\*\*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (match && isValidEmail(match[1])) {
      return match[1].trim().toLowerCase();
    }
  }
  throw new EmailProcessingError(EMAIL_ERROR_CODES.APPLE_ID_INVALID, 'Apple ID 缺失或格式无效');
}

function extractOrderDate(lines) {
  for (const line of lines) {
    const match = line.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (!match) {
      continue;
    }
    const [, year, month, day, hour, minute, second] = match;
    const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(
      2,
      '0'
    )}:${minute}:${second}${ORDER_TIMEZONE_OFFSET}`;
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  throw new EmailProcessingError(EMAIL_ERROR_CODES.ORDER_DATE_INVALID, '订单时间缺失或格式无效');
}

function collectCandidateUrls(parsed, lines) {
  const sources = [typeof parsed.html === 'string' ? parsed.html : '', ...lines];
  const urls = [];
  sources.forEach(source => {
    const matches = source.match(
      /https:\/\/www\.apple\.com\.cn\/xc\/cn\/vieworder\/W\d{10}\/[^\s'"<>]+/gi
    );
    if (matches) {
      urls.push(...matches);
    }
  });
  return [...new Set(urls.map(url => decodeHTMLEntities(url).replace(/[，。；、]+$/, '')))];
}

function extractOrderLink(parsed, lines) {
  for (const candidate of collectCandidateUrls(parsed, lines)) {
    try {
      const url = new URL(candidate);
      const match = url.pathname.match(ORDER_PATH_PATTERN);
      if (url.protocol === 'https:' && url.hostname === APPLE_ORDER_HOST && match) {
        return { orderUrl: url.toString(), orderNumber: match[1].toUpperCase() };
      }
    } catch (_error) {
      // 继续检查其他候选链接。
    }
  }
  throw new EmailProcessingError(EMAIL_ERROR_CODES.ORDER_URL_INVALID, 'Apple 订单链接缺失或无效');
}

function findOrderBlock(lines) {
  for (const line of lines) {
    const modelStart = line.search(/[A-Z0-9][A-Z0-9/]{1,49}\s*-/i);
    if (modelStart < 0) {
      continue;
    }
    const match = line.slice(modelStart).trim().match(ORDER_BLOCK_PATTERN);
    if (match) {
      return match;
    }
  }
  throw new EmailProcessingError(
    EMAIL_ERROR_CODES.ORDER_BLOCK_MISSING,
    '订单信息块缺失或尾部字段边界无效'
  );
}

function parseProducts(productsSection) {
  const items = productsSection.split('@').map(item => item.trim());
  if (items.length === 0 || items.length > MAX_PRODUCTS || items.some(item => !item)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.PRODUCT_INVALID, '商品列表数量或分隔格式无效');
  }

  return items.map(item => {
    const match = item.match(PRODUCT_PATTERN);
    if (!match) {
      throw new EmailProcessingError(
        EMAIL_ERROR_CODES.PRODUCT_INVALID,
        '至少一个商品的型号、名称或数量无效'
      );
    }
    return {
      model: match[1].trim().toUpperCase(),
      name: match[2].trim(),
      quantity: Number(match[3]),
      image: null,
    };
  });
}

function extractProductInfo(lines) {
  const match = findOrderBlock(lines);
  const recipientName = match[2].trim();
  const recipientIdLast4 = match[3].trim().toUpperCase();
  const paymentMethod = match[4].trim();
  const recipientTag = match[7].trim();

  if (!recipientName || recipientName.length > 100 || !/^[\p{L}\p{N} .·-]+$/u.test(recipientName)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.RECIPIENT_INVALID, '取机人姓名格式无效');
  }
  if (!/^[0-9A-Z]{4}$/.test(recipientIdLast4)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.RECIPIENT_INVALID, '身份证后四位格式无效');
  }
  if (!paymentMethod || paymentMethod.length > 50) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.PAYMENT_METHOD_INVALID, '付款方式格式无效');
  }
  if (!recipientTag || recipientTag.length > 100) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.TAG_INVALID, '标签为空或超过长度限制');
  }

  return {
    products: parseProducts(match[1].trim()),
    recipientName,
    recipientIdLast4,
    paymentMethod,
    recipientTag,
  };
}

/**
 * 从已解析 MIME 构建严格订单数据，避免重复调用 mailparser。
 * @param {Object} parsed - mailparser 解析结果
 * @param {Buffer} rawBuffer - 原始 MIME Buffer
 * @param {number|null} [emailRecordId=null] - 内部邮件记录 ID
 * @returns {Object} 标准订单数据
 */
function parseOrderEmailFromParsed(parsed, rawBuffer, emailRecordId = null) {
  try {
    const lines = getBodyLines(parsed);
    const appleId = extractAppleId(lines);
    const orderDate = extractOrderDate(lines);
    const { orderUrl, orderNumber } = extractOrderLink(parsed, lines);
    const productInfo = extractProductInfo(lines);

    if (!isValidOrderNumber(orderNumber)) {
      throw new EmailProcessingError(EMAIL_ERROR_CODES.ORDER_NUMBER_INVALID, '订单号格式无效');
    }
    const urlOrderNumber = new URL(orderUrl).pathname.match(ORDER_PATH_PATTERN)?.[1]?.toUpperCase();
    if (urlOrderNumber !== orderNumber) {
      throw new EmailProcessingError(
        EMAIL_ERROR_CODES.ORDER_URL_MISMATCH,
        '订单链接与订单号不一致'
      );
    }

    const result = {
      appleId,
      orderNumber,
      orderUrl,
      orderDate,
      products: productInfo.products,
      recipient: {
        name: productInfo.recipientName,
        idLast4: productInfo.recipientIdLast4,
        tag: productInfo.recipientTag,
      },
      paymentMethod: productInfo.paymentMethod,
      emailSubject: parsed.subject || '',
      emailFrom: parsed.from?.text || '',
      emailDate: parsed.date || new Date(),
      rawContent: rawBuffer.toString('base64'),
    };

    logger.info('邮件解析成功', {
      emailRecordId,
      productCount: result.products.length,
      status: 'parsed',
    });
    return result;
  } catch (error) {
    let stableError = error;
    if (!(error instanceof EmailProcessingError)) {
      stableError = new EmailProcessingError(EMAIL_ERROR_CODES.UNKNOWN, '邮件字段解析失败', {
        cause: error,
      });
    }
    logger.warn('邮件字段解析失败', {
      emailRecordId,
      errorCode: stableError.code,
    });
    throw stableError;
  }
}

/**
 * 解析订单邮件。
 * @param {Buffer|string} rawEmail - 原始 MIME
 * @param {string|number|null} [_emailUid=null] - 兼容旧调用的 UID，不写入日志
 * @returns {Promise<Object>} 标准订单数据
 */
async function parseOrderEmail(rawEmail, _emailUid = null) {
  const { parsed, rawBuffer } = await parseMimeEmail(rawEmail);
  return parseOrderEmailFromParsed(parsed, rawBuffer);
}

/**
 * 从已解析 MIME 提取来源过滤所需元数据。
 * @param {Object} parsed - mailparser 解析结果
 * @returns {Object} 规范化元数据
 */
function extractEmailMetadataFromParsed(parsed) {
  return {
    from: parsed.from?.text || '',
    fromAddresses: (parsed.from?.value || [])
      .map(sender => sender.address?.trim().toLowerCase())
      .filter(Boolean),
    subject: parsed.subject || '',
    date: parsed.date || new Date(),
    messageId: parsed.messageId || null,
    authenticationResults: parsed.headers?.get('authentication-results') || null,
  };
}

/**
 * 兼容旧调用：解析 MIME 并提取元数据。解析失败会抛出稳定错误，不再降级为空元数据。
 * @param {Buffer|string} rawEmail - 原始 MIME
 * @returns {Promise<Object>} 元数据
 */
async function extractEmailMetadata(rawEmail) {
  const { parsed } = await parseMimeEmail(rawEmail);
  return extractEmailMetadataFromParsed(parsed);
}

module.exports = {
  parseMimeEmail,
  parseOrderEmailFromParsed,
  parseOrderEmail,
  extractEmailMetadataFromParsed,
  extractEmailMetadata,
  parseProducts,
};
