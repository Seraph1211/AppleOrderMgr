const {
  getPaymentDeadline,
  isAssignmentBlocked,
  validatePaymentOrderUrl,
} = require('./paymentEligibility');

function hasValidLink(order) {
  try {
    validatePaymentOrderUrl(order?.orderUrl, order?.orderNumber);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * 派生未分配任务的当前等待原因。
 * @param {Object} task 任务
 * @param {Object|null} rule 命中规则
 * @param {Object} overview 全局设置和人员容量
 * @param {Date} now 当前时间
 * @returns {Object|null} 分配说明
 */
function describeAutoAssignment(task, rule, overview, now = new Date()) {
  if (task.assigneeUserId) return null;
  let reasonCode = 'WAITING_SCAN';
  let reason = '等待自动分配';
  const deadline = getPaymentDeadline(task.order);
  const staff = overview.staff.filter(person =>
    rule ? rule.assigneeUserIds.includes(person.id) : person.assignmentMode !== 'tag_only'
  );
  const eligible = staff.filter(
    person =>
      person.status === 'active' && person.hasExecutionPermissions && person.autoAssignEnabled
  );
  if (!overview.settings.enabled) {
    reasonCode = 'DISABLED';
    reason = '自动调度已关闭';
  } else if (overview.settings.mode !== 'auto') {
    reasonCode = 'MANUAL_MODE';
    reason = '当前为手动分配模式';
  } else if (task.processingStatus !== 'pending') {
    reasonCode = 'NOT_PENDING';
    reason = '仅待处理任务参与自动分配';
  } else if (isAssignmentBlocked(task.order, true, now)) {
    reasonCode = 'ORDER_BLOCKED';
    reason = task.order.paymentAssignmentHoldReason ? '历史付款限制，待核对' : '邮件已确认付款';
  } else if (!deadline) {
    reasonCode = 'UNKNOWN_DEADLINE';
    reason = '来源下单时间未知';
  } else if (deadline <= now) {
    reasonCode = 'EXPIRED';
    reason = '已过付款截止时间';
  } else if (!hasValidLink(task.order)) {
    reasonCode = 'MISSING_LINK';
    reason = '等待付款入口';
  } else if (!eligible.length) {
    reasonCode = rule ? 'RULE_NO_ELIGIBLE_STAFF' : 'NO_ELIGIBLE_STAFF';
    reason = rule ? '指定账号均不可接单，请检查账号、权限或自动接单开关' : '暂无可自动接单账号';
  } else if (!eligible.some(person => person.remainingCapacity > 0)) {
    reasonCode = rule ? 'RULE_CAPACITY_FULL' : 'CAPACITY_FULL';
    reason = rule ? '指定账号容量不足，等待释放容量' : '接单容量不足，等待释放容量';
  }
  return { ruleId: rule?.id || null, ruleName: rule?.name || null, reasonCode, reason };
}

/**
 * 在指定账号集合内按负载及公平顺序选择。
 * @param {Object[]} candidates 账号负载
 * @param {Object|null} rule 规则
 * @param {Set<number>} exclusiveUserIds 启用规则绑定的专属账号
 * @returns {Object|null} 目标账号
 */
function selectCandidate(candidates, rule, exclusiveUserIds = new Set()) {
  return (
    candidates
      .filter(
        row =>
          (rule
            ? rule.assigneeUserIds.includes(row.setting.userId)
            : !exclusiveUserIds.has(row.setting.userId)) &&
          row.activeCount < row.setting.maxActiveTasks
      )
      .sort((a, b) => {
        const ratio =
          a.activeCount / a.setting.maxActiveTasks - b.activeCount / b.setting.maxActiveTasks;
        if (ratio) return ratio;
        const aTime = a.setting.lastAssignedAt ? new Date(a.setting.lastAssignedAt).getTime() : 0;
        const bTime = b.setting.lastAssignedAt ? new Date(b.setting.lastAssignedAt).getTime() : 0;
        return aTime - bTime || a.setting.userId - b.setting.userId;
      })[0] || null
  );
}

module.exports = { describeAutoAssignment, selectCandidate };
