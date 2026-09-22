const STATUS_LABELS = {
  pending: '待取货',
  picked_up: '已取货',
  exception: '异常',
};
const FIELD_LABELS = {
  status: '取货状态',
  pickedUpAt: '实际取货时间',
  settlementAmount: '结款金额',
  settlementPerson: '结款人',
  notes: '备注',
};

/** 将取货历史时间统一显示为北京时间。 */
export function formatPickupHistoryTime(value) {
  if (!value) return '未填写';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间待核实';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return '未填写';
  if (field === 'status') return STATUS_LABELS[value] || '未知状态';
  if (field === 'pickedUpAt') return formatPickupHistoryTime(value);
  if (field === 'settlementAmount') {
    return Number.isFinite(Number(value)) ? `¥${Number(value).toFixed(2)}` : '金额待核实';
  }
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '内容待核实';
}

/** 将审计原始变化转换为用户可读文字，不展示内部字段、ID 或 JSON。 */
export function describePickupEvent(event) {
  if (event.eventType === 'evidence_added') {
    const evidence = event.changes?.evidence;
    const label =
      evidence?.kind === 'pickup'
        ? '取货凭证'
        : evidence?.kind === 'settlement'
          ? '结款凭证'
          : '凭证';
    return [`上传${label}：${evidence?.name || '未命名文件'}`];
  }
  const changes = event.changes || {};
  const lines = Object.entries(FIELD_LABELS)
    .filter(([field]) => changes[field] && typeof changes[field] === 'object')
    .map(
      ([field, label]) =>
        `${label}：${formatValue(field, changes[field].before)} → ${formatValue(field, changes[field].after)}`
    );
  if (Object.keys(changes).some(field => !Object.hasOwn(FIELD_LABELS, field))) {
    lines.push('更新了其他取货信息');
  }
  return lines.length ? lines : ['更新了取货记录'];
}
