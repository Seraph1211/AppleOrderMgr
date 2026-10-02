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

const FAILURE_TEXT = {
  NO_HEALTHY_PROXY: '暂无可用代理，需检查代理出口',
  PROXY_TUNNEL_UNAVAILABLE: '代理隧道暂时不可用，等待有限重试',
  PROXY_CONNECT_REJECTED: '代理拒绝连接，出口已暂停',
  PROXY_AUTH_FAILED: '代理认证失败，需核对配置',
  ROUND_COVERAGE_MISSING: '本轮未取得该商品和门店的有效结果',
  REQUEST_BUDGET_EXHAUSTED: '已达到请求预算上限',
  TARGET_COOLDOWN: '采集正在保护冷却',
  REQUEST_TIMEOUT: '请求超时',
  TRANSPORT_UNKNOWN: '连接中断，结果未知',
  RESPONSE_READ_FAILED: '响应读取失败',
};
/** 将已知采集故障转成可操作说明，保留未知故障代码供排查。 */
export function failureText(code) {
  return FAILURE_TEXT[code] || code || '无';
}
