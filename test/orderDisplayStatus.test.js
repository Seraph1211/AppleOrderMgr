const { getDisplayOrderStatus } = require('../src/utils/orderDisplayStatus');

const now = new Date('2026-09-28T12:00:00.000Z');
const order = {
  emailOrderStatus: 'confirmed',
  emailPaymentStatus: 'unknown',
  orderDate: new Date('2026-09-28T11:30:00.000Z'),
};

test('下单满 30 分钟且仍未确认付款时展示已过期', () => {
  expect(getDisplayOrderStatus(order, new Date(now.getTime() - 1))).toBe('confirmed');
  expect(getDisplayOrderStatus(order, now)).toBe('expired');
});

test('付款证据、后续邮件阶段和未知下单时间均不展示已过期', () => {
  expect(getDisplayOrderStatus({ ...order, emailPaymentStatus: 'paid' }, now)).toBe('confirmed');
  expect(getDisplayOrderStatus({ ...order, emailOrderStatus: 'processing' }, now)).toBe(
    'processing'
  );
  expect(getDisplayOrderStatus({ ...order, orderDate: null }, now)).toBe('confirmed');
  expect(getDisplayOrderStatus({ ...order, orderDate: '2026-09-28' }, now)).toBe('confirmed');
});
