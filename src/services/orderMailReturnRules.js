const { normalizeProductName } = require('../utils/productFilter');

const RETURN_STATUSES = ['partially_return_requested', 'return_requested'];

function productMap(products) {
  const result = new Map();
  for (const product of products || []) {
    const name = normalizeProductName(product?.name);
    const quantity = Number(product?.quantity);
    if (!name || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
    result.set(name, (result.get(name) || 0) + quantity);
  }
  return result.size ? result : null;
}

function signature(products) {
  const map = productMap(products);
  return map ? JSON.stringify([...map].sort(([a], [b]) => a.localeCompare(b))) : null;
}

/** 从明确退货商品段和稳定退货号提取依据，不使用正文其他数量。 */
function parseReturnRequest(lines, parseProducts) {
  const body = lines.join('\n');
  const numbers = [
    ...new Set(
      [...body.matchAll(/退货(?:号|编号)(?:是)?\s*[:：]?\s*([A-Z]{2,8}\d{4,20})\b/gi)].map(match =>
        match[1].toUpperCase()
      )
    ),
  ];
  const reasons = [];
  if (numbers.length !== 1) reasons.push('RETURN_NUMBER_AMBIGUOUS');
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^要退回的商品\s*[:：]?$/.test(lines[index])) continue;
    const end = lines.findIndex((line, cursor) => cursor > index && /^总计\s*[:：]?$/.test(line));
    if (end < 0) {
      reasons.push('RETURN_PRODUCTS_MISSING');
      continue;
    }
    const section = lines.slice(index + 1, end);
    const products = parseProducts(section);
    const quantityLines = section.filter(line => /^数量/.test(line));
    const productLines = section.filter(
      line => !/^数量/.test(line) && !/^[（(]?\s*(?:RMB|CNY|[¥￥])\s*[\d,.]+\s*[）)]?$/i.test(line)
    );
    if (
      !products.length ||
      products.length !== quantityLines.length ||
      products.length !== productLines.length ||
      !signature(products)
    )
      reasons.push('RETURN_QUANTITY_INVALID');
    sections.push(products);
    index = end;
  }
  if (!sections.length) reasons.push('RETURN_PRODUCTS_MISSING');
  if (new Set(sections.map(signature)).size > 1) reasons.push('RETURN_SECTION_CONFLICT');
  const products = sections[0] || [];
  return {
    requestNumber: numbers.length === 1 ? numbers[0] : null,
    products,
    quantity: products.reduce((sum, product) => sum + Number(product.quantity), 0),
    reviewReasons: [...new Set(reasons)],
  };
}

/** 按商品名称及数量验证退货是已知订单的非空子集。 */
function evaluateReturnScope(products, orderProducts) {
  const returned = productMap(products);
  const ordered = productMap(orderProducts);
  if (!ordered) return { matched: false, reason: 'ORDER_QUANTITY_UNKNOWN' };
  if (!returned) return { matched: false, reason: 'RETURN_QUANTITY_INVALID' };
  for (const [name, quantity] of returned) {
    if (!ordered.has(name) || quantity > ordered.get(name))
      return { matched: false, reason: 'RETURN_PRODUCT_SCOPE_MISMATCH' };
  }
  return { matched: true, reason: null, evidence: 'return_product_subset' };
}

/** 同订单退货号去重后逐商品累计；冲突或超量不提升状态。 */
function aggregateReturnRequests(order, events) {
  const requests = new Map();
  const reviewReasons = new Set();
  for (const event of events) {
    if (event.templateType !== 'return_requested') continue;
    const request = event.evidence?.returnRequest;
    if (!request?.requestNumber) {
      reviewReasons.add('RETURN_NUMBER_AMBIGUOUS');
      continue;
    }
    const value = signature(event.products);
    const existing = requests.get(request.requestNumber);
    if (existing && existing.signature !== value) reviewReasons.add('RETURN_REQUEST_CONFLICT');
    else requests.set(request.requestNumber, { signature: value, products: event.products });
  }
  const totals = new Map();
  for (const request of requests.values()) {
    for (const [name, quantity] of productMap(request.products) || [])
      totals.set(name, (totals.get(name) || 0) + quantity);
  }
  const ordered = productMap(order.products);
  if (requests.size && !ordered) reviewReasons.add('ORDER_QUANTITY_UNKNOWN');
  for (const [name, quantity] of totals)
    if (!ordered?.has(name) || quantity > ordered.get(name))
      reviewReasons.add('RETURN_QUANTITY_EXCEEDS_ORDER');
  const quantity = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const totalQuantity = [...(ordered?.values() || [])].reduce((sum, value) => sum + value, 0);
  return {
    orderStatus:
      !reviewReasons.size && quantity > 0
        ? quantity === totalQuantity
          ? 'return_requested'
          : 'partially_return_requested'
        : null,
    quantity,
    reviewReasons: [...reviewReasons],
  };
}

module.exports = {
  RETURN_STATUSES,
  parseReturnRequest,
  evaluateReturnScope,
  aggregateReturnRequests,
};
