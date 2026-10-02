export const STATUS = {
  degraded: '异常 / 降速',
  test: '合成测试',
  health: '运行提醒',
  delivery_unknown: '结果未知',
  enabled: '已启用',
  in_stock: '有货',
  out_of_stock: '无货',
  unknown: '未查询',
  error: '查询异常',
  stale: '已过期',
  disabled: '未启用',
  paused: '已暂停',
  unsupported: '不支持',
  pending: '待处理',
  sending: '发送中',
  accepted: '接口已接受',
  failed: '失败',
  skipped: '已跳过',
  complete: '完整',
  partial: '覆盖不完整',
  missed: '错过计划',
  running: '采集中',
  queued: '排队中',
  first: '首次观察',
  arrival: '到货变化',
  recovery: '恢复观察',
  auto: '自动',
  manual: '手动',
  normal: '正常',
  cooldown: '冷却',
  recovering: '恢复探测',
  manual_required: '需人工处理',
};
/** 北京时间展示，空值不伪造成功时间。 */
export function timeText(value) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—';
}
