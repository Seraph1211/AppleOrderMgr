export const orderExportFields = Object.freeze([
  { key: 'systemOrderId', label: '系统订单 ID', tableKeys: ['orderNumber'] },
  { key: 'orderNumber', label: '官网订单号', tableKeys: ['orderNumber'] },
  { key: 'ingestionSource', label: '入库来源', tableKeys: ['orderNumber'] },
  { key: 'appleId', label: 'Apple ID', tableKeys: [] },
  { key: 'recipientName', label: '取机人', tableKeys: ['recipientName'] },
  { key: 'recipientTag', label: '取机人 TAG', tableKeys: ['recipientTag'] },
  { key: 'products', label: '商品信息', tableKeys: ['products'] },
  { key: 'orderAmount', label: '订单金额', tableKeys: ['products'] },
  {
    key: 'emailOrderStatus',
    label: '订单状态',
    tableKeys: ['emailOrderStatus'],
  },
  { key: 'emailStatusNeedsReview', label: '邮件状态待核对', tableKeys: [] },
  { key: 'currency', label: '币种', tableKeys: ['products'] },
  { key: 'amountSource', label: '金额来源', tableKeys: ['products'] },
  { key: 'priceVersion', label: '价格版本', tableKeys: [] },
  {
    key: 'emailPickupStore',
    label: '邮件取货门店',
    tableKeys: ['emailPickupInfo'],
  },
  {
    key: 'emailPickupDate',
    label: '邮件取货日期',
    tableKeys: [],
  },
  {
    key: 'emailPickupSchedule',
    label: '邮件取货安排',
    tableKeys: ['emailPickupInfo'],
  },
  { key: 'paymentMethod', label: '付款方式', tableKeys: ['paymentMethod'] },
  { key: 'payerName', label: '付款人', tableKeys: ['payerName'] },
  { key: 'tag', label: '授权 TAG', tableKeys: ['tag'] },
  { key: 'notes', label: '备注', tableKeys: ['notes'] },
  { key: 'orderDate', label: '下单时间', tableKeys: ['orderDate'] },
  {
    key: 'emailLifecycleUpdatedAt',
    label: '邮件状态更新时间',
    tableKeys: ['emailLifecycleUpdatedAt'],
  },
  { key: 'createdAt', label: '创建时间', tableKeys: ['createdAt'] },
  { key: 'updatedAt', label: '更新时间', tableKeys: ['updatedAt'] },
]);

/** 根据当前可见业务列生成首次导出的默认字段。 */
export function getDefaultOrderExportFields(columns) {
  const visibleKeys = new Set(columns.filter(column => column.visible).map(column => column.key));
  return orderExportFields
    .filter(field => field.tableKeys.some(key => visibleKeys.has(key)))
    .map(field => field.key);
}
