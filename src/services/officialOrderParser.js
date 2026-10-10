const cheerio = require('cheerio');
const { explicitSerials } = require('./stockLifecycleRules');

const HTTP_OK = 200;
const MAX_BODY_BYTES = 8388608; // 8 MiB。
const MAX_NODES = 5000;
const MAX_DEPTH = 12;
const MAX_ITEMS = 100;
const MAX_NAME_LENGTH = 1000;
const MAX_STATUS_LENGTH = 100;
const ITEM_KEY = /^orderItem-\d+(?:of\d+)?(?:-\d+)*$/;
const ORDER_NUMBER = /^W\d{10}$/;
// 这里明确拒绝外部字段中的控制字符，不是匹配业务文本。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

function fault(code) {
  return Object.assign(new Error(code), { code });
}

function validateInput(body, expectedOrderNumber) {
  if (typeof expectedOrderNumber !== 'string' || !ORDER_NUMBER.test(expectedOrderNumber)) {
    throw fault('INVALID_EXPECTED_ORDER');
  }
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw fault('INVALID_BODY');
  }
}

function jsonModels(body) {
  try {
    return [JSON.parse(body)];
  } catch (_error) {
    const models = [];
    const $ = cheerio.load(body);
    $('script').each((_index, element) => {
      const content = $(element).html() || '';
      if (
        !content.includes('orderDetail') &&
        !content.includes('orderList') &&
        !content.includes('orderInvoices')
      ) {
        return;
      }
      try {
        models.push(JSON.parse(content));
      } catch (_parseError) {
        // 不执行 JavaScript；赋值表达式和加载脚本不是订单数据。
      }
    });
    return models;
  }
}

function findModels(input, name) {
  const queue = [{ value: input, depth: 0 }];
  const found = [];
  let visited = 0;
  while (queue.length && visited < MAX_NODES) {
    visited += 1;
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object') {
      continue;
    }
    if (depth > MAX_DEPTH) {
      throw fault('MODEL_LIMIT');
    }
    if (Object.prototype.hasOwnProperty.call(value, name)) {
      found.push(value[name]);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== name && child && typeof child === 'object') {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  if (queue.length) {
    throw fault('MODEL_LIMIT');
  }
  return found;
}

function onlyModel(body, name) {
  const found = jsonModels(body).flatMap(model => findModels(model, name));
  if (found.length > 1) {
    throw fault('AMBIGUOUS_MODEL');
  }
  return found[0] || null;
}

function validText(value, maximum) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/https?:\/\/|[\w.+-]+@[\w.-]+/.test(value) &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function quantityValue(value) {
  if (
    !(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  ) {
    throw fault('INVALID_QUANTITY');
  }
  return Number(value);
}

function itemKeys(source, pattern) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw fault('INVALID_ITEMS');
  }
  const keys = Object.keys(source).filter(key => pattern.test(key));
  if (!keys.length || keys.length > MAX_ITEMS || !Array.isArray(source.c)) {
    throw fault('INVALID_ITEMS');
  }
  const listed = source.c.filter(key => typeof key === 'string' && pattern.test(key));
  if (
    listed.length !== keys.length ||
    new Set(listed).size !== listed.length ||
    listed.some(key => !keys.includes(key))
  ) {
    throw fault('INCOMPLETE_ITEMS');
  }
  return listed;
}

/**
 * 解析官方详情响应的最小字段，不读取邮件或补造缺失状态。
 * @param {string} body 官网 JSON 或包含 JSON 模型的 HTML。
 * @param {string} expectedOrderNumber 已验证的系统订单号。
 * @returns {object|null} 完整详情；非详情页返回 null，身份或字段错误抛出稳定错误码。
 */
function parseOfficialOrderDetail(body, expectedOrderNumber) {
  validateInput(body, expectedOrderNumber);
  const detail = onlyModel(body, 'orderDetail');
  if (!detail) {
    return null;
  }
  const orderNumber = detail.orderHeader?.d?.orderNumber;
  if (orderNumber !== expectedOrderNumber) {
    throw fault('IDENTITY_MISMATCH');
  }
  const keys = itemKeys(detail.orderItems, ITEM_KEY);
  const products = keys.map(key => {
    const item = detail.orderItems[key];
    const data = item?.orderItemDetails?.d;
    const name = data?.productName || data?.itemShortName;
    const rawStatus = item?.orderItemStatusTracker?.d?.currentStatus;
    if (
      !validText(name, MAX_NAME_LENGTH) ||
      !validText(rawStatus, MAX_STATUS_LENGTH) ||
      !/^[A-Za-z0-9_ -]+$/.test(rawStatus)
    ) {
      throw fault('INCOMPLETE_CORE_FIELDS');
    }
    // 已验证退货详情模板的受限计数解释；不泛化其他负数或字符串。
    const returnQuantity =
      ['RETURN_STARTED', 'RETURN_EXPIRED'].includes(rawStatus) && data.quantity === -1;
    const quantityInterpretation =
      rawStatus === 'RETURN_STARTED'
        ? 'return_started_negative_one'
        : 'return_expired_negative_one';
    const quantity = returnQuantity ? 1 : quantityValue(data.quantity);
    const serialNumbers = returnQuantity ? [] : explicitSerials(data, quantity);
    return {
      key,
      name,
      quantity,
      ...(returnQuantity ? { rawQuantity: -1, quantityInterpretation } : {}),
      rawStatus,
      ...(serialNumbers.length ? { serialNumbers } : {}),
      pickupDateText:
        rawStatus === 'PICKED_UP' && validText(data.deliveryDate, MAX_NAME_LENGTH)
          ? data.deliveryDate
          : null,
    };
  });
  return {
    orderNumber,
    identityMatched: true,
    sourceModel: 'orderDetail',
    orderPlacedDateText: validText(detail.orderHeader?.d?.orderPlacedDate, MAX_STATUS_LENGTH)
      ? detail.orderHeader.d.orderPlacedDate
      : null,
    completeItemCount: products.length,
    products,
  };
}

/**
 * 读取目标订单的列表摘要和官网提供的详情入口。
 * 列表的 deliveryDate 保留为原文，不能等同于详情状态枚举或完整商品规格。
 * @param {string} body 官网 JSON 或 HTML。
 * @param {string} expectedOrderNumber 已验证的系统订单号。
 * @returns {object|null} 身份匹配的摘要；缺失目标时返回 null，缺项时抛错。
 */
function parseOfficialOrderList(body, expectedOrderNumber) {
  validateInput(body, expectedOrderNumber);
  const list = onlyModel(body, 'orderList');
  const order = list?.[`order-${expectedOrderNumber}`];
  if (!order) {
    return null;
  }
  if (order.d?.webOrderNumber !== expectedOrderNumber) {
    throw fault('IDENTITY_MISMATCH');
  }
  const products = itemKeys(order, /^\d+$/).map(key => {
    const data = order[key]?.d;
    if (
      !validText(data?.productShortName, MAX_NAME_LENGTH) ||
      !validText(data?.deliveryDate, MAX_STATUS_LENGTH) ||
      typeof data?.orderDetailUrl !== 'string'
    ) {
      throw fault('INCOMPLETE_CORE_FIELDS');
    }
    return {
      key,
      name: data.productShortName,
      quantity: quantityValue(data.quantity),
      rawStatusText: data.deliveryDate,
      statusSourceField: 'deliveryDate',
      detailUrl: data.orderDetailUrl,
    };
  });
  return {
    orderNumber: order.d.webOrderNumber,
    identityMatched: true,
    sourceModel: 'orderList',
    completeItemCount: products.length,
    products,
  };
}

/**
 * 判断是否为可解析的中国大陆官网订单响应，包含访客 fetchOrder 的 orderx 路径。
 * @param {object} response 脱敏网络元数据。
 * @returns {boolean} 是否进入订单解析；HTTP 200 本身不是取数成功。
 */
function isOfficialOrderResponse(response) {
  return Boolean(
    response &&
    response.status === HTTP_OK &&
    !response.cached &&
    /^(?:secure\d*\.)?www\.apple\.com\.cn$/.test(response.host || '') &&
    /^\/shop\/order(?:x)?\/(?:list|detail|guest|guestx)(?:\/|$)/.test(response.path || '')
  );
}

/** 有界读取唯一模型；收据和详情共享同一嵌套 JSON 身份边界。 */
function readOfficialModel(body, name) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY_BYTES)
    throw fault('INVALID_BODY');
  return onlyModel(body, name);
}

module.exports = {
  parseOfficialOrderDetail,
  parseOfficialOrderList,
  isOfficialOrderResponse,
  readOfficialModel,
};
