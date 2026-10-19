const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(
  path.join(__dirname, '../frontend/src/utils/monitorLogRange.js'),
  'utf8'
);
const { logDay, logRangePreset, normalizeLogDateTime, validateLogRange, describeLogRange } =
  vm.runInNewContext(
    `${source.replace(/export function /g, 'function ')}; ({ logDay, logRangePreset, normalizeLogDateTime, validateLogRange, describeLogRange })`
  );

const now = Date.parse('2026-10-18T16:30:45Z');

test('北京时间跨日与全天快捷范围保持秒级完整边界', () => {
  expect(logDay(0, now)).toBe('2026-10-19');
  expect(logRangePreset('today', now)).toEqual({
    startAt: '2026-10-19T00:00:00',
    endAt: '2026-10-19T23:59:59',
  });
  expect(logRangePreset('yesterday', now)).toEqual({
    startAt: '2026-10-18T00:00:00',
    endAt: '2026-10-18T23:59:59',
  });
  expect(logRangePreset('last24', now)).toEqual({
    startAt: '2026-10-18T00:30:45',
    endAt: '2026-10-19T00:30:45',
  });
});

test('允许跨天和同一秒，拒绝无效、倒置、过期或未来日期', () => {
  const validate = (start, end) => validateLogRange(start, end, '2026-07-22', '2026-10-19');
  expect(validate('2026-10-18T23:00:00', '2026-10-19T01:00:00')).toBe('');
  expect(validate('2026-10-19T00:00:00', '2026-10-19T00:00:00')).toBe('');
  expect(validate('2026-10-19T01:00:00', '2026-10-18T23:00:00')).toContain('不能晚于');
  expect(validate('2026-07-21T23:59:59', '2026-10-19T00:00:00')).toContain('之间');
  expect(validate('2026-10-19T00:00:00', '2026-10-20T00:00:00')).toContain('之间');
  expect(validate('2026-09-31T00:00:00', '2026-10-19T00:00:00')).toContain('完整');
  expect(validate('', '2026-10-19T00:00:00')).toContain('完整');
});

test('浏览器省略秒时补零，摘要显示跨日完整日期', () => {
  expect(normalizeLogDateTime('2026-10-19T12:34')).toBe('2026-10-19T12:34:00');
  expect(describeLogRange('2026-10-18T23:00:00', '2026-10-19T01:00:00')).toBe(
    '2026-10-18 23:00:00 — 2026-10-19 01:00:00'
  );
  expect(describeLogRange('2026-10-19T00:00:00', '2026-10-19T23:59:59')).toBe(
    '2026-10-19 00:00:00 — 23:59:59'
  );
});
