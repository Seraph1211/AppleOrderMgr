/** 系统运行日志中文词典；原代码仅在排障详情中保留。 */
export const LOG_LABELS = {
  crawler: '订单抓取',
  proxy: '代理服务',
  wind_control: '访问风控',
  product_validation: '商品核对',
  amount_parse: '金额解析',
  scheduler: '自动调度',
  error: '错误',
  warn: '警告',
  info: '信息',
  debug: '调试',
  success: '成功',
  failed: '失败',
  valid: '核对一致',
  abnormal: '发现差异',
  unavailable: '官网数据不可用',
  unchecked: '尚未核对',
  paused: '已暂停',
  resumed: '已恢复',
  scanned: '扫描完成',
  started: '已启动',
  amount_missing: '未获取到金额',
  idle: '空闲',
  pending: '等待处理',
  switching: '切换中',
  ready: '已就绪',
  active: '已生效',
  order_sync_success: '订单同步成功',
  order_sync_failed: '订单同步失败',
  order_marked_abnormal: '订单商品核对发现差异',
  official_amount_parse_missing: '官网订单金额解析失败',
  wind_control_detected: '检测到官网访问风控',
  auto_refresh_paused: '自动刷新已暂停',
  auto_refresh_paused_by_proxy: '代理异常导致自动刷新暂停',
  auto_refresh_resumed: '自动刷新已恢复',
  auto_refresh_scan: '扫描待刷新订单',
  auto_refresh_scan_failed: '扫描待刷新订单失败',
  auto_refresh_started: '自动刷新已启动',
  auto_refresh_start_failed: '自动刷新启动失败',
};

/** 将运行代码转换成中文，未知代码留到详情查看。 */
export function logLabel(value, fallback = '其他事件（详见详情）') {
  if (!value) return '—';
  return LOG_LABELS[value] || (/[\u3400-\u9fff]/.test(value) ? value : fallback);
}

/** 将常见网络错误转换成用户可读说明，原文仍在详情中保留。 */
export function logErrorSummary(log) {
  if (!log.error_summary) return '—';
  if (/[\u3400-\u9fff]/.test(log.error_summary)) return log.error_summary;
  const status = log.http_status;
  if ([403, 541, 631].includes(status)) return '官网拒绝访问，请检查风控和代理状态';
  if (status === 429) return '请求过于频繁，等待后重试';
  if (/timeout|ETIMEDOUT/i.test(log.error_summary)) return '请求超时，请检查网络和代理状态';
  if (/ECONN|ENOTFOUND|socket/i.test(log.error_summary))
    return '网络连接失败，请检查代理和网络状态';
  return '处理失败，请查看详情中的原始错误';
}
