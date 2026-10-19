const content = require('../src/services/monitorNotificationContent');
const DETAIL_TEXT_REPEAT_COUNT = 30;
const EXPECTED_MAX_BYTES = 2048;
const LONG_EVENT_COUNT = 1000;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const PUBLIC_URL_KEYS = [
  'MONITOR_PUBLIC_URL',
  'FRONTEND_URL',
  'AOS_COLLECTOR_PUBLIC_URL',
];
const savedPublicUrls = Object.fromEntries(
  PUBLIC_URL_KEYS.map(key => [key, process.env[key]])
);

beforeEach(() => {
  PUBLIC_URL_KEYS.forEach(key => delete process.env[key]);
});

afterAll(() => {
  PUBLIC_URL_KEYS.forEach(key => {
    if (savedPublicUrls[key] === undefined) delete process.env[key];
    else process.env[key] = savedPublicUrls[key];
  });
});

describe('服务器监控通知内容安全', () => {
  test('安全名称会清除提及、URL、邮箱、凭据与控制字符', () => {
    const name = content.safeName(
      '节点<@all> https://evil.example/collect?token=x ops@example.test password=private\u0000'
    );

    expect(name).not.toMatch(/@|https?:|evil\.example|ops@example\.test|private/);
    expect(name).not.toContain(String.fromCharCode(0));
    expect(name).toContain('已隐藏');
  });

  test('多字节和 emoji 名称按 UTF-8 字节限制且不切断码点', () => {
    const events = Array.from({ length: LONG_EVENT_COUNT }, (_, index) => ({
      alertId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      severity: 'warning',
      deviceName: `服务器😀${index}`,
      instanceLabel: `实例😀名称${index}`.repeat(DETAIL_TEXT_REPEAT_COUNT),
      ruleName: '登录失败告警😀'.repeat(DETAIL_TEXT_REPEAT_COUNT),
      hitCount: 10,
      at: '2026-10-19T04:00:00.000Z',
    }));
    const result = content.build({ category: 'alert', severity: 'warning' }, events);

    expect(content.MAX_BYTES).toBe(EXPECTED_MAX_BYTES);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(EXPECTED_MAX_BYTES);
    expect(result.text).toContain('其余');
    expect(result.text).not.toContain('\uFFFD');
  });

  test('纯文本逐字段分行，不含 Markdown 标题或链接语法且保留完整受控 HTTPS URL', () => {
    process.env.MONITOR_PUBLIC_URL = 'https://monitor.example.test/ignored/path';
    const result = content.build(
      { category: 'alert', severity: 'critical' },
      [{
        alertId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        severity: 'critical',
        deviceName: '严重优先服务器 & node',
        instanceLabel: '严重实例',
        ruleName: '严重规则',
        hitCount: 2,
        firstSeenAt: '2026-10-19T03:00:00.000Z',
        at: '2026-10-19T04:00:00.000Z',
      }]
    );
    const url =
      'https://monitor.example.test/server-monitor?eventId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    expect(result.text).not.toMatch(/^\s*###/m);
    expect(result.text).not.toMatch(/\[[^\]]+\]\(https:\/\//);
    expect(result.text).toContain(url);
    expect(result.text).not.toContain('/ignored/path');
    expect(result.text).toContain('严重优先服务器');
    expect(result.text).toContain('事件：aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(result.text).toContain('窗口命中：2 次');
    expect(result.text).toContain('首次发现：2026/10/19 11:00:00');
    expect(result.text).toContain('最近命中：2026/10/19 12:00:00');
    expect(result.html).toContain('&amp;');
    expect(result.html).not.toContain('<a ');
  });

  test('严重事件优先，且超长名称不会让单条内容突破限制', () => {
    const events = [
      {
        alertId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        severity: 'warning',
        deviceName: '普通服务器',
        instanceLabel: '普通实例',
        ruleName: '警告规则',
        at: '2026-10-19T04:00:00.000Z',
      },
      {
        alertId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        severity: 'critical',
        deviceName: '😀'.repeat(LONG_EVENT_COUNT),
        instanceLabel: '严重实例',
        ruleName: '严重规则',
        at: '2026-10-19T04:00:00.000Z',
      },
    ];

    const result = content.build({ category: 'alert', severity: 'critical' }, events);
    const criticalIndex = result.text.indexOf('严重实例');
    const warningIndex = result.text.indexOf('普通服务器');

    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(EXPECTED_MAX_BYTES);
    expect(criticalIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeGreaterThan(criticalIndex);
    expect(result.text).toContain('事件：aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(result.text).not.toContain('\uFFFD');
    expect(result.text).not.toMatch(UNPAIRED_SURROGATE);
  });

  test('不安全站点来源与事件中的任意 URL 不生成详情外链', () => {
    process.env.MONITOR_PUBLIC_URL = 'http://monitor.example.test';
    const result = content.build(
      { category: 'alert', severity: 'warning' },
      [{ alertId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', url: 'https://evil.example', at: 'bad-date' }]
    );

    expect(result.text).not.toContain('https://monitor.example.test');
    expect(result.text).not.toContain('https://evil.example');
    expect(result.text).toContain('请登录网站查看详情。');
    expect(result.text).toContain('事件：aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(result.text).toContain('首次发现：未知');
    expect(result.text).toContain('最近命中：未知');
  });

  test.each([
    'https://user:password@monitor.example.test',
    'https://monitor.example.test?token=private',
    'https://monitor.example.test/#private',
  ])('不允许含凭据、查询或片段的站点来源：%s', source => {
    process.env.MONITOR_PUBLIC_URL = source;
    expect(content.detailLink('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('');
  });

  test('恢复通知使用明确标题和恢复时间，不把历史命中数描述成实时恢复计数', () => {
    const result = content.build(
      { category: 'recovery', severity: 'info' },
      [{
        alertId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        severity: 'info',
        deviceName: '恢复服务器',
        instanceLabel: '实例一',
        ruleName: 'CPU 使用率告警',
        hitCount: 99,
        firstSeenAt: '2026-10-19T03:00:00.000Z',
        at: '2026-10-19T04:00:00.000Z',
        originalUnknown: true,
      }]
    );

    expect(result.subject).toContain('【恢复通知 · 告警条件已解除】');
    expect(result.text).toContain('告警条件已解除');
    expect(result.text).toContain('首次发现：2026/10/19 11:00:00');
    expect(result.text).toContain('解除时间：2026/10/19 12:00:00');
    expect(result.text).not.toContain('窗口命中：99 次');
    expect(result.text).toContain('原告警发送结果未确认');
    expect(result.text).not.toContain('原提醒回执未知');
  });

  test.each([
    ['alert', '异常告警'],
    ['reminder', '异常仍在持续'],
    ['summary', '当前异常汇总'],
    ['storm', '集中告警汇总'],
    ['daily', '每日监控摘要'],
    ['test', '通知测试'],
  ])('%s 通知使用约定标题“%s”', (category, title) => {
    const result = content.build({ category, severity: 'warning' }, []);
    expect(result.subject).toContain(title);
  });
});
