const ApiError = require('../utils/ApiError');
const { deriveOfficialPickupDate } = require('./officialPickupDate');

const MAX_ITEMS = 100;
const CLOCK_TOLERANCE_MS = 5000;
const MAX_OBSERVATION_AGE_MS = 300000;

/** 校验完整且新鲜的官网结果，仅产生允许回写的状态与观测时间。 */
function validateOfficialStatusResult(result, job, now = Date.now()) {
  const source = result?.source;
  const observed = Date.parse(source?.observedAt);
  const items = result?.products;
  if (
    result?.systemOrderId !== job.orderId ||
    result?.orderNumber !== job.orderNumber ||
    result?.identityMatched !== true ||
    result?.sourceModel !== 'orderDetail' ||
    !Array.isArray(items) ||
    !items.length ||
    items.length > MAX_ITEMS ||
    result?.completeItemCount !== items.length ||
    items.some(
      item =>
        typeof item.name !== 'string' ||
        !item.name.trim() ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 0 ||
        typeof item.rawStatus !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,99}$/.test(item.rawStatus)
    ) ||
    source?.provider !== 'Apple official website' ||
    source?.status !== 200 ||
    source?.cached !== false ||
    !/^([a-z0-9-]+\.)*apple\.com(\.cn)?$/.test(source?.host || '') ||
    !/^[a-f0-9]{64}$/.test(source?.sha256 || '') ||
    !Number.isSafeInteger(source?.runId) ||
    source.runId < 1 ||
    !Number.isFinite(observed) ||
    observed < Date.parse(job.startedAt) - CLOCK_TOLERANCE_MS ||
    observed > now + CLOCK_TOLERANCE_MS ||
    now - observed > MAX_OBSERVATION_AGE_MS
  )
    throw ApiError.badRequest(
      '官网结果不完整、身份不符或已过期',
      undefined,
      'INVALID_OFFICIAL_RESULT'
    );
  return {
    status: [...new Set(items.map(item => item.rawStatus))].sort().join(' | '),
    actualPickupDate: deriveOfficialPickupDate(result, source.observedAt).date,
    observedAt: new Date(observed).toISOString(),
    runId: source.runId,
    sha256: source.sha256,
  };
}

module.exports = { validateOfficialStatusResult };
