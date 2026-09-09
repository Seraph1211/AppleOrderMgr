const { PAYMENT_WINDOW_MS } = require('../../constants/business');
const { normalizeText: normalize, equivalentOrderValue } = require('./orderComparison');

const APPLE_CURRENT_STATUS_MAP = Object.freeze({
  PAYMENT_DUE_STORED_ORDER: 'payment_due',
  PAYMENT_RECEIVED: 'payment_received',
  PROCESSING: 'processing',
  READY_FOR_PICKUP: 'ready_for_pickup',
  PICKED_UP: 'picked_up',
  PAYMENT_EXPIRED_STORED_ORDER: 'payment_expired',
  CANCELLED: 'cancelled',
  PICKUP_CANCELLED: 'pickup_cancelled',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
});
const TERMINAL_STATUSES = new Set([
  'picked_up',
  'payment_expired',
  'cancelled',
  'pickup_cancelled',
  'delivered',
  'completed',
]);
const PAID_LIFECYCLE_STATUSES = new Set([
  'payment_received',
  'processing',
  'ready_for_pickup',
  'picked_up',
  'completed',
]);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

/** 只保留有界纯文本业务字段，不保存 URL、令牌或对象。 */
function safeText(value, maxLength = 255) {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    /https?:\/\//i.test(value) ||
    [...value].some(character => character.charCodeAt(0) < 32)
  )
    return null;
  return value.trim();
}

/** 付款截止优先官网 Epoch，仅回退包含时分的官网创建时间。 */
function getOfficialDeadline(order) {
  for (const [value, offset] of [
    [order?.officialPaymentExpiresAt, 0],
    [order?.officialOrderCreatedAt, PAYMENT_WINDOW_MS],
  ]) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isFinite(time)) return new Date(time + offset);
  }
  return null;
}

/** 已付、终态、身份异常及无法确认的官网阶段不可新分配付款任务。 */
function isPaymentBlocked(order = {}) {
  return (
    ['paid', 'refunded'].includes(order.paymentStatus) ||
    PAID_LIFECYCLE_STATUSES.has(order.status) ||
    TERMINAL_STATUSES.has(order.status) ||
    order.officialAllItemsTerminal === true ||
    order.officialStatusNeedsReview === true ||
    order.status === 'unknown' ||
    (order.validationIssues || []).some(issue => issue.type === 'order_identity')
  );
}

/** 从明确官网阶段派生支付状态；配送与取消不推断付款结果。 */
function paymentForStatus(status) {
  if (PAID_LIFECYCLE_STATUSES.has(status)) return 'paid';
  if (['payment_due', 'payment_expired'].includes(status)) return 'unpaid';
  return null;
}

/** 从官网阶段派生履约状态。 */
function pickupForStatus(status, deliveryType) {
  if (['shipped', 'delivered', 'cancelled', 'payment_expired'].includes(status))
    return 'not_applicable';
  if (status === 'pickup_cancelled') return 'pickup_cancelled';
  if (status === 'picked_up' || status === 'completed') return 'picked_up';
  if (status === 'ready_for_pickup') return 'ready_for_pickup';
  if (['payment_due', 'payment_received', 'processing'].includes(status)) {
    return deliveryType && deliveryType !== 'RETAIL_STORE' ? 'not_applicable' : 'not_ready';
  }
  return 'unknown';
}

/** 汇总全部订单项，不以动态键或首项代表整单。 */
function summarizeLifecycle(items) {
  const rawStatuses = items.map(
    item => safeText(item.orderItemStatusTracker?.d?.currentStatus, 100) || null
  );
  const statuses = rawStatuses.map(raw => APPLE_CURRENT_STATUS_MAP[raw] || 'unknown');
  const same = statuses.length > 0 && new Set(statuses).size === 1;
  const status = same ? statuses[0] : 'unknown';
  const payments = statuses.map(paymentForStatus);
  const pickups = statuses.map((value, index) =>
    pickupForStatus(value, items[index].d?.deliveryType)
  );
  return {
    orderStatus: status,
    officialRawStatus:
      rawStatuses.length && new Set(rawStatuses).size === 1 ? rawStatuses[0] : null,
    officialStatusNeedsReview: !same || status === 'unknown',
    officialAllItemsTerminal:
      statuses.length > 0 && statuses.every(value => TERMINAL_STATUSES.has(value)),
    paymentStatus:
      payments.length && payments.every(value => value === 'paid')
        ? 'paid'
        : payments.length && payments.every(value => value === 'unpaid')
          ? 'unpaid'
          : null,
    pickupStatus: pickups.length && new Set(pickups).size === 1 ? pickups[0] : 'unknown',
  };
}

/** 严格解析官网总金额，拒绝截断小数、非法分组和越界金额。 */
function parseOfficialMoney(value) {
  if (typeof value !== 'string') return null;
  const match = value
    .trim()
    .match(/^(?:RMB|CNY|¥|￥)\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(amount) && amount >= 0 && amount < 1e10
    ? { amount, currency: 'CNY' }
    : null;
}

function readField(object, key, parser, diagnostics, name) {
  if (!hasOwn(object, key)) {
    diagnostics[name] = 'missing';
    return undefined;
  }
  if (object[key] === null) {
    diagnostics[name] = 'null';
    return null;
  }
  const value = parser(object[key]);
  diagnostics[name] = value === null ? 'invalid' : 'value';
  return value;
}

/** 提取阶段字段及存在性诊断，不向结果复制原始 JSON。 */
function parseOfficialFields(detail, items) {
  const diagnostics = {};
  const amount = readField(
    detail.orderHeader?.payNow?.d,
    'totalAmount',
    parseOfficialMoney,
    diagnostics,
    'amount'
  );
  const method = readField(
    detail.billingInfo?.d,
    'paymentMethodPaymentTypeName',
    value => safeText(value, 50) || null,
    diagnostics,
    'paymentMethod'
  );
  const deadlines = items.map((item, index) =>
    readField(
      item.orderItemDetails?.d,
      'paymentTimeToExpiryEpoch',
      value => {
        if (!['string', 'number'].includes(typeof value) || !/^\d{10}$/.test(String(value)))
          return null;
        const seconds = Number(value);
        return seconds >= 946684800 && seconds < 4102444800 ? new Date(seconds * 1000) : null;
      },
      diagnostics,
      `paymentExpiresAt.${index}`
    )
  );
  const deadlineStates = items.map((_item, index) => diagnostics[`paymentExpiresAt.${index}`]);
  const validDeadlines = deadlines.filter(value => value instanceof Date);
  diagnostics.paymentExpiresAt = deadlineStates.includes('invalid')
    ? 'invalid'
    : validDeadlines.length
      ? 'value'
      : deadlineStates.includes('null')
        ? 'null'
        : 'missing';
  const descriptions = items.map(item => item.orderItemStatusTracker?.d).filter(Boolean);
  const firstDescription = descriptions[0];
  const description = readField(
    firstDescription,
    'statusDescription',
    value => safeText(value),
    diagnostics,
    'statusDescription'
  );
  const messages = items
    .map(item => safeText(item.orderItemDetails?.d?.deliveryDate, 1000))
    .filter(Boolean);
  return {
    officialOrderAmount: amount?.amount ?? null,
    officialOrderAmountCurrency: amount?.currency ?? null,
    officialOrderAmountParseError:
      diagnostics.amount === 'invalid' ? '官网总金额格式无法识别' : null,
    officialPaymentMethod: method,
    officialPaymentExpiresAt:
      validDeadlines.length && diagnostics.paymentExpiresAt !== 'invalid'
        ? new Date(Math.min(...validDeadlines.map(value => value.getTime())))
        : null,
    officialStatusDescription: descriptions.every(
      value => value.statusDescription === firstDescription?.statusDescription
    )
      ? description
      : null,
    officialFulfillmentMessage: [...new Set(messages)].join('；') || null,
    officialFieldDiagnostics: diagnostics,
  };
}

function productSnapshot(product) {
  const result = {};
  for (const key of ['model', 'name']) {
    const value = safeText(product?.[key]);
    if (value) result[key] = value;
  }
  if (
    product?.quantity !== null &&
    product?.quantity !== undefined &&
    product?.quantity !== '' &&
    Number.isInteger(Number(product.quantity)) &&
    Number(product.quantity) >= 0
  )
    result.quantity = Number(product.quantity);
  return result;
}

function captureSource(order) {
  return {
    products: (order.products || []).map(productSnapshot),
    paymentMethod: safeText(order.paymentMethod, 50),
    pickupStore: safeText(order.pickupStore),
    orderDate: order.orderDate ? new Date(order.orderDate).toISOString() : null,
  };
}

function matchProducts(reference, incoming) {
  const used = new Set();
  const matches = incoming.map(() => -1);
  // 先完成全部 SKU 匹配，再比较名称，避免前面的缺 SKU 商品占用后面的精确匹配。
  for (const mode of ['model', 'name']) {
    const candidates = incoming.map((product, incomingIndex) => {
      if (matches[incomingIndex] !== -1) return [];
      let indexes = reference
        .map((_candidate, index) => index)
        .filter(index => {
          if (used.has(index)) return false;
          const candidate = reference[index];
          const bothModels = normalize(product.model) && normalize(candidate.model);
          if (mode === 'model') {
            return bothModels && normalize(product.model) === normalize(candidate.model);
          }
          if (bothModels && normalize(product.model) !== normalize(candidate.model)) return false;
          return (
            normalize(product.name) &&
            normalize(candidate.name) &&
            equivalentOrderValue('name', product.name, candidate.name)
          );
        });
      if (mode === 'model' && indexes.length > 1) {
        indexes = indexes.filter(
          index =>
            normalize(product.name) &&
            normalize(reference[index].name) &&
            equivalentOrderValue('name', product.name, reference[index].name)
        );
      }
      return indexes;
    });
    candidates.forEach((indexes, incomingIndex) => {
      if (indexes.length !== 1) return;
      const [index] = indexes;
      if (candidates.filter(other => other.includes(index)).length !== 1) return;
      matches[incomingIndex] = index;
      used.add(index);
    });
  }
  const missing = matches.map((index, i) => (index < 0 ? i : -1)).filter(i => i >= 0);
  const remaining = reference.map((_product, i) => i).filter(i => !used.has(i));
  if (missing.length === 1 && remaining.length === 1) matches[missing[0]] = remaining[0];
  return matches;
}

/** 合并已通过身份校验的官网结果，并持续对比导入来源。 */
function mergeOfficialOrder(order, data, observedAt = new Date()) {
  const source = order.sourceSnapshot || captureSource(order);
  const issues = [];
  const update = {
    sourceSnapshot: source,
    officialFieldDiagnostics: data.officialFieldDiagnostics || {},
    status: data.orderStatus,
    officialRawStatus: data.officialRawStatus ?? null,
    officialStatusObservedAt: observedAt,
    officialStatusNeedsReview: Boolean(data.officialStatusNeedsReview),
    officialAllItemsTerminal: Boolean(data.officialAllItemsTerminal),
  };
  for (const key of [
    'paymentStatus',
    'pickupStatus',
    'pickupStore',
    'officialPaymentMethod',
    'officialPaymentExpiresAt',
    'officialOrderAmount',
    'officialOrderAmountCurrency',
    'officialOrderCreatedAt',
    'officialFulfillmentMessage',
  ]) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '') update[key] = data[key];
  }
  if (
    ['value', 'null'].includes(data.officialFieldDiagnostics?.statusDescription) &&
    data.officialStatusDescription !== undefined
  )
    update.officialStatusDescription = data.officialStatusDescription;
  if (['value', 'invalid'].includes(data.officialFieldDiagnostics?.amount))
    update.officialOrderAmountParseError = data.officialOrderAmountParseError;
  if (data.orderDate) update.orderDate = data.orderDate;
  if (data.officialPaymentMethod) update.paymentMethod = data.officialPaymentMethod;
  const addConflict = (field, sourceValue, officialValue, message) => {
    if (
      sourceValue !== undefined &&
      sourceValue !== null &&
      sourceValue !== '' &&
      !equivalentOrderValue(
        /^products\.\d+\.name$/.test(field) ? 'name' : field,
        sourceValue,
        officialValue
      )
    ) {
      issues.push({
        type: 'source_conflict',
        field,
        source: 'imported',
        sourceValue,
        officialValue,
        resolution: 'official',
        message,
      });
    }
  };
  for (const [field, officialValue] of [
    ['paymentMethod', data.officialPaymentMethod || order.officialPaymentMethod],
    ['pickupStore', data.pickupStore || (order.sourceSnapshot ? order.pickupStore : null)],
  ]) {
    if (officialValue)
      addConflict(
        field,
        source[field],
        officialValue,
        field === 'paymentMethod'
          ? '付款方式与官网不一致，已采用官网值'
          : '取货门店与官网不一致，已采用官网值'
      );
  }
  const officialDate = data.orderDate || (order.sourceSnapshot ? order.orderDate : null);
  if (officialDate && source.orderDate)
    addConflict(
      'orderDate',
      new Date(new Date(source.orderDate).getTime() + 8 * 3600000).toISOString().slice(0, 10),
      new Date(new Date(officialDate).getTime() + 8 * 3600000).toISOString().slice(0, 10),
      '下单日期与官网不一致，已采用官网值'
    );
  const incomingProducts = data.products?.length ? data.products : order.officialProducts;
  if (incomingProducts?.length) {
    data = { ...data, products: incomingProducts };
    const sourceMatches = matchProducts(source.products || [], data.products);
    const existingMatches = matchProducts(order.products || [], data.products);
    const merged = data.products.map((product, index) => {
      const original = source.products?.[sourceMatches[index]];
      const previous = order.products?.[existingMatches[index]] || {};
      if (original) {
        for (const field of ['model', 'name', 'quantity']) {
          if (product[field] !== null && product[field] !== undefined && product[field] !== '')
            addConflict(
              `products.${index}.${field}`,
              original[field],
              product[field],
              `商品${index + 1}的${{ model: '型号', name: '名称', quantity: '数量' }[field]}与官网不一致，已采用官网值`
            );
        }
      } else if (source.products?.length) {
        issues.push({
          type: 'source_conflict',
          field: `products.${index}`,
          source: 'imported',
          sourceValue: '未匹配到唯一商品',
          officialValue: product.name || '官网商品',
          resolution: 'official',
          message: '官网商品无法与导入商品唯一匹配，未猜测型号',
        });
      }
      return {
        ...productSnapshot(previous),
        ...Object.fromEntries(
          Object.entries(product).filter(
            ([_key, value]) => value !== null && value !== undefined && value !== ''
          )
        ),
      };
    });
    if (data.productsComplete !== false) {
      update.products = merged;
      update.officialProducts = data.products;
      if (source.products?.length !== data.products.length)
        issues.push({
          type: 'source_conflict',
          field: 'products',
          source: 'imported',
          sourceValue: source.products?.length || 0,
          officialValue: data.products.length,
          resolution: 'official',
          message: '商品条目数与官网不一致，已采用官网列表',
        });
    } else {
      issues.push({
        type: 'parse_field',
        field: 'products',
        message: '官网商品字段不完整，保留已有商品并等待核对',
      });
      update.officialStatusNeedsReview = true;
    }
  }
  if (data.officialStatusNeedsReview)
    issues.push({
      type: 'status_review',
      field: 'status',
      message: '官网阶段未知或商品阶段不一致，请逐项核对',
    });
  update.validationIssues = issues;
  update.validationStatus = issues.length ? 'abnormal' : 'valid';
  update.anomalyDetectedAt = issues.length ? order.anomalyDetectedAt || observedAt : null;
  return update;
}

module.exports = {
  APPLE_CURRENT_STATUS_MAP,
  TERMINAL_STATUSES,
  PAID_LIFECYCLE_STATUSES,
  safeText,
  getOfficialDeadline,
  isPaymentBlocked,
  paymentForStatus,
  pickupForStatus,
  summarizeLifecycle,
  parseOfficialMoney,
  parseOfficialFields,
  mergeOfficialOrder,
};
