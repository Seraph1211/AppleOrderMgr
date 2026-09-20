const { normalizeProductName } = require('../utils/productFilter');
const { extractOrderNumber, htmlToText, mailText } = require('./orderMailContent');

const RULE_VERSION = 'apple-cn-pickup-v1';
const TEMPLATE_TYPES = Object.freeze({
  CONFIRMED: 'confirmed',
  PROCESSING: 'processing',
  READY_UPDATE: 'ready_update',
  READY_INFO: 'ready_info',
  EXCLUDED: 'excluded',
  UNKNOWN: 'unknown',
});

function cleanText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '')
    .trim();
}

function contentLines(parsed) {
  return cleanText(parsed.html ? htmlToText(parsed.html) : mailText(parsed))
    .split('\n')
    .map(line => cleanText(line))
    .filter(Boolean);
}

function classifyTemplate(subject) {
  const value = cleanText(subject);
  if (/^你的\s*Apple Store\s*在线商店订单\s*-?\s*W\d{10}$/i.test(value))
    return TEMPLATE_TYPES.CONFIRMED;
  if (/^我们正在处理你的订单\s+W\d{10}$/i.test(value)) return TEMPLATE_TYPES.PROCESSING;
  if (/^关于你的\s+Apple\s+订单\s+W\d{10}\s+的更新信息$/i.test(value))
    return TEMPLATE_TYPES.READY_UPDATE;
  if (/^订单\s+W\d{10}\s+的取货信息$/i.test(value)) return TEMPLATE_TYPES.READY_INFO;
  if (/电子收据|个人设置辅导|广告/i.test(value)) return TEMPLATE_TYPES.EXCLUDED;
  return TEMPLATE_TYPES.UNKNOWN;
}

function normalizeStoreName(value) {
  const name = cleanText(value)
    .replace(/^Apple\s*[,，]?\s*/i, '')
    .replace(/[›>]+$/g, '')
    .trim();
  return name ? `Apple ${name}` : null;
}

function parseStore(lines) {
  const labelIndex = lines.findIndex(line => /^取货零售店\s*[:：]?$/.test(line));
  if (labelIndex < 0) return { storeName: null, storeAddress: null };
  let cursor = labelIndex + 1;
  if (!lines[cursor]) return { storeName: null, storeAddress: null };
  let storeLine = lines[cursor++];
  if (/^Apple\s*$/i.test(storeLine) && lines[cursor]) storeLine += ` ${lines[cursor++]}`;
  const addressLines = [];
  for (; cursor < lines.length && addressLines.length < 4; cursor += 1) {
    const line = lines[cursor];
    if (/营业时间|取货政策|取货商品|店内取货商品|^\d{6}$|^400[ -]?\d+/i.test(line)) break;
    if (line === cleanText(storeLine).replace(/^Apple\s*[,，]?\s*/i, '')) continue;
    addressLines.push(line);
  }
  return {
    storeName: normalizeStoreName(storeLine),
    storeAddress: addressLines.join(' ') || null,
  };
}

function validDateString(year, month, day) {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${value}T00:00:00Z`);
  return date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
    ? value
    : null;
}

function parsePickupDate(lines) {
  for (const line of lines) {
    if (!/^取货日期\s*[:：]/.test(line)) continue;
    let match = line.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/);
    if (match) return validDateString(match[1], match[2], match[3]);
    match = line.match(/(\d{1,2})月\s*(\d{1,2})日[,，]?\s*(20\d{2})/);
    if (match) return validDateString(match[3], match[1], match[2]);
  }
  return null;
}

function to24Hour(hour, minute, meridiem) {
  let normalizedHour = Number(hour);
  const normalizedMinute = Number(minute);
  if (normalizedHour > 23 || normalizedMinute > 59) return null;
  if (meridiem) {
    if (normalizedHour < 1 || normalizedHour > 12) return null;
    normalizedHour %= 12;
    if (meridiem.toUpperCase() === 'PM') normalizedHour += 12;
  }
  return `${String(normalizedHour).padStart(2, '0')}:${String(normalizedMinute).padStart(2, '0')}`;
}

function parseTimeRange(lines) {
  for (const line of lines) {
    if (!/(?:到店时间|取货时间|签到时间)\s*[:：]/.test(line)) continue;
    const match = line.match(
      /(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[-–—至]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i
    );
    if (!match) continue;
    const sharedMeridiem = match[6] || match[3];
    const start = to24Hour(match[1], match[2], match[3] || sharedMeridiem);
    const end = to24Hour(match[4], match[5], match[6] || sharedMeridiem);
    if (start && end) return { start, end, raw: match[0] };
  }
  return null;
}

function isProductCandidate(line) {
  if (!line || line.length > 300) return false;
  if (
    /^(?:RMB|数量|取货日期|取货时间|签到时间|到店时间|取货商品|店内取货商品|待取货商品|已可取货|Apple 电子收据|查看|营业时间|有货|你的订单|当你的订单|请|提取|打造|来不了|如果|总计|小计)/i.test(
      line
    )
  )
    return false;
  if (/^(?:\d{6}|400[ -]?\d+)$/.test(line)) return false;
  return /[A-Za-z\u4e00-\u9fff]/.test(line);
}

function parseProducts(lines) {
  const products = [];
  for (let index = 0; index < lines.length; index += 1) {
    const quantityMatch = lines[index].match(/^数量\s*[:：]?\s*(\d{1,3})$/);
    if (!quantityMatch) continue;
    let name = null;
    for (let cursor = index - 1; cursor >= Math.max(0, index - 8); cursor -= 1) {
      if (isProductCandidate(lines[cursor])) {
        name = lines[cursor];
        break;
      }
    }
    if (name) products.push({ name, quantity: Number(quantityMatch[1]) });
  }
  return products;
}

function aggregateProducts(products) {
  const result = new Map();
  for (const product of products || []) {
    const key = normalizeProductName(product?.name);
    const quantity = Number(product?.quantity);
    if (!key || !Number.isInteger(quantity) || quantity < 1) continue;
    result.set(key, (result.get(key) || 0) + quantity);
  }
  return result;
}

/** 核对邮件商品范围是否完整覆盖已有订单，不允许部分商品触发整单结论。 */
function evaluateProductScope(mailProducts, orderProducts) {
  const mail = aggregateProducts(mailProducts);
  const order = aggregateProducts(orderProducts);
  if (!mail.size) return { matched: false, reason: 'MAIL_PRODUCTS_MISSING' };
  if (!order.size || mail.size !== order.size)
    return { matched: false, reason: 'PRODUCT_SCOPE_MISMATCH' };
  for (const [key, quantity] of order) {
    if (mail.get(key) !== quantity) return { matched: false, reason: 'PRODUCT_SCOPE_MISMATCH' };
  }
  return { matched: true, reason: null };
}

/**
 * 从一封已解析 MIME 中提取生命周期候选，不在此处信任来源或修改订单。
 * @param {Object} parsed mailparser 结果
 * @returns {Object} 受控解析结论
 */
function parseOrderMailLifecycle(parsed) {
  const lines = contentLines(parsed);
  const body = lines.join('\n');
  const templateType = classifyTemplate(parsed.subject);
  const orderNumber = extractOrderNumber(parsed);
  const products = parseProducts(lines);
  const store = parseStore(lines);
  const date = parsePickupDate(lines);
  const range = parseTimeRange(lines);
  const businessHours = /(?:店面|零售店)营业时间[>›]?内前往/.test(body);
  const retentionText = lines.find(line => /最长可?.*保留\s*7\s*天|最多保留\s*7\s*天/.test(line));
  const pickupInfo =
    store.storeName || store.storeAddress || date || range || businessHours
      ? {
        storeName: store.storeName,
        storeAddress: store.storeAddress,
        pickupDate: date,
        startTime: range?.start || null,
        endTime: range?.end || null,
        appointmentMode: businessHours ? 'business_hours' : range ? 'scheduled' : 'unknown',
        timeZone: 'Asia/Shanghai',
        retentionText: retentionText?.slice(0, 300) || null,
        rawTimeRange: range?.raw || null,
      }
      : null;

  const result = {
    ruleVersion: RULE_VERSION,
    templateType,
    orderNumber,
    orderStatus: null,
    paymentStatus: null,
    pickupInfo,
    products,
    needsReview: false,
    reviewReasons: [],
    evidence: {
      subjectMatched: templateType !== TEMPLATE_TYPES.UNKNOWN,
      bodyEventMatched: false,
    },
  };
  if (templateType === TEMPLATE_TYPES.EXCLUDED) return result;
  if (templateType === TEMPLATE_TYPES.CONFIRMED && /我们收到了你的订单/.test(body)) {
    result.orderStatus = 'confirmed';
    result.evidence.bodyEventMatched = true;
  } else if (templateType === TEMPLATE_TYPES.PROCESSING && /你的订单正在处理中/.test(body)) {
    result.orderStatus = 'processing';
    result.paymentStatus = 'paid';
    result.evidence.bodyEventMatched = true;
    result.evidence.paymentRule = 'processing_implies_prepaid_confirmed';
  } else if (
    [TEMPLATE_TYPES.READY_UPDATE, TEMPLATE_TYPES.READY_INFO].includes(templateType) &&
    /(?:已可取货|已备好并可取货)/.test(body)
  ) {
    result.orderStatus = 'ready_for_pickup';
    result.paymentStatus = 'paid';
    result.evidence.bodyEventMatched = true;
    result.evidence.paymentRule = 'ready_for_pickup_implies_prepaid_confirmed';
  } else if (templateType !== TEMPLATE_TYPES.UNKNOWN) {
    result.needsReview = true;
    result.reviewReasons.push('BODY_EVENT_NOT_CONFIRMED');
  } else if (/付款|退款|取消|取货|订单/.test(body)) {
    result.needsReview = true;
    result.reviewReasons.push('UNKNOWN_LIFECYCLE_TEMPLATE');
  }
  if (!orderNumber) {
    result.needsReview = true;
    result.reviewReasons.push('ORDER_NUMBER_AMBIGUOUS');
  }
  return result;
}

module.exports = {
  RULE_VERSION,
  TEMPLATE_TYPES,
  classifyTemplate,
  evaluateProductScope,
  parseOrderMailLifecycle,
  parsePickupDate,
  parseTimeRange,
};
