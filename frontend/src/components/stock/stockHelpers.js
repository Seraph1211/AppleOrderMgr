/** 以人民币分解析金额，避免二进制小数误差。 */
export function moneyCents(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) throw new Error('金额须为非负数字，最多两位小数');
  const [whole, decimal = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
}
/** 返回符合接口契约的金额字符串。 */
export function moneyValue(value) {
  const cents = moneyCents(value);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
/** 展示授权金额；未知成本不可误显为零。 */
export function moneyText(value) {
  return value === undefined || value === null ? '待核实' : `¥${value}`;
}
/** 格式化真实业务时间。 */
export function dateText(value) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'short',
        timeStyle: 'short',
        hour12: false,
      }).format(new Date(value))
    : '—';
}
/** 规格名称。 */
export function productLabel(product) {
  if (!product) return '规格待完善';
  return `${product.modelName || product.modelKey || ''} ${product.storageGb ? `${product.storageGb}GB` : ''} ${product.colorName || product.colorKey || ''}`.trim();
}
/** 从目录构建表单选项。 */
export function stockOptions(items = [], label = item => item.name) {
  return items.map(item => ({ value: item.id, label: label(item) }));
}
/** 可读状态。 */
export const STOCK_LABELS = Object.freeze({
  active: '有效',
  picked: '已挑选',
  released: '已释放',
  registered: '未入库',
  in_stock: '在库',
  in_transit: '在途',
  sold: '已售',
  returned: '已退货',
  draft: '草稿',
  reserved: '已接单',
  shipped: '已出货',
  cancelled: '已取消',
  voided: '已作废',
  dispatched: '运输中',
  received: '已接收',
  partially_received: '部分接收',
  local: '重庆自销',
  consignment: '代卖',
  warehouse: '仓库',
  consignee: '代卖点',
  historical: '历史地点待核实',
  posted: '有效',
  reversed: '已反转',
  company: '公司直收',
  agent: '代收',
  confirmed: '已确认',
  pending: '待核实',
  direct_customer: '客户直付',
  agent_transfer: '代收转回',
});

/** 把轨迹操作代码转成业务可读说明。 */
export function stockEventLabel(event) {
  return (
    event.actionLabel ||
    {
      'lifecycle.return': '官网退货状态核对',
      'lifecycle.confirm_mapping': '人工确认退货设备',
      'lifecycle.resolve': '人工核实退货异常',
      ledger_receive: '入库登记',
      ledger_order: '更新订单号',
      ledger_history_identity: '补录历史设备',
      ledger_sale: '登记销售',
      ledger_sale_unit: '记录单台售价',
      ledger_sold: '确认售出',
      ledger_payment: '更新货款状态',
      ledger_collection: '记录代收货款',
      ledger_receipt: '记录公司到账',
      ledger_edit: '编辑设备资料',
      ledger_price_correct: '更正售价',
      ledger_sale_correct: '更正销售信息',
      ledger_product_correct: '更正规格',
      ledger_source_warehouse_correct: '更正出库仓库',
      ledger_cost_correct: '补充或更正官网成本',
      ledger_expense: '记录额外费用',
      ledger_expense_input: '补充单台费用',
      ledger_mistake_recover: '更正误售回在库',
      register: '登记实物 SN',
      register_details: '完善实物登记',
      receive: '确认收货入库',
      source_order: '更新来源订单',
      source_binding_details: '记录来源关联',
      cost: '确认或更正成本',
      cost_snapshot: '同步单台成本快照',
      transfer_create: '建立转运草稿',
      dispatch: '确认发出',
      transfer_receive: '确认转运实收',
      sale_create: '建立销售草稿',
      sale_edit: '修改销售需求',
      reserve: '确认接单占用',
      picks: '更新挑货清单',
      pick_price: '更新挑货售价',
      cancel_pick: '释放挑选实物',
      ship: '确认实际出货',
      cancel: '取消未完成单据',
      collection: '登记客户付款',
      receipt: '登记公司到账',
      collection_correct: '更正客户付款',
      receipt_correct: '更正公司到账',
      receipt_void: '作废误录到账',
      location_correct: '更正位置事实',
      identity_correct: '更正 SN 或规格',
      sale_price_correct: '更正单台售价',
      sale_wrong_unit_restore: '恢复误绑实物',
      sale_correct_unit: '登记实际售出实物',
      sale_unit_replace: '更正错绑 SN',
      sale_void: '作废误录销售',
      sale_void_restore: '按事实恢复实物',
      sale_void_expense: '作废关联费用',
      sale_fact_correct: '更正出货事实',
    }[event.action || event.type] ||
    '更新业务记录'
  );
}
