import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPaymentCountdown } from '../src/utils/paymentCountdown.js';

const now = Date.parse('2026-09-19T21:20:00+08:00');
const orderDate = '2026-09-19T21:13:59+08:00';

test('官网缺失时使用截图下单时间加30分钟并逐秒递减', () => {
  const task = { orderDate, deadlineAt: null };
  assert.equal(formatPaymentCountdown(task, now).text, '23 分 59 秒');
  assert.equal(formatPaymentCountdown(task, now + 1000).text, '23 分 58 秒');
  assert.deepEqual(task, { orderDate, deadlineAt: null });
});
test('官网截止不覆盖来源时间', () => {
  assert.equal(
    formatPaymentCountdown({ orderDate, deadlineAt: '2026-09-19T21:25:00+08:00' }, new Date(now))
      .text,
    '23 分 59 秒'
  );
});
test('UTC与北京时间得到同一截止时间', () => {
  assert.equal(
    formatPaymentCountdown({ orderDate: '2026-09-19T13:13:59.000Z' }, now).text,
    '23 分 59 秒'
  );
});
test('缺失、日期不完整、非法和无时区时间不生成预计截止', () => {
  for (const value of [
    null,
    '',
    '2026-09-19',
    'bad',
    '2026-99-99T20:00:00Z',
    '2026-09-19T20:00:00',
  ]) {
    assert.equal(formatPaymentCountdown({ orderDate: value }, now).text, '时间未知');
    assert.equal(formatPaymentCountdown({ orderDate: value }, now, '待核实').text, '待核实');
  }
});
test('来源时间超时仅显示已超时并标红', () => {
  const result = formatPaymentCountdown({ orderDate: '2026-09-19T20:40:00+08:00' }, now);
  assert.equal(result.text, '已超时');
  assert.match(result.className, /text-red/);
});
test('最后五分钟按实时预计剩余时间标红', () => {
  assert.match(
    formatPaymentCountdown({ orderDate: '2026-09-19T20:55:00+08:00' }, now).className,
    /text-red/
  );
});
test('终态优先于官方或预计倒计时', () => {
  for (const [officialOrderStatus, label] of [
    ['processing', '已付款'],
    ['cancelled', '订单已取消'],
    ['payment_expired', '付款已过期'],
    ['shipped', '无需付款'],
  ]) {
    assert.equal(formatPaymentCountdown({ orderDate, officialOrderStatus }, now).text, label);
  }
  assert.equal(
    formatPaymentCountdown({ orderDate, officialPaymentStatus: 'refunded' }, now).text,
    '已退款'
  );
});
test('非法官网截止允许来源兜底，非法时钟保持未知', () => {
  assert.equal(formatPaymentCountdown({ orderDate, deadlineAt: 'bad' }, now).text, '23 分 59 秒');
  assert.equal(formatPaymentCountdown({ orderDate }, NaN).text, '时间未知');
});
