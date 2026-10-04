import { moneyValue } from './stockHelpers';

/** 北京日期用于业务日期表单，避免浏览器时区改变默认日。 */
export function ledgerToday() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

/** 只有明确填写的金额才发送；空白保留待补状态。 */
export function ledgerAmount(value) {
  return String(value ?? '').trim() ? moneyValue(value) : null;
}

/** 将已存在规格或当场填写的规格转换为接口字段。 */
export function ledgerProduct(value) {
  if (value.productId !== '__new__' && value.productId) return { productId: value.productId };
  if (!value.modelName?.trim() || !value.colorName?.trim() || !Number(value.storageGb))
    throw new Error('请完整填写型号、容量和颜色');
  return {
    product: {
      modelName: value.modelName.trim(),
      storageGb: Number(value.storageGb),
      colorName: value.colorName.trim(),
    },
  };
}

/** 货款仅记录该台全款的去向，不用费用抵扣。 */
export function ledgerPayment(value) {
  return {
    status: value.status,
    ...(value.status === 'agent_pending'
      ? { collectorName: value.collectorName?.trim(), collectedOn: value.collectedOn || null }
      : {}),
    ...(value.status === 'company_received' ? { receivedOn: value.receivedOn || null } : {}),
  };
}

/** 只展示业务名称，旧复杂账款保留明确状态。 */
export const LEDGER_PAYMENT_LABELS = Object.freeze({
  unpaid: '未收款',
  agent_pending: '已代收待转回',
  company_received: '公司已到账',
  unknown: '待核实',
  legacy_partial: '已有部分到账',
});

/** 采用服务端逐条能力，权限不足或旧记录不支持时不显示操作。 */
export function ledgerCan(unit, action) {
  return Boolean(unit?.allowedActions?.includes(action));
}
