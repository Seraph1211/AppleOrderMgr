const { readOfficialModel } = require('./officialOrderParser');
const { fault, permittedUrl } = require('./officialOrderSupport');

function children(model, prefix) {
  const keys = model?.c;
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > 100 ||
    new Set(keys).size !== keys.length ||
    keys.some(key => typeof key !== 'string' || !key.startsWith(prefix) || !model[key]) ||
    Object.keys(model).filter(key => key.startsWith(prefix)).length !== keys.length
  )
    throw fault('RECEIPT_ITEMS_INCOMPLETE');
  return keys.map(key => model[key]);
}

/** 只提取同一已验证订单详情的同主机只读电子收据链接。 */
function extractOfficialReceiptUrl(body, orderNumber, sourceHost) {
  const detail = readOfficialModel(body, 'orderDetail');
  const details = detail ? [detail] : [];
  if (details.length !== 1 || details[0].orderHeader?.d?.orderNumber !== orderNumber)
    throw fault('DETAIL_IDENTITY_INVALID');
  const raw = details[0].orderHeader.d.invoiceUrl;
  if (!raw) throw fault('RECEIPT_LINK_MISSING');
  const url = permittedUrl(raw);
  if (
    url.hostname !== sourceHost ||
    !/^\/shop\/order\/print\/invoice\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw fault('RECEIPT_LINK_INVALID');
  return url;
}

/** 从电子收据明确的设备字段读取 SN；订单身份、数量或字符不明确时整体拒绝。 */
function parseOfficialReceipt(body, orderNumber, expectedQuantity) {
  if (
    !/^W\d+$/.test(orderNumber) ||
    !Number.isSafeInteger(expectedQuantity) ||
    expectedQuantity < 1
  )
    throw fault('RECEIPT_EXPECTATION_INVALID');
  const model = readOfficialModel(body, 'orderInvoices');
  const candidates = model ? [model] : [];
  if (candidates.length !== 1) throw fault('RECEIPT_MODEL_AMBIGUOUS');
  const invoices = children(candidates[0], 'orderInvoice-');
  const items = [];
  const unique = new Set();
  for (const invoice of invoices) {
    if (invoice.invoiceOrderSummary?.d?.orderNumber !== orderNumber)
      throw fault('RECEIPT_ORDER_MISMATCH');
    for (const item of children(invoice.invoiceLineItems, 'invoiceLineItem-')) {
      const data = item.d;
      if (
        data?.hasLineItemSerialInfo !== true ||
        !/^[1-9]\d*$/.test(String(data.quantityShipped)) ||
        !/^[1-9]\d*$/.test(String(data.quantityOrdered)) ||
        Number(data.quantityShipped) !== Number(data.quantityOrdered) ||
        !Number.isSafeInteger(Number(data.quantityShipped)) ||
        !Array.isArray(data.lineItemSerialInfo) ||
        data.lineItemSerialInfo.length !== Number(data.quantityShipped) ||
        typeof data.partNumber !== 'string' ||
        !data.partNumber.trim() ||
        typeof data.productName !== 'string' ||
        !data.productName.trim()
      )
        throw fault('RECEIPT_SERIALS_INCOMPLETE');
      for (const serialNumber of data.lineItemSerialInfo) {
        if (
          typeof serialNumber !== 'string' ||
          !/^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(serialNumber) ||
          !/[A-Z]/.test(serialNumber) ||
          unique.has(serialNumber)
        )
          throw fault('RECEIPT_SERIAL_INVALID');
        unique.add(serialNumber);
        items.push({ serialNumber, partNumber: data.partNumber, productName: data.productName });
      }
    }
  }
  if (items.length !== expectedQuantity) throw fault('RECEIPT_QUANTITY_MISMATCH');
  return { orderNumber, invoiceCount: invoices.length, items };
}

module.exports = { extractOfficialReceiptUrl, parseOfficialReceipt };
