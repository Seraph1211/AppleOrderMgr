const crypto = require('crypto');
const ApiError = require('../utils/ApiError');

const RETURN_STATUS = 'RETURN_STARTED';
const ISSUES = {
  ['return_pending']: '官网已发起退货，具体退货设备待确认',
  ['sold_return_conflict']: '设备已售，但官网显示退货，请核实销售与退货事实',
  ['return_withdrawn']: '官网退货状态已撤销或变化，请核实后恢复设备',
  ['return_state_conflict']: '设备状态与官网退货冲突，请处理原记录',
};
// o/pr 是所属订单与人工取货记录；不将上传照片、绑定或预约日当成已取货。
const PICKED_SQL = `(o.actual_pickup_date IS NOT NULL OR o.status='picked_up'
  OR 'PICKED_UP'=ANY(string_to_array(REPLACE(COALESCE(o.official_raw_status,''),' ',''),'|'))
  OR pr.status='picked_up')`;
const ELIGIBLE_SQL = `EXISTS (SELECT 1 FROM pickup_devices pd JOIN orders o ON o.id=pd.order_id
  LEFT JOIN pickup_records pr ON pr.order_id=o.id WHERE pd.stock_unit_id=u.id AND (${PICKED_SQL} OR EXISTS (SELECT 1 FROM stock_order_checks sc WHERE sc.order_id=o.id AND sc.pickup_verified)))`;
const LEDGER_SQL = `((u.state='registered' AND ${ELIGIBLE_SQL}) OR
  (u.state='in_stock' AND l.kind='warehouse') OR (u.state='sold' AND s.channel='local') OR u.state='returned')`;

/** 仅接受单个官网商品项明确列出的完整 SN，不按名称、位置或数量推测。 */
function explicitSerials(data, quantity) {
  const value = data?.serialNumbers ?? (data?.serialNumber ? [data.serialNumber] : null);
  if (
    !Array.isArray(value) ||
    value.length !== quantity ||
    !value.length ||
    new Set(value).size !== value.length ||
    value.some(
      sn =>
        typeof sn !== 'string' || !/^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(sn) || !/[A-Z]/.test(sn)
    )
  )
    return [];
  return value;
}

/** 官网内容指纹不包含观测时间，重复检查保留同一内容上的人工核实。 */
function returnFingerprint(items) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        items.map(item => ({
          key: item.key || null,
          name: item.name,
          quantity: item.quantity,
          rawStatus: item.rawStatus,
          serialNumbers: item.serialNumbers || [],
        }))
      )
    )
    .digest('hex');
}

/** 单台决策：销售资金不自动撤销，撤销退货不自动恢复。 */
function returnDecision(unit, { hasReturn, matched, ambiguous, fingerprint }) {
  if (unit.state === 'returned') {
    return {
      lifecycleIssue: ambiguous
        ? 'return_pending'
        : !hasReturn || !matched
          ? 'return_withdrawn'
          : null,
    };
  }
  if (!hasReturn || (!matched && !ambiguous)) return { lifecycleIssue: null };
  if (!matched) return { lifecycleIssue: 'return_pending' };
  if (unit.state === 'sold')
    return {
      lifecycleIssue:
        unit.returnDecisionFingerprint === fingerprint ? null : 'sold_return_conflict',
    };
  if (!['registered', 'in_stock'].includes(unit.state))
    return { lifecycleIssue: 'return_state_conflict' };
  return {
    state: 'returned',
    returnPreviousState: unit.state,
    returnLocationId: unit.locationId,
    locationId: null,
    lifecycleIssue: null,
  };
}

/** 异常设备须先核对，防止在待确认退货期间继续流转。 */
function assertLifecycleWritable(unit) {
  if (unit?.lifecycleIssue || unit?.state === 'returned')
    throw ApiError.conflict(
      ISSUES[unit.lifecycleIssue] || '设备已退货，不能重复入库或售出',
      undefined,
      'UNIT_LIFECYCLE_CONFLICT'
    );
}
module.exports = {
  RETURN_STATUS,
  ISSUES,
  PICKED_SQL,
  ELIGIBLE_SQL,
  LEDGER_SQL,
  explicitSerials,
  returnFingerprint,
  returnDecision,
  assertLifecycleWritable,
};
