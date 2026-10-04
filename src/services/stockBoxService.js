const logger = require('../utils/logger');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { createReadContext, requirePermissions } = require('./stockCommandService');
const ocr = require('./pickupOcrService');
const { parseBoxData } = require('./stockBoxRules');
const { specification, PRICE_VERSION } = require('./stockFixedCatalog');
/** 在计费前校验库存权限；仅返回人工核对候选，不写业务记录。 */
async function recognizeBox(user, file, rawBarcodes) {
  try {
    const ctx = await createReadContext(user);
    requirePermissions(ctx, 'stock.read');
    if (
      !ctx.permissions.has('stock.receive') &&
      !['stock.import', 'stock.sales.edit', 'stock.sales.ship'].every(code =>
        ctx.permissions.has(code)
      )
    )
      throw new ApiError(403, 'FORBIDDEN', '缺少入库或历史补录权限');
    let barcodes = [];
    if (rawBarcodes) {
      try {
        barcodes = JSON.parse(rawBarcodes);
      } catch (_error) {
        throw ApiError.badRequest('条码数据无效');
      }
      if (
        !Array.isArray(barcodes) ||
        barcodes.length > 20 ||
        barcodes.some(value => typeof value !== 'string' || value.length > 64)
      )
        throw ApiError.badRequest('条码数据无效');
    }
    const result = await ocr.recognize(file, body => {
      try {
        if (!body || (body.code && !['200', 'Success', 'OK'].includes(String(body.code))))
          throw new Error('invalid');
        const data = JSON.parse(body.data);
        if (typeof data.content !== 'string') throw new Error('invalid');
        return {
          candidates: parseBoxData(data, barcodes),
          provider: 'aliyun',
          requestId: typeof body.requestId === 'string' ? body.requestId : '',
        };
      } catch (_error) {
        throw new ApiError(502, 'OCR_FAILED', '云端盒标结果异常，请人工核对');
      }
    });
    const products = await db.StockProduct.findAll({ where: { isActive: true }, raw: true });
    result.candidates = result.candidates.map(candidate => {
      const matches = products.filter(
        product =>
          product.modelName === candidate.modelName &&
          product.storageGb === candidate.storageGb &&
          product.colorName === candidate.colorName &&
          specification(product)
      );
      const product = matches.length === 1 ? matches[0] : null;
      const spec = product ? specification(product) : null;
      return {
        ...candidate,
        productId: product?.id || null,
        reviewReasons: [
          ...candidate.reviewReasons,
          ...(candidate.matchBasis && !product ? ['规格目录不可用，请核对'] : []),
        ],
        ...(spec && ctx.permissions.has('stock.cost.read')
          ? { fixedCostAmount: spec.amount, priceVersion: PRICE_VERSION }
          : {}),
      };
    });
    return result;
  } catch (error) {
    logger.debug('库存盒标处理未完成', { code: error.code || error.name });
    throw error;
  } finally {
    if (file) file.buffer = null;
  }
}
module.exports = { recognizeBox };
