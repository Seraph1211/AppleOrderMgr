jest.mock('../src/models', () => ({}));
jest.mock('../src/services/wecomRobotBudget', () => ({}));
jest.mock('../src/utils/logger', () => ({ debug: jest.fn(), error: jest.fn() }));
const sender = require('../src/services/monitorNotificationSender');
const service = require('../src/services/monitorNotificationService');
const content = require('../src/services/monitorNotificationContent');

describe('监控通知安全回执与摘要策略', () => {
  test.each(['ETIMEDOUT', 'ECONNRESET', 'ECONNECTION', 'ESOCKET'])('应将无法证明未接受的%s归为未知', code => {
    expect(sender.mailResult(null, { code }, ['one@example.test']).recipientResults['one@example.test'].status).toBe('unknown');
  });
  test.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'])('应仅安全重试明确未连接%s', code => {
    expect(sender.mailResult(null, { code }, ['one@example.test']).recipientResults['one@example.test'].status).toBe('pending');
  });
  test('应保留逐地址部分接受并只把明确临时拒绝列待发', () => {
    const result = sender.mailResult({ accepted: ['one@example.test'], rejected: ['two@example.test', 'three@example.test'], rejectedErrors: [{ recipient: 'two@example.test', responseCode: 450 }, { recipient: 'three@example.test', responseCode: 550 }] }, null, ['one@example.test', 'two@example.test', 'three@example.test']);
    expect(Object.values(result.recipientResults).map(item => item.status)).toEqual(['accepted', 'pending', 'failed']);
  });
  test('应将SMTP鉴权拒绝归为永久失败并暂停通道', () => {
    const result = sender.mailResult(null, { code: 'EAUTH', responseCode: 535 }, ['one@example.test']);
    expect(result.recipientResults['one@example.test'].status).toBe('failed');
    expect(result.pause).toBe(true);
  });
  test('应保留邮件10分钟并单独用企微3分钟窗口', () => {
    const now = new Date('2026-10-19T15:59:59Z');
    expect(+service.schedule('email', { category: 'alert', severity: 'warning' }, now, service.DEFAULT_POLICY) - now).toBe(600000);
    expect(+service.schedule('wecom', { category: 'alert', severity: 'warning' }, now, service.DEFAULT_POLICY) - now).toBe(180000);
    expect(service.schedule('email', { category: 'alert', severity: 'info' }, now, service.DEFAULT_POLICY).toISOString()).toBe('2026-10-19T16:00:00.000Z');
  });
  test('应净化秘密、控制字符、伪造提及与外链', () => {
    const output = content.safeName('机器<@all>\u0000 https://evil.test token=secret123 one@example.test 110101199001011234');
    expect(output).not.toMatch(/@|https:|secret123|110101199001011234/);
    expect(output.includes(String.fromCharCode(0))).toBe(false);
  });
  test('应按严重优先且最终UTF8字节不超过3500保留事件链接', () => {
    process.env.MONITOR_PUBLIC_URL = 'https://monitor.example.test';
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const events = Array.from({ length: 1000 }, (_, index) => ({ alertId: id, severity: index === 999 ? 'critical' : 'warning', instanceLabel: index === 999 ? '严重优先' : '警告'.repeat(50), ruleName: '规则'.repeat(100), at: '2026-10-19T00:00:00Z' }));
    const result = content.build({ category: 'alert', severity: 'critical' }, events);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(3500);
    expect(result.text.indexOf('严重优先')).toBeLessThan(result.text.indexOf('警告警告'));
    expect(result.text).toContain(`https://monitor.example.test/server-monitor?eventId=${id}`);
    expect(result.text).toContain('2026/10/19');
  });
});
