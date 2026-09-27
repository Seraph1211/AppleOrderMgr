const { getDisplayOrderStatus } = require('../src/utils/orderDisplayStatus');

const now = new Date('2026-09-28T12:00:00.000Z');
const order = {
  emailOrderStatus: 'confirmed',
  emailPaymentStatus: 'unknown',
  orderDate: new Date('2026-09-28T11:30:00.000Z'),
};

test('下单满 30 分钟且仍未确认付款时展示付款超时', () => {
  expect(getDisplayOrderStatus(order, new Date(now.getTime() - 1))).toBe('confirmed');
  expect(getDisplayOrderStatus(order, now)).toBe('payment_timeout');
});

test('付款证据、后续邮件阶段和未知下单时间均不展示付款超时', () => {
  expect(getDisplayOrderStatus({ ...order, emailPaymentStatus: 'paid' }, now)).toBe('confirmed');
  expect(getDisplayOrderStatus({ ...order, emailOrderStatus: 'processing' }, now)).toBe(
    'processing'
  );
  expect(getDisplayOrderStatus({ ...order, orderDate: null }, now)).toBe('confirmed');
  expect(getDisplayOrderStatus({ ...order, orderDate: '2026-09-28' }, now)).toBe('confirmed');
});

test.each(['partially_cancelled', 'expired', 'cancelled', 'ready_for_pickup', 'picked_up'])(
  '邮件状态 %s 不被付款时限覆盖',
  status => {
    expect(getDisplayOrderStatus({ ...order, emailOrderStatus: status }, now)).toBe(status);
  }
);

test('付款邮件到达后从付款超时切换为处理中', () => {
  expect(getDisplayOrderStatus(order, now)).toBe('payment_timeout');
  expect(
    getDisplayOrderStatus(
      { ...order, emailOrderStatus: 'processing', emailPaymentStatus: 'paid' },
      now
    )
  ).toBe('processing');
});
