const content = require('../src/services/monitorNotificationContent');
const DETAIL_TEXT_REPEAT_COUNT = 30;

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

  test('多字节事件明细按 UTF-8 字节数限制到 3500 字节内', () => {
    const events = Array.from({ length: 1000 }, (_, index) => ({
      alertId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      severity: 'warning',
      deviceName: `服务器${index}`,
      instanceLabel: '实例名称'.repeat(DETAIL_TEXT_REPEAT_COUNT),
      ruleName: '登录失败告警'.repeat(DETAIL_TEXT_REPEAT_COUNT),
      hitCount: 10,
      at: '2026-10-19T04:00:00.000Z',
    }));
    const result = content.build({ category: 'alert', severity: 'warning' }, events);

    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(content.MAX_BYTES);
    expect(result.text).toContain('其余');
    expect(result.text).not.toContain('\uFFFD');
  });

  test('严重事件优先，合法事件 ID、北京时间与可信 HTTPS 来源链接保留', () => {
    process.env.MONITOR_PUBLIC_URL = 'https://monitor.example.test/ignored/path';
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
        deviceName: '严重优先服务器',
        instanceLabel: '严重实例',
        ruleName: '严重规则',
        at: '2026-10-19T04:00:00.000Z',
      },
    ];

    const result = content.build({ category: 'alert', severity: 'critical' }, events);
    const criticalIndex = result.text.indexOf('严重优先服务器');
    const warningIndex = result.text.indexOf('普通服务器');

    expect(result.subject).toContain('严重优先服务器');
    expect(criticalIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeGreaterThan(criticalIndex);
    expect(result.text).toContain('事件：aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(result.text).toContain('2026/10/19 12:00:00');
    expect(result.text).toContain(
      'https://monitor.example.test/server-monitor?eventId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    expect(result.text).not.toContain('/ignored/path');
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
    expect(result.text).toContain('首次：未知；最新：未知');
  });

  test.each([
    'https://user:password@monitor.example.test',
    'https://monitor.example.test?token=private',
    'https://monitor.example.test/#private',
  ])('不允许含凭据、查询或片段的站点来源：%s', source => {
    process.env.MONITOR_PUBLIC_URL = source;
    expect(content.detailLink('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('');
  });
});
