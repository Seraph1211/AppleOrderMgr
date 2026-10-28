const taskConfigNameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function normalizeServerName(name) {
  return String(name || '')
    .trim()
    .replace(/^US\s*Server\s*(?:No\.?\s*)?(\d+)/i, 'US Server $1');
}

/** 按服务器自然编号、实例名称和稳定 ID 排列任务配置，兼容 No. 与前导零。 */
export function compareTaskConfigInstances(left, right) {
  return (
    taskConfigNameCollator.compare(
      normalizeServerName(left.serverName),
      normalizeServerName(right.serverName)
    ) ||
    taskConfigNameCollator.compare(left.instanceName || '', right.instanceName || '') ||
    taskConfigNameCollator.compare(left.instanceId || '', right.instanceId || '')
  );
}

/** 完整展示每行选中的规格；仅没有 products 字段的旧版本回退单规格字段。 */
export function taskConfigRowProducts(row) {
  if (!row || typeof row !== 'object') return [];
  if (Object.prototype.hasOwnProperty.call(row, 'products'))
    return Array.isArray(row.products) ? row.products : [];
  if (![row.model, row.color, row.capacity].every(value => typeof value === 'string' && value))
    return [];
  return [{ model: row.model, color: row.color, capacity: row.capacity }];
}

/** 将配置时间显示为北京时间，未知时间保持缺失。 */
export function taskConfigTime(value) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—';
}

/** 提供统一的配置操作错误文案，不读取原始请求正文。 */
export function taskConfigError(error) {
  return error?.response?.data?.error?.message || error?.message || '操作失败，请重试';
}

/** 可选生效时间统一按北京时间解释，空值由服务器取确认时刻。 */
export function taskConfigEffectiveAt(value) {
  if (!value) return undefined;
  const time = new Date(`${value}+08:00`);
  if (!Number.isFinite(time.getTime())) throw new Error('请填写有效的北京时间');
  if (time.getTime() > Date.now()) throw new Error('生效时间不能晚于当前时间');
  return time.toISOString();
}

/** 超过一天未确认仅建议人工复核，不改变配置有效性。 */
export function taskConfigNeedsReview(instance, now = Date.now()) {
  const confirmedAt = Date.parse(instance?.lastConfirmedAt);
  return (
    instance?.status === 'active' && Number.isFinite(confirmedAt) && now - confirmedAt >= 86400000
  );
}
