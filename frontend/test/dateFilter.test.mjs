import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isCalendarDate,
  shiftCalendarDate,
  resolveDateFilter,
  getBeijingToday,
  describeDateRange,
} from '../src/utils/dateFilter.js';

test('严格日期及公历跨月、跨年、闰年', () => {
  assert.equal(isCalendarDate('2024-02-29'), true);
  for (const value of ['2026-02-29', '2026-04-31', '26-01-01', 'invalid', '0000-01-01']) {
    assert.equal(isCalendarDate(value), false);
  }
  assert.equal(shiftCalendarDate('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftCalendarDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftCalendarDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftCalendarDate('9999-12-31', 1), '');
});
test('六种条件转换为包含边界的既有 API 参数', () => {
  assert.deepEqual(resolveDateFilter('between', '2026-10-01', '2026-10-08'), {
    dateFrom: '2026-10-01',
    dateTo: '2026-10-08',
  });
  assert.deepEqual(resolveDateFilter('on', '2026-10-08', ''), {
    dateFrom: '2026-10-08',
    dateTo: '2026-10-08',
  });
  assert.deepEqual(resolveDateFilter('before', '2026-03-01', ''), {
    dateFrom: '',
    dateTo: '2026-02-28',
  });
  assert.deepEqual(resolveDateFilter('after', '2026-12-31', ''), {
    dateFrom: '2027-01-01',
    dateTo: '',
  });
  assert.deepEqual(resolveDateFilter('onOrBefore', '2026-10-08', ''), {
    dateFrom: '',
    dateTo: '2026-10-08',
  });
  assert.deepEqual(resolveDateFilter('onOrAfter', '2026-10-08', ''), {
    dateFrom: '2026-10-08',
    dateTo: '',
  });
});
test('单边、反向、空范围和日期边界校验', () => {
  assert.deepEqual(resolveDateFilter('between', '', '2026-10-08'), {
    dateFrom: '',
    dateTo: '2026-10-08',
  });
  assert.deepEqual(resolveDateFilter('between', '2026-10-08', ''), {
    dateFrom: '2026-10-08',
    dateTo: '',
  });
  for (const args of [
    ['between', '', ''],
    ['between', '2026-10-09', '2026-10-08'],
    ['on', '', ''],
    ['before', '1000-01-01', ''],
    ['after', '9999-12-31', ''],
    ['other', '2026-10-08', ''],
  ]) {
    assert.equal(resolveDateFilter(...args), null);
  }
  assert.deepEqual(resolveDateFilter('on', '2026-10-08', 'invalid'), {
    dateFrom: '2026-10-08',
    dateTo: '2026-10-08',
  });
});
test('北京时间跨日和应用摘要', () => {
  assert.equal(getBeijingToday(new Date('2026-10-07T16:00:00Z')), '2026-10-08');
  assert.equal(getBeijingToday(new Date('2026-10-07T15:59:59Z')), '2026-10-07');
  assert.equal(describeDateRange('', ''), '不限日期');
  assert.equal(describeDateRange('2026-10-08', ''), '2026-10-08 起');
  assert.equal(describeDateRange('', '2026-10-08'), '截至 2026-10-08');
  assert.equal(describeDateRange('2026-10-08', '2026-10-08'), '2026-10-08');
});
