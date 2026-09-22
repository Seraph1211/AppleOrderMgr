const ApiError = require('../utils/ApiError');

const STATUSES = new Set(['pending', 'picked_up', 'exception']);
const MAX_SETTLEMENT_AMOUNT = 999999999999.99;

function text(value, maxLength) {
  if (value === null || value === undefined) return null;
  return String(value).trim().slice(0, maxLength) || null;
}

/** 规范化一次取货登记；首次已取货自动写当前时间，显式时间仍以人工值为准。 */
function normalizePickupUpdate(body, current, now = () => new Date()) {
  const status = body.status ?? current.status;
  if (!STATUSES.has(status)) throw ApiError.badRequest('取货状态无效');
  const hasAmount = Object.prototype.hasOwnProperty.call(body, 'settlementAmount');
  const amount = !hasAmount
    ? current.settlementAmount
    : body.settlementAmount === '' || body.settlementAmount === null
      ? null
      : Number(body.settlementAmount);
  if (
    amount !== null &&
    (!Number.isFinite(amount) || amount < 0 || amount > MAX_SETTLEMENT_AMOUNT)
  ) {
    throw ApiError.badRequest('结款金额无效');
  }
  const pickedUpAt =
    body.pickedUpAt === '' || body.pickedUpAt === null
      ? status === 'picked_up'
        ? current.pickedUpAt || now()
        : null
      : body.pickedUpAt
        ? new Date(body.pickedUpAt)
        : status === 'picked_up' && !current.pickedUpAt
          ? now()
          : current.pickedUpAt;
  if (pickedUpAt && !Number.isFinite(pickedUpAt.getTime())) {
    throw ApiError.badRequest('实际取货时间无效');
  }
  return {
    status,
    pickedUpAt,
    settlementAmount: amount,
    settlementPerson: Object.prototype.hasOwnProperty.call(body, 'settlementPerson')
      ? text(body.settlementPerson, 100)
      : current.settlementPerson,
    notes: Object.prototype.hasOwnProperty.call(body, 'notes')
      ? text(body.notes, 2000)
      : current.notes,
  };
}

module.exports = { STATUSES, normalizePickupUpdate };
