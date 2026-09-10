/* eslint-disable no-control-regex -- 校验并拒绝来源字段中的控制字符。 */
/** AOS 15 列解析、草稿及来源身份校验。 */
const ApiError = require('../utils/ApiError');

const DRAFT_FIELDS = [
  'orderNumber',
  'contactEmail',
  'appleId',
  'lastName',
  'firstName',
  'contactPhone',
  'pickupStoreCode',
  'products',
  'paymentMethod',
  'recipientTag',
  'orderUrl',
  'orderDate',
];
const PAYMENT_METHODS = new Map([
  ['微信', '微信'],
  ['wechat', '微信'],
  ['wechat pay', '微信'],
  ['支付宝', '支付宝'],
  ['alipay', '支付宝'],
]);

function issue(field, code, message) {
  return { field, code, message };
}

/** 严格验证业务草稿，不携带或回显密码。 @param {Object} input 草稿 @returns {Object} 结果 */
function validateAosDraft(input) {
  const issues = [];
  const data = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { data, issues: [issue('data', 'AOS_FIELD_INVALID', '草稿必须是对象')] };
  }
  for (const field of Object.keys(input)) {
    if (!DRAFT_FIELDS.includes(field)) issues.push(issue(field, 'AOS_FIELD_INVALID', '未知字段'));
  }
  const stringField = (field, max, pattern, nullable = false) => {
    const value = input[field];
    if (nullable && (value === null || value === undefined || value === '')) {
      data[field] = null;
    } else if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > max ||
      /[\u0000-\u001f\u007f]/.test(value) ||
      (pattern && !pattern.test(value))
    ) {
      issues.push(issue(field, 'AOS_FIELD_INVALID', '字段缺失或格式不合法'));
    } else data[field] = value;
  };
  stringField('orderNumber', 11, /^W\d{10}$/);
  for (const field of ['contactEmail', 'appleId'])
    stringField(field, 255, /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/);
  for (const field of ['lastName', 'firstName']) stringField(field, 50);
  stringField('contactPhone', 11, /^1[3-9]\d{9}$/);
  stringField('pickupStoreCode', 50, /^R\d+$/);
  stringField('recipientTag', 500, null, true);
  stringField('paymentMethod', 50);
  if (data.paymentMethod) {
    const method = PAYMENT_METHODS.get(data.paymentMethod.toLowerCase());
    if (method) data.paymentMethod = method;
    else issues.push(issue('paymentMethod', 'AOS_FIELD_INVALID', '未识别的支付方式，请人工核对'));
  }
  if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > 50) {
    issues.push(issue('products', 'AOS_PRODUCT_INVALID', '商品应为 1–50 项'));
  } else {
    data.products = input.products.map((p, index) => {
      if (
        !p ||
        typeof p !== 'object' ||
        Array.isArray(p) ||
        Object.keys(p).some(k => !['model', 'name', 'quantity'].includes(k)) ||
        typeof p.model !== 'string' ||
        !p.model.trim() ||
        p.model.length > 50 ||
        typeof p.name !== 'string' ||
        !p.name.trim() ||
        p.name.length > 300 ||
        /[\u0000-\u001f]/.test(p.model + p.name) ||
        !Number.isInteger(p.quantity) ||
        p.quantity < 1 ||
        p.quantity > 999
      ) {
        issues.push(issue(`products.${index}`, 'AOS_PRODUCT_INVALID', '商品型号、名称或数量无效'));
        return null;
      }
      return { model: p.model, name: p.name, quantity: p.quantity };
    });
  }
  const dateText = input.orderDate;
  if (
    typeof dateText !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(dateText) ||
    !Number.isFinite(Date.parse(dateText))
  ) {
    issues.push(issue('orderDate', 'AOS_ORDER_DATE_INVALID', '下单时间必须含完整日期、秒和时区'));
  } else {
    // Date.parse 会归一化 2 月 30 日，必须另行校验原本地日期。
    const day = dateText.slice(0, 10);
    if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
      issues.push(issue('orderDate', 'AOS_ORDER_DATE_INVALID', '下单日期不存在'));
    } else data.orderDate = new Date(dateText).toISOString();
  }
  try {
    if (
      typeof input.orderUrl !== 'string' ||
      input.orderUrl.length > 2048 ||
      /[\s\\]/.test(input.orderUrl)
    )
      throw new Error('invalid');
    const url = new URL(input.orderUrl);
    const parts = url.pathname.split('/');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.apple.com.cn' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !/^https:\/\/www\.apple\.com\.cn\/xc\/cn\/vieworder\/W\d{10}\/[^/?#]+$/.test(
        input.orderUrl
      ) ||
      parts.length !== 6 ||
      parts.slice(0, 4).join('/') !== '/xc/cn/vieworder' ||
      parts[4] !== data.orderNumber ||
      decodeURIComponent(parts[5]).toLowerCase() !== data.contactEmail?.toLowerCase()
    ) {
      throw new Error('identity');
    }
    data.orderUrl = input.orderUrl;
  } catch (_error) {
    issues.push(
      issue('orderUrl', 'AOS_ORDER_IDENTITY_MISMATCH', 'Apple 链接与订单号或联系邮箱不一致')
    );
  }
  return { data, issues };
}

/** 解析一条完整 AOS 行，坏行以 issues 返回，不抛出敏感文本。 @param {string} rawLine 原始行 @returns {Object} 解析结果 */
function parseAosLine(rawLine) {
  if (
    typeof rawLine !== 'string' ||
    Buffer.byteLength(rawLine, 'utf8') > 16384 ||
    /[\r\n]/.test(rawLine)
  ) {
    return {
      data: {},
      password: null,
      issues: [issue('rawLine', 'AOS_COLUMN_COUNT_INVALID', '原始行无效')],
    };
  }
  const columns = rawLine.replace(/^\uFEFF/, '').split('\t');
  if (columns.length !== 15) {
    return {
      data: {},
      password: null,
      issues: [issue('rawLine', 'AOS_COLUMN_COUNT_INVALID', '应有 15 列，请核对文件格式')],
    };
  }
  // 当前样本仅证明单商品语法；多商品使用明确分隔的相同语法，未知语法进入人工处理。
  const products = columns[10].split(/[;；]/).map(text => {
    const match = text.trim().match(/^([^\s]+?)-(.+?)\s+x\s+(\d+)$/i);
    return match ? { model: match[1], name: match[2], quantity: Number(match[3]) } : null;
  });
  const originalDate = columns[14];
  const orderDate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(originalDate)
    ? `${originalDate.replace(' ', 'T')}+08:00`
    : '';
  const result = validateAosDraft({
    orderNumber: columns[0].trim().toUpperCase(),
    contactEmail: columns[1],
    appleId: columns[2],
    lastName: columns[4],
    firstName: columns[5],
    pickupStoreCode: columns[6],
    contactPhone: columns[9],
    products,
    paymentMethod: columns[11],
    recipientTag: columns[12],
    orderUrl: columns[13],
    orderDate,
  });
  if (!columns[3] || columns[3].length > 1024)
    result.issues.push(issue('password', 'AOS_FIELD_INVALID', '密码缺失或长度无效'));
  return { ...result, password: columns[3] || null };
}

/** 校验 HTTP 完整草稿。 @param {Object} input 输入 @returns {Object} 标准化草稿 */
function requireAosDraft(input) {
  const { data, issues } = validateAosDraft(input);
  if (issues.length) throw ApiError.badRequest('草稿校验失败', { issues });
  return data;
}

module.exports = { parseAosLine, validateAosDraft, requireAosDraft };
