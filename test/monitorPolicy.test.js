const { randomUUID } = require('crypto');
const p = require('../src/services/monitorPolicy');
const { PERMISSIONS, ROLE_PERMISSIONS } = require('../src/constants/business');
const rule = {
  name: '代理不可用',
  enabled: true,
  mode: 'any',
  keywords: ['没有可用的代理', '连接失败'],
  excludes: ['购买异常'],
  windowMinutes: 10,
  threshold: 5,
  severity: 'warning',
  deviceIds: [],
  directoryIds: [],
};
describe('服务器监控策略', () => {
  test('单独权限，管理员默认可用', () => {
    expect(PERMISSIONS.MONITOR_MANAGE).toBe('monitor.manage');
    expect(ROLE_PERMISSIONS.admin).toContain('monitor.manage');
    expect(require('../src/constants/permissionCatalog').ADMIN_RESERVED_PERMISSIONS).not.toContain(
      'monitor.manage'
    );
  });
  test('有界关键词、排除外层重复摘要、任一及全部匹配', () => {
    expect(p.validateRule(rule)).toEqual(rule);
    expect(p.matches(rule, '连接失败')).toBe(true);
    expect(p.matches(rule, '购买异常：连接失败')).toBe(false);
    expect(p.matches({ ...rule, mode: 'all' }, '连接失败')).toBe(false);
    expect(p.matches({ ...rule, mode: 'all' }, '没有可用的代理 / 连接失败')).toBe(true);
    expect(() => p.validateRule({ ...rule, keywords: [] })).toThrow();
    expect(() => p.validateRule({ ...rule, windowMinutes: 0 })).toThrow();
    expect(() => p.validateRule({ ...rule, threshold: 1.5 })).toThrow();
    expect(() => p.validateRule({ ...rule, regex: '.*' })).toThrow();
    expect(() => p.validateRule({ ...rule, mode: 'regex' })).toThrow();
    expect(() => p.validateRule({ ...rule, deviceIds: ['bad'] })).toThrow();
    expect(() => p.validateRule({ ...rule, excludes: Array(21).fill('x') })).toThrow();
    expect(() => p.validateRule({ ...rule, deviceIds: Array(101).fill(randomUUID()) })).toThrow();
  });
  test('实例和设备范围同时满足', () => {
    const device = randomUUID();
    const local = randomUUID();
    const scoped = { ...rule, deviceIds: [device], directoryIds: [local] };
    expect(p.applies(rule, device, local)).toBe(true);
    expect(p.applies(scoped, device, local)).toBe(true);
    expect(p.applies(scoped, randomUUID(), local)).toBe(false);
    expect(p.applies(scoped, device, randomUUID())).toBe(false);
    expect(p.applies({ ...rule, enabled: false }, device, local)).toBe(false);
  });
  test('只有新鲜有效扫描连续两次低于阈值自动恢复', () => {
    const at = new Date();
    const active = { status: 'active', quietChecks: 0 };
    expect(p.transition(null, rule, 5, at, true)).toMatchObject({ status: 'active', hitCount: 5 });
    expect(p.transition(null, rule, 0, at, true)).toBeNull();
    expect(p.transition(active, rule, 0, at, false)).toBeNull();
    const first = p.transition(active, rule, 4, at, true);
    expect(first).toEqual({ quietChecks: 1, hitCount: 4 });
    expect(p.transition({ ...active, ...first }, rule, 0, at, true)).toMatchObject({
      status: 'recovered',
    });
    expect(p.transition({ ...active, ...first }, rule, 5, at, true)).toMatchObject({
      status: 'active',
      quietChecks: 0,
    });
  });
  test('实例静默覆盖所有告警，失联及移除不提醒', () => {
    const now = new Date();
    const instance = { active: true, observedAt: now, snapshot: { state: 'ready' }, handling: {} };
    expect(p.displayState(instance, now).actionable).toBe(true);
    expect(
      p.displayState({ ...instance, handling: { until: new Date(+now + 60000) } }, now)
    ).toMatchObject({ muted: true, actionable: false });
    expect(p.displayState(instance, new Date(+now + 121000))).toMatchObject({
      state: 'offline',
      actionable: false,
    });
    expect(p.displayState({ ...instance, active: false }, now).state).toBe('removed');
    expect(p.displayState({}, now).actionable).toBe(false);
  });
  test('北京时间跨日查询、非法日历、90天上限与输入验证', () => {
    const range = p.dateRange('2026-09-13', '2026-09-14');
    expect(range.start.toISOString()).toBe('2026-09-12T16:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-09-14T16:00:00.000Z');
    for (const dates of [
      ['2026-02-30', '2026-03-01'],
      ['bad', '2026-09-15'],
      ['2026-09-15', '2026-09-13'],
      ['2026-01-01', '2026-09-15'],
      ['2026-99-99', '2026-09-15'],
    ])
      expect(() => p.dateRange(...dates)).toThrow();
    expect(() => p.shortText('\u0000', 10)).toThrow();
    expect(() => p.fields([], [])).toThrow();
    expect(() => p.uuid('not-a-uuid')).toThrow();
  });
});
