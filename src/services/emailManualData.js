/**
 * 人工邮件入库数据校验与规范化。
 * @module services/emailManualData
 */

const { ORDER_STATUSES } = require('../constants/business');
const {
  isValidEmail,
  isValidIdCard,
  isValidOrderNumber,
  isValidPhone,
} = require('../utils/helpers');
const { EMAIL_ERROR_CODES, EmailProcessingError } = require('./emailErrors');

const ORDER_URL_PATTERN = /^\/xc\/cn\/vieworder\/(W\d{10})\/[^/\s]+$/i;

function requiredString(value, maxLength, code, fieldName) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength) {
    throw new EmailProcessingError(code, `${fieldName}为空或超过长度限制`);
  }
  return normalized;
}

function optionalString(value, maxLength, code, fieldName) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return requiredString(value, maxLength, code, fieldName);
}

function validateOrderUrl(value, orderNumber) {
  const orderUrl = requiredString(value, 2048, EMAIL_ERROR_CODES.ORDER_URL_INVALID, '订单链接');
  try {
    const parsed = new URL(orderUrl);
    const match = parsed.pathname.match(ORDER_URL_PATTERN);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.apple.com.cn' || !match) {
      throw new Error('invalid');
    }
    if (match[1].toUpperCase() !== orderNumber) {
      throw new EmailProcessingError(
        EMAIL_ERROR_CODES.ORDER_URL_MISMATCH,
        '订单链接与订单号不一致'
      );
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof EmailProcessingError) {
      throw error;
    }
    throw new EmailProcessingError(EMAIL_ERROR_CODES.ORDER_URL_INVALID, '订单链接格式无效');
  }
}

function validateProducts(products) {
  if (!Array.isArray(products) || products.length === 0 || products.length > 50) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.PRODUCT_INVALID, '商品必须为 1 至 50 行');
  }
  return products.map((product, index) => {
    const model = requiredString(
      product?.model,
      50,
      EMAIL_ERROR_CODES.PRODUCT_INVALID,
      `第 ${index + 1} 行商品型号`
    ).toUpperCase();
    const name = requiredString(
      product?.name,
      300,
      EMAIL_ERROR_CODES.PRODUCT_INVALID,
      `第 ${index + 1} 行商品名称`
    );
    const quantity = Number(product?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new EmailProcessingError(
        EMAIL_ERROR_CODES.PRODUCT_INVALID,
        `第 ${index + 1} 行商品数量必须为 1 至 999 的整数`
      );
    }
    return { model, name, quantity, image: product?.image || null };
  });
}

function parseOrderDate(value) {
  const source = String(value || '').trim();
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(source)
    ? `${source}+08:00`
    : source;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.ORDER_DATE_INVALID, '订单时间格式无效');
  }
  return date;
}

/**
 * 校验管理员提交的完整订单草稿。
 * @param {Object} input - 人工草稿
 * @returns {Object} 规范化订单数据
 */
function validateManualOrderData(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.INVALID_STATE, '人工草稿必须是对象');
  }

  const appleId = requiredString(
    input.appleId,
    255,
    EMAIL_ERROR_CODES.APPLE_ID_INVALID,
    'Apple ID'
  ).toLowerCase();
  if (!isValidEmail(appleId)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.APPLE_ID_INVALID, 'Apple ID 格式无效');
  }

  const orderNumber = requiredString(
    input.orderNumber,
    20,
    EMAIL_ERROR_CODES.ORDER_NUMBER_INVALID,
    '订单号'
  ).toUpperCase();
  if (!isValidOrderNumber(orderNumber)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.ORDER_NUMBER_INVALID, '订单号格式无效');
  }

  const orderDate = parseOrderDate(input.orderDate);

  const recipient = input.recipient || {};
  const recipientName = requiredString(
    recipient.name,
    100,
    EMAIL_ERROR_CODES.RECIPIENT_INVALID,
    '取机人姓名'
  );
  const idCard = optionalString(
    recipient.idCard,
    18,
    EMAIL_ERROR_CODES.RECIPIENT_INVALID,
    '完整身份证号'
  );
  if (idCard && !isValidIdCard(idCard)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.RECIPIENT_INVALID, '完整身份证号格式无效');
  }
  const idLast4 = (idCard ? idCard.slice(-4) : recipient.idLast4 || '').toUpperCase();
  if (!/^[0-9A-Z]{4}$/.test(idLast4)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.RECIPIENT_INVALID, '身份证后四位格式无效');
  }

  const phone = optionalString(
    recipient.phone,
    20,
    EMAIL_ERROR_CODES.RECIPIENT_INVALID,
    '取机人手机号'
  );
  if (phone && !isValidPhone(phone)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.RECIPIENT_INVALID, '取机人手机号格式无效');
  }
  const email = optionalString(
    recipient.email,
    255,
    EMAIL_ERROR_CODES.RECIPIENT_INVALID,
    '取机人邮箱'
  );
  if (email && !isValidEmail(email)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.RECIPIENT_INVALID, '取机人邮箱格式无效');
  }

  const orderStatus = input.orderStatus || 'pending';
  if (!ORDER_STATUSES.includes(orderStatus)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.INVALID_STATE, '系统内部状态无效');
  }

  return {
    appleId,
    applePassword: optionalString(
      input.applePassword,
      255,
      EMAIL_ERROR_CODES.APPLE_ID_INVALID,
      'Apple 密码'
    ),
    orderNumber,
    orderUrl: validateOrderUrl(input.orderUrl, orderNumber),
    orderDate,
    products: validateProducts(input.products),
    recipient: {
      name: recipientName,
      idLast4,
      idCard,
      email,
      phone,
      address: optionalString(
        recipient.address,
        500,
        EMAIL_ERROR_CODES.RECIPIENT_INVALID,
        '取机人地址'
      ),
      tag: requiredString(recipient.tag, 100, EMAIL_ERROR_CODES.TAG_INVALID, '标签'),
    },
    paymentMethod: requiredString(
      input.paymentMethod,
      50,
      EMAIL_ERROR_CODES.PAYMENT_METHOD_INVALID,
      '付款方式'
    ),
    orderStatus,
  };
}

module.exports = { validateManualOrderData };
