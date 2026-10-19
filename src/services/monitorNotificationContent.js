const MAX_BYTES = 2048;
const MAX_LINK_BYTES = 512;
const DISPLAY_NAME_LENGTH = 40;
const LEVEL_LABELS = { critical: '严重', warning: '警告', info: '提醒' };
const CATEGORY_LABELS = {
  alert: '异常告警',
  recovery: '告警条件已解除',
  reminder: '异常仍在持续',
  test: '通知测试',
  summary: '当前异常汇总',
  daily: '每日监控摘要',
  storm: '集中告警汇总',
};

/** 清理不可信名称、凭据格式、提及和外链。 @param {*} value 名称 @returns {string} 纯文本 */
function safeName(value) {
  const cleaned = String(value || '未知')
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{15,18}[\dXx]?\b/gi, '[已隐藏]')
    .replace(/(?:password|passwd|token|secret|密码|密钥|授权码)\s*[:=：]\s*\S+/gi, '[已隐藏]')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, ' ')
    .split('')
    .map(char =>
      char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)
        ? ' '
        : char
    )
    .join('')
    .replace(/[<>@#*`_[\](){|}\\]/g, '');
  return Array.from(cleaned).slice(0, 100).join('');
}

function displayName(value) {
  const chars = Array.from(safeName(value));
  return chars.length > DISPLAY_NAME_LENGTH
    ? `${chars.slice(0, DISPLAY_NAME_LENGTH).join('')}…`
    : chars.join('');
}
/** 网站详情入口不接受事件携带的URL。 @param {string} eventId UUID @returns {string} 链接 */
function detailLink(eventId) {
  try {
    const url = new URL(
      process.env.MONITOR_PUBLIC_URL ||
        process.env.FRONTEND_URL ||
        process.env.AOS_COLLECTOR_PUBLIC_URL
    );
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return '';
    const suffix = /^[a-f0-9-]{36}$/i.test(eventId || '')
      ? `?eventId=${encodeURIComponent(eventId)}`
      : '';
    const link = `${url.origin}/server-monitor${suffix}`;
    return Buffer.byteLength(link, 'utf8') <= MAX_LINK_BYTES ? link : '';
  } catch (_error) {
    return '';
  }
}
function time(value) {
  const at = new Date(value);
  return Number.isFinite(+at)
    ? at.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '未知';
}
function eventText(item, category) {
  if (category === 'test') return `\n测试时间：${time(item.at)}\n`;
  if (!item.alertId && (item.systemNotice || category === 'daily'))
    return `\n${safeName(item.title)}\n通知时间：${time(item.at)}\n`;

  const lines = [
    `服务器：${displayName(item.deviceName)}`,
    `实例：${displayName(item.instanceLabel)}`,
    `规则：${displayName(item.ruleName || item.title)}`,
    `事件：${/^[a-f0-9-]{36}$/i.test(item.alertId || '') ? item.alertId : '摘要'}`,
  ];
  if (category === 'recovery') {
    if (LEVEL_LABELS[item.originalSeverity])
      lines.push(`原告警级别：${LEVEL_LABELS[item.originalSeverity]}`);
    lines.push(`首次发现：${time(item.firstSeenAt || item.at)}`, `解除时间：${time(item.at)}`);
  } else {
    lines.push(
      `窗口命中：${Number.isSafeInteger(item.hitCount) && item.hitCount >= 0 ? item.hitCount : 0} 次`,
      `首次发现：${time(item.firstSeenAt || item.at)}`,
      `最近命中：${time(item.at)}`
    );
  }
  if (item.originalUnknown) lines.push('原告警发送结果未确认，请结合网站核对。');
  return `\n${lines.join('\n')}\n`;
}

/** 按纯文本UTF-8预算生成安全摘要，保留完整详情入口。 @param {Object} delivery 批次 @param {Object[]} events 事实 @returns {Object} 邮件及企微消息 */
function build(delivery, events) {
  const rank = { critical: 0, warning: 1, info: 2 };
  events = [...events].sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2));
  const category = delivery.category;
  const label = CATEGORY_LABELS[category] || '服务器监控';
  const title =
    category === 'recovery'
      ? `恢复通知 · ${label}`
      : ['test', 'daily'].includes(category)
        ? label
        : `${LEVEL_LABELS[delivery.severity] || '提醒'} · ${label}`;
  const subject = `【${title}】${displayName(events[0]?.deviceName || '服务器监控')}`;
  const link = detailLink(events.find(item => item.alertId)?.alertId);
  const footer = `\n共 ${events.length} 项；时间均为北京时间。${link ? `\n查看详情（需登录）：\n${link}` : '\n请登录网站查看详情。'}`;
  let text = `${subject}\n`;
  if (category === 'test') text += '这是一条通知测试消息，不包含真实日志、账号或付款信息。\n';
  if (category === 'recovery')
    text += '恢复说明：仅表示对应告警条件已解除，请结合其他指标确认运行状态。\n';
  if (category === 'reminder') text += '此前告警仍未解除，请查看处理进展。\n';
  if (category === 'storm') text += '短时间出现多项告警，已合并推送。\n';
  let included = 0;
  const omittedText = count => `\n其余 ${count} 项请在网站查看。`;
  for (const item of events) {
    const line = eventText(item, category);
    // 为真实剩余条数和完整入口预留预算，不把中文字符或URL截成两半。
    const remaining = events.length - included - 1;
    const tail = remaining > 0 ? omittedText(remaining) : '';
    if (Buffer.byteLength(text + line + tail + footer, 'utf8') > MAX_BYTES) break;
    text += line;
    included++;
  }
  if (included < events.length) text += omittedText(events.length - included);
  text += footer;
  return {
    subject,
    text,
    html: `<pre>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`,
  };
}
module.exports = { safeName, detailLink, build, MAX_BYTES };
