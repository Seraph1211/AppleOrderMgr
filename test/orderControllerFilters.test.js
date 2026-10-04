/* eslint-disable camelcase */
const { Op } = require('sequelize');

jest.mock('../src/models', () => ({
  sequelize: { escape: value => `'${String(value).replaceAll("'", "''")}'` },
  Order: {},
  AppleId: {},
  Recipient: {},
  EmailLog: {},
  PickupDevice: {},
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  buildListFilters,
  getOrderDetail,
  getOrderLink,
  serializeOrderListItem,
  serializeOrderDetail,
} = require('../src/controllers/orderController');

test('邮件订单与付款状态使用独立受控多选', () => {
  const { where } = buildListFilters({
    emailOrderStatuses: JSON.stringify(['processing', 'ready_for_pickup']),
    emailPaymentStatuses: JSON.stringify(['paid']),
  });
  expect(where.emailOrderStatus[Op.in]).toEqual(['processing', 'ready_for_pickup']);
  expect(where.emailPaymentStatus[Op.in]).toEqual(['paid']);
  expect(
    buildListFilters({ emailOrderStatuses: '["picked_up"]' }).where.emailOrderStatus[Op.in]
  ).toEqual(['picked_up']);
});

test('订单管理展示状态支持付款超时并在数据库分页前筛选', () => {
  const { where } = buildListFilters({
    displayOrderStatuses: '["confirmed","payment_timeout"]',
  });
  expect(where[Op.and][0].attribute.val).toContain("'confirmed'");
  expect(where[Op.and][0].logic[Op.in]).toEqual(['confirmed', 'payment_timeout']);
  expect(() => buildListFilters({ displayOrderStatuses: '["paid"]' })).toThrow();
});

test('订单管理展示状态不覆盖原邮件状态', () => {
  const order = {
    toJSON: () => ({
      id: 1,
      products: [],
      emailOrderStatus: 'confirmed',
      emailPaymentStatus: 'unknown',
      orderDate: new Date('2020-01-01T00:00:00Z'),
    }),
  };
  expect(serializeOrderListItem(order)).toMatchObject({
    email_order_status: 'confirmed',
    display_order_status: 'payment_timeout',
  });
  expect(serializeOrderDetail(order).display_order_status).toBe('payment_timeout');
});

test.each([{ status: 'processing' }, { statuses: '["processing"]' }, { payment_status: 'paid' }])(
  '官网状态筛选参数退休 %j',
  query => {
    expect(() => buildListFilters(query)).toThrow('官网状态筛选参数已退休');
  }
);

test('TAG、邮件取货门店和日期可组合筛选', () => {
  const tags = ['重庆 邓超', "A,B'O"];
  const { where } = buildListFilters({
    recipientTags: JSON.stringify(tags),
    pickupStores: JSON.stringify(['Apple 成都万象城']),
    pickupDate: '2026-09-19',
  });
  expect(where[Op.and][0].logic[Op.in]).toEqual(tags);
  expect(where[Op.and][1].logic[Op.in]).toEqual(['Apple 成都万象城']);
  expect(where.emailPickupDate).toBe('2026-09-19');
});

test('订单 DTO 只返回邮件生命周期和历史限制', () => {
  const plain = {
    id: 1,
    orderNumber: 'W1234567890',
    appleId: 'account@example.test',
    recipientName: '测试取机人',
    recipientPhone: '13800138000',
    products: [],
    emailOrderStatus: 'processing',
    emailPaymentStatus: 'paid',
    emailPickupStatus: 'scheduled',
    emailLifecycleUpdatedAt: '2026-09-21T00:00:00Z',
    paymentAssignmentHoldReason: 'legacy_payment_restriction',
  };
  const order = { toJSON: () => plain };
  const list = serializeOrderListItem(order);
  const detail = serializeOrderDetail(order);
  expect(list).toMatchObject({
    email_order_status: 'processing',
    email_payment_status: 'paid',
    payment_assignment_hold_reason: 'legacy_payment_restriction',
  });
  expect(detail).toMatchObject({
    email_order_status: 'processing',
    email_payment_status: 'paid',
    payment_assignment_hold_reason: 'legacy_payment_restriction',
  });
  expect(list.official_order_status).toBeNull();
  expect(detail.official_order_status).toBeNull();
});

test('订单详情仅在订单敏感字段权限通过后返回密码快照', () => {
  const order = {
    toJSON: () => ({
      id: 1,
      orderNumber: 'W1234567890',
      appleId: 'account@example.test',
      applePassword: 'synthetic-password',
      products: [],
    }),
  };

  expect(serializeOrderDetail(order).apple_password).toBeNull();
  expect(serializeOrderDetail(order, false, true).apple_password).toBe('synthetic-password');
});

test('订单详情按权限返回密码并禁止缓存', async () => {
  const { Order } = require('../src/models');
  Order.findOne = jest.fn().mockResolvedValue({
    toJSON: () => ({
      id: 1,
      orderNumber: 'W1234567890',
      appleId: 'account@example.test',
      applePassword: 'synthetic-password',
      products: [],
    }),
  });
  const res = { set: jest.fn(), json: jest.fn() };

  await getOrderDetail(
    {
      params: { id: '1' },
      user: {
        role: 'admin',
        permissions: ['orders.read', 'orders.secrets.read'],
        orderAccess: { mode: 'all' },
      },
    },
    res
  );

  expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ apple_password: 'synthetic-password' }),
    })
  );
});

test('订单链接按订单范围单独读取且禁止缓存', async () => {
  const { Order } = require('../src/models');
  Order.findOne = jest.fn().mockResolvedValue({
    id: 123,
    orderNumber: 'W1234567890',
    orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/synthetic',
  });
  const res = { set: jest.fn(), json: jest.fn() };
  await getOrderLink({ params: { id: '123' }, user: { id: 1, role: 'admin' } }, res);
  expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ success: true, data: expect.objectContaining({ id: 123 }) })
  );
});

test('付款超时与 Apple 终态分别筛选且兼容邮件原始状态参数', () => {
  for (const status of ['payment_timeout', 'partially_cancelled', 'expired', 'cancelled']) {
    const { where } = buildListFilters({ displayOrderStatuses: JSON.stringify([status]) });
    expect(where[Op.and][0].logic[Op.in]).toEqual([status]);
  }
  for (const status of ['partially_cancelled', 'expired', 'cancelled']) {
    expect(
      buildListFilters({ emailOrderStatuses: JSON.stringify([status]) }).where.emailOrderStatus[
        Op.in
      ]
    ).toEqual([status]);
    const order = { toJSON: () => ({ products: [], emailOrderStatus: status }) };
    expect(serializeOrderListItem(order).display_order_status).toBe(status);
    expect(serializeOrderDetail(order).display_order_status).toBe(status);
  }
  expect(() => buildListFilters({ emailOrderStatuses: '["payment_timeout"]' })).toThrow();
});
