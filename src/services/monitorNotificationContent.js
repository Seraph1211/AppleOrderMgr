const MAX_BYTES = 3500;

/** 清理不可信名称、凭据格式、提及和外链。 @param {*} value 名称 @returns {string} 纯文本 */
function safeName(value) {
  return String(value || '未知')
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{15,18}[\dXx]?\b/gi, '[已隐藏]')
    .replace(/(?:password|passwd|token|secret|密码|密钥|授权码)\s*[:=：]\s*\S+/gi, '[已隐藏]')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, ' ')
    .split('').map(char => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159) ? ' ' : char).join('')
    .replace(/[<>@#*`_[\](){|}\\]/g, '')
    .slice(0, 100);
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
    return `${url.origin}/server-monitor?eventId=${encodeURIComponent(eventId || '')}`;
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
/** 安全摘要按UTF-8字节限制明细，保留完整入口。 @param {Object} delivery 批次 @param {Object[]} events 事实 @returns {Object} 消息 */
function build(delivery, events) {
  const rank = { critical: 0, warning: 1, info: 2 };
  events = [...events].sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2));
  const level = { critical: '严重', warning: '警告', info: '提醒' }[delivery.severity] || '提醒';
  const labels = {
    alert: '异常告警',
    recovery: '规则条件已解除',
    reminder: '持续异常提醒',
    test: '合成连接测试',
    summary: '当前异常摘要',
    daily: '每日运行摘要',
    storm: '告警风暴摘要',
  };
  const subject = `【${level} · ${labels[delivery.category] || '服务器监控'}】${safeName(events[0]?.deviceName || '服务器监控')}`;
  const link = detailLink(events.find(item => item.alertId)?.alertId);
  const footer = `\n共 ${events.length} 个事件；北京时间。${link ? `\n[查看详情（登录后打开）](${link})` : '\n请登录网站查看详情。'}`;
  let text = `### ${subject}\n`;
  if (delivery.category === 'test') text += '此为合成测试消息，不包含真实日志、账号或付款信息。\n';
  let included = 0;
  for (const item of events) {
    const line = `\n${safeName(item.deviceName)} · ${safeName(item.instanceLabel)} · ${safeName(item.ruleName || item.title)}\n事件：${/^[a-f0-9-]{36}$/i.test(item.alertId || '') ? item.alertId : '合成摘要'}；最近窗口 ${Number.isSafeInteger(item.hitCount) ? item.hitCount : 0} 次\n首次：${time(item.firstSeenAt || item.at)}；最新：${time(item.at)}${item.originalUnknown ? '\n原提醒回执未知' : ''}\n`;
    if (Buffer.byteLength(text + line + footer + '\n其余9999项见网站', 'utf8') > MAX_BYTES) break;
    text += line;
    included++;
  }
  if (included < events.length) text += `\n其余 ${events.length - included} 项见网站。`;
  text += footer;
  return {
    subject,
    text,
    html: `<pre>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`,
  };
}
module.exports = { safeName, detailLink, build, MAX_BYTES };
