const duoQuotePricingService = require('./duoQuotePricingService');
const {
  normalizeDuoSource,
  mergeDuoItems,
  publicDuoItem,
  sourceUnavailable,
} = require('./duoQuotePricingCore');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const PUBLIC_COLORS = ['夜空色', '星光白色'];

function publicItems(items) {
  return items
    .map(publicDuoItem)
    .sort(
      (left, right) =>
        left.storageGb - right.storageGb ||
        PUBLIC_COLORS.indexOf(left.color) - PUBLIC_COLORS.indexOf(right.color)
    );
}

/** 验证固定八款Duo并应用传入加价，默认+50。 @param {Object} batch 来源 @param {Object[]} adjustments 加价 @returns {Object[]} 公开商品 */
function normalizeDuoItems(batch, adjustments = []) {
  return publicItems(mergeDuoItems(normalizeDuoSource(batch), adjustments));
}

/** 获取免登录Duo报价，严格裁剪后台调价字段。 @returns {Promise<Object>} 公开报价 */
async function getPublicDuoQuotes() {
  try {
    if (process.env.QUOTE_DUO_PUBLIC_ENABLED !== 'true') {
      throw new ApiError(503, 'QUOTE_PAGE_PAUSED', '报价页面暂未开放');
    }
    const data = await duoQuotePricingService.getAdminQuotes();
    return {
      enabled: true,
      version: data.version,
      updatedAt: data.updatedAt,
      lastCheckedAt: data.lastCheckedAt,
      stale: data.stale,
      items: publicItems(data.items),
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 503) throw error;
    logger.error('读取Duo报价失败', { errorType: error.name, errorCode: error.code || null });
    throw sourceUnavailable();
  }
}

module.exports = { normalizeDuoItems, getPublicDuoQuotes };
