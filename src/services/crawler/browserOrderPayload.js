/* eslint-env browser, node */
// 同一实现由打包脚本复制到浏览器采集端，禁止在两端维护不同白名单。
const MAX_ITEMS = 100;
const MAX_TEXT = 1000;
const ITEM_KEY = /^orderItem-\d+(?:of\d+)?(?:-\d+)*$/;

/** 识别可信官网文档与详情动作；查询参数必须是明确的 _a=fetchOrder。 */
function isBrowserOrderResponse(url, resourceType) {
  return (
    url.protocol === 'https:' &&
    !url.port &&
    !url.username &&
    !url.password &&
    /^(?:secure\d*\.)?www\.apple\.com\.cn$/.test(url.hostname) &&
    (resourceType === 'Document' ||
      /(?:^|\/)fetchOrder(?:\/|$)/.test(url.pathname) ||
      url.searchParams.get('_a') === 'fetchOrder')
  );
}

function pickFields(input, fields) {
  const output = {};
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(input || {}, key)) continue;
    const value = input[key];
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      output[key] = value;
    } else if (
      typeof value === 'string' &&
      value.length <= MAX_TEXT &&
      !/https?:\/\/|[\w.+-]+@[\w.-]+/i.test(value)
    ) {
      output[key] = value;
    }
  }
  return output;
}

/** 仅提取订单身份、阶段与商品字段，排除金额、履约、联系资料和凭据。 */
function projectBrowserOrderJson(input, expectedOrderNumber) {
  const detail = input?.orderDetail;
  if (!detail || detail.orderHeader?.d?.orderNumber !== expectedOrderNumber) {
    throw new Error('官网响应订单身份不一致或缺失');
  }
  const sourceItems = detail.orderItems;
  if (!sourceItems || Array.isArray(sourceItems)) throw new Error('官网响应缺少商品');
  const allKeys = Object.keys(sourceItems).filter(key => ITEM_KEY.test(key));
  if (!allKeys.length || allKeys.length > MAX_ITEMS) throw new Error('官网商品条目数量无效');
  const listed = Array.isArray(sourceItems.c)
    ? sourceItems.c.filter(key => allKeys.includes(key))
    : [];
  const keys = [...new Set([...listed, ...allKeys])];
  const orderItems = { c: keys };
  for (const key of keys) {
    const item = sourceItems[key];
    orderItems[key] = {
      orderItemDetails: {
        d: pickFields(item?.orderItemDetails?.d, [
          'productName',
          'itemShortName',
          'partNumber',
          'sku',
          'productId',
          'modelNumber',
          'quantity',
          'eyeBrowNumber',
          'eyeBrowQuantity',
        ]),
      },
      orderItemStatusTracker: {
        d: pickFields(item?.orderItemStatusTracker?.d, ['currentStatus', 'statusDescription']),
      },
    };
  }
  return {
    orderDetail: {
      orderHeader: {
        d: pickFields(detail.orderHeader.d, ['orderNumber']),
      },
      orderItems,
    },
  };
}

/** 从正常响应的已解析 JSON 包装中查找唯一 orderDetail，避免递归无限增长。 */
function findBrowserOrderJson(input) {
  const queue = [{ value: input, depth: 0 }];
  const matches = [];
  let visited = 0;
  const MAX_NODES = 5000;
  const MAX_DEPTH = 12;
  while (queue.length && visited++ < MAX_NODES) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) continue;
    if (Object.prototype.hasOwnProperty.call(value, 'orderDetail')) {
      if (value.orderDetail?.orderHeader?.d?.orderNumber) matches.push(value);
      continue;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
  }
  if (queue.length || matches.length > 1) throw new Error('官网响应结构超限或包含多个订单');
  return matches[0] || null;
}

const browserOrderPayload = {
  projectBrowserOrderJson,
  findBrowserOrderJson,
  isBrowserOrderResponse,
};
if (typeof module !== 'undefined' && module.exports) module.exports = browserOrderPayload;
else self.browserOrderPayload = browserOrderPayload;
