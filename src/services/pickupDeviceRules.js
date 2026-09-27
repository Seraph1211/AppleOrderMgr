const ApiError = require('../utils/ApiError');

/** 规范化包装盒条码；只去除明确长度的序列号 S 前缀，不猜测字符。 */
function normalizeDeviceBarcodes(body) {
  const serialBarcode = typeof body?.serialBarcode === 'string' ? body.serialBarcode.trim() : '';
  if (!serialBarcode || serialBarcode.length > 64) {
    throw ApiError.badRequest('请扫描 Serial No. 条码');
  }
  let serialNumber = serialBarcode.toUpperCase();
  if (/^S(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(serialNumber)) {
    serialNumber = serialNumber.slice(1);
  }
  if (!/^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(serialNumber) || !/[A-Z]/.test(serialNumber)) {
    throw ApiError.badRequest('Serial No. 格式无效，请对准序列号条码重扫');
  }
  return { serialNumber, serialBarcode };
}

module.exports = { normalizeDeviceBarcodes };
