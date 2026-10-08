const { execFileSync } = require('node:child_process');
const {
  getDisplayOrderStatus,
  getDisplayOrderStatusLabel,
  DISPLAY_ORDER_STATUSES,
} = require('../src/utils/orderDisplayStatus');

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

test('Excel 中文名称与页面状态映射逐项一致，未知值回退待确认', () => {
  const labels = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { DISPLAY_ORDER_STATUS_LABELS } from './frontend/src/constants/orderStatus.js'; process.stdout.write(JSON.stringify(DISPLAY_ORDER_STATUS_LABELS));",
      ],
      { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' }
    )
  );
  expect(Object.keys(labels).sort()).toEqual([...DISPLAY_ORDER_STATUSES].sort());
  for (const status of DISPLAY_ORDER_STATUSES) {
    expect(getDisplayOrderStatusLabel(status)).toBe(labels[status]);
  }
  for (const status of [undefined, null, '', 'invalid_status', 'toString', '__proto__']) {
    expect(getDisplayOrderStatusLabel(status)).toBe(labels.unknown);
  }
});
