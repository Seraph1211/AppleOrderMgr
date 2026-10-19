jest.mock('../src/models', () => Object.fromEntries(['MonitorNotificationEvent', 'MonitorNotificationLink', 'MonitorAlert', 'MonitorInstance', 'AosDevice', 'MonitorRule'].map(name => [name, { findAll: jest.fn() }])));
jest.mock('../src/utils/logger', () => ({ debug: jest.fn() }));
const models = require('../src/models');
const { validEvents } = require('../src/services/monitorNotificationState');
const NOW = new Date('2026-10-19T08:00:00Z');
const DELIVERY = { id: 'delivery', channel: 'wecom', targetVersion: 1, category: 'recovery' };
let instance;
let alert;

beforeEach(() => {
  alert = { id: 'alert', instanceId: 'instance', ruleId: 'rule', ruleVersion: 1, status: 'recovered', recoveredAt: new Date(+NOW - 120000), severity: 'critical', ruleName: '测试规则', firstSeenAt: new Date(+NOW - 300000), lastSeenAt: new Date(+NOW - 120000), hitCount: 2 };
  instance = { id: 'instance', deviceId: 'device', active: true, label: '实例', observedAt: NOW, handling: {}, snapshot: { state: 'ready', results: [{ ruleId: 'rule', ruleVersion: 1, count: 0, clearSince: new Date(+NOW - 120000).toISOString() }] } };
  models.MonitorNotificationEvent.findAll.mockImplementation(() => Promise.resolve([{ id: 'event', payload: { alertId: 'alert', instanceId: 'instance', category: 'recovery' } }]));
  models.MonitorInstance.findAll.mockImplementation(() => Promise.resolve([instance]));
  models.MonitorAlert.findAll.mockImplementation(() => Promise.resolve([alert]));
  models.AosDevice.findAll.mockResolvedValue([{ id: 'device', enabled: true, name: '服务器', heartbeatAt: NOW }]);
  models.MonitorRule.findAll.mockResolvedValue([{ id: 'rule', version: 1, config: { enabled: true } }]);
  models.MonitorNotificationLink.findAll.mockResolvedValue([{ alertId: 'alert', initialStatus: 'unknown' }]);
});

test('应在有效连续解除恰满两分钟允许恢复并注明原提醒未知', async () => {
  const result = await validEvents(DELIVERY, NOW);
  expect(result).toHaveLength(1);
  expect(result[0].originalUnknown).toBe(true);
});
test('应在120秒之前保留恢复观察', async () => {
  instance.snapshot.results[0].clearSince = new Date(+NOW - 119999).toISOString();
  expect(await validEvents(DELIVERY, NOW)).toEqual([]);
});
test('应拒绝只有recoveredAt但没有连续扫描证据的恢复', async () => {
  instance.snapshot.results = [];
  expect(await validEvents(DELIVERY, NOW)).toEqual([]);
});
test('应在扫描中断超过90秒后拒绝恢复', async () => {
  instance.observedAt = new Date(+NOW - 90001);
  expect(await validEvents(DELIVERY, NOW)).toEqual([]);
});
test('应在规则版本错配时拒绝恢复', async () => {
  instance.snapshot.results[0].ruleVersion = 2;
  expect(await validEvents(DELIVERY, NOW)).toEqual([]);
});
test('应在同规则已有新异常周期时取消旧恢复', async () => {
  models.MonitorAlert.findAll.mockResolvedValue([alert, { ...alert, id: 'new-alert', status: 'active' }]);
  expect(await validEvents(DELIVERY, NOW)).toEqual([]);
});
test('应在人工静默中保留站内记录并不发送恢复', async () => {
  instance.handling.until = new Date(+NOW + 60000).toISOString();
  expect(await validEvents(DELIVERY, NOW)).toEqual([]);
});
test('应在无原通道接受或未知事实时拒绝孤立恢复', async () => {
  models.MonitorNotificationLink.findAll.mockResolvedValue([]);
  expect(await validEvents(DELIVERY, NOW)).toEqual([]);
});
