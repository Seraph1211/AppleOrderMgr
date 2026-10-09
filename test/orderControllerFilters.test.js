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

test('订单密码快照仅在显式允许详情读取时返回，列表始终隐藏密码', () => {
  const order = {
    toJSON: () => ({
      id: 1,
      orderNumber: 'W1234567890',
      appleId: 'account@example.test',
      applePassword: 'synthetic-password',
      products: [],
    }),
  };

  expect(serializeOrderListItem(order).apple_password).toBeNull();
  expect(serializeOrderDetail(order).apple_password).toBeNull();
  expect(serializeOrderDetail(order, false, true).apple_password).toBe('synthetic-password');
});

test.each([null, ''])('订单密码快照为空 %j 时不回退到关联账号密码', applePassword => {
  const order = {
    toJSON: () => ({
      products: [],
      applePassword,
      appleAccount: { id: 2, appleId: 'synthetic@example.test', password: 'other-password' },
    }),
  };
  expect(serializeOrderDetail(order, false, true).apple_password).toBeNull();
});

test.each(['admin', 'operator', 'readOnly'])(
  '%s 仅有订单查看权限可读密码及完整下单手机号并禁止缓存',
  async role => {
    const { Order } = require('../src/models');
    Order.findOne = jest.fn().mockResolvedValue({
      toJSON: () => ({
        id: 1,
        orderNumber: 'W1234567890',
        appleId: 'account@example.test',
        applePassword: 'synthetic-password',
        recipientPhone: '13800138000',
        products: [],
      }),
    });
    const res = { set: jest.fn(), json: jest.fn() };
    const req = {
      params: { id: '1' },
      user: {
        role,
        permissions: ['orders.read'],
        orderAccess: { mode: 'tags', tags: ['合成授权 TAG'] },
      },
    };

    await getOrderDetail(req, res);

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apple_password: 'synthetic-password',
          recipient_phone: '13800138000',
        }),
      })
    );
    if (role !== 'admin') {
      expect(Order.findOne.mock.calls[0][0].where).toEqual({
        [Op.and]: [{ id: 1 }, { tag: { [Op.in]: ['合成授权 TAG'] } }],
      });
    }
  }
);

test.each(['13800138000', null])('详情下单手机号使用订单快照 %s，不混入档案号码', phone => {
  const order = {
    toJSON: () => ({
      id: 1,
      recipientPhone: phone,
      recipient: { id: 2, phone: '13900139000' },
      products: [],
    }),
  };
  expect(serializeOrderDetail(order)).toMatchObject({
    recipient_phone: phone,
    recipient: { phone: '139****9000' },
  });
  expect(serializeOrderListItem(order).recipient_phone).toBe(phone ? '138****8000' : null);
});

test('订单范围外查询不返回密码或详情', async () => {
  const { Order } = require('../src/models');
  Order.findOne = jest.fn().mockResolvedValue(null);
  const res = { set: jest.fn(), json: jest.fn() };
  await expect(
    getOrderDetail(
      {
        params: { id: '1' },
        user: {
          role: 'operator',
          permissions: ['orders.read'],
          orderAccess: { mode: 'tags', tags: [] },
        },
      },
      res
    )
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(Order.findOne.mock.calls[0][0].where).toEqual({
    [Op.and]: [{ id: 1 }, { tag: { [Op.in]: [] } }],
  });
  expect(res.json).not.toHaveBeenCalled();
});

test('没有订单查看权限时订单入口拒绝访问', () => {
  const { requirePermission } = require('../src/middleware/authMiddleware');
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  requirePermission('orders.read')(
    { user: { role: 'operator', permissions: ['apple_ids.read'] } },
    res,
    next
  );
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
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

test('实际取货日期在列表、详情中同源只读返回，缺失保留 null', () => {
  const plain = { id: 1, products: [], actualPickupDate: '2026-09-22' };
  const order = { toJSON: () => plain };
  expect(serializeOrderListItem(order).actual_pickup_date).toBe('2026-09-22');
  expect(serializeOrderDetail(order).actual_pickup_date).toBe('2026-09-22');
  plain.actualPickupDate = null;
  expect(serializeOrderListItem(order).actual_pickup_date).toBeNull();
});

test('实际取货日期范围包含两端、支持单边并独立于预约日期', () => {
  const { where } = buildListFilters({
    actualPickupDateFrom: '2026-09-23',
    actualPickupDateTo: '2026-09-25',
    pickupDate: '2026-09-18',
  });
  expect(where.actualPickupDate).toEqual({ [Op.gte]: '2026-09-23', [Op.lte]: '2026-09-25' });
  expect(where.emailPickupDate).toBe('2026-09-18');
  expect(buildListFilters({ actualPickupDateFrom: '2026-09-23' }).where.actualPickupDate).toEqual({
    [Op.gte]: '2026-09-23',
  });
  expect(buildListFilters({ actualPickupDateTo: '2026-09-25' }).where.actualPickupDate).toEqual({
    [Op.lte]: '2026-09-25',
  });
  expect(
    buildListFilters({ actualPickupDateFrom: '', actualPickupDateTo: '' }).where.actualPickupDate
  ).toBeUndefined();
});
test.each([
  { actualPickupDateFrom: '2026-02-30' },
  { actualPickupDateTo: ['2026-09-25'] },
  { actualPickupDateFrom: '2026-09-25', actualPickupDateTo: '2026-09-24' },
])('拒绝非法实际取货日期范围 %j', query => expect(() => buildListFilters(query)).toThrow());

test('官网状态独立组合，按原始分隔项匹配并兼容同义状态', () => {
  const { where } = buildListFilters({
    officialOrderStatuses: '["PICKUP_READY","__not_observed__"]',
    displayOrderStatuses: '["processing"]',
    recipientTags: '["授权TAG"]',
  });
  expect(where[Op.and][0].logic[Op.in]).toEqual(['processing']);
  const sql = where[Op.and][1].val;
  expect(sql).toContain('"Order"."official_raw_status"');
  expect(sql).toContain('regexp_split_to_array');
  expect(sql).toContain("'READY_FOR_PICKUP'");
  expect(sql).toContain("'PICKUP_READY'");
  expect(sql).toContain("= '' OR");
  expect(where[Op.and][2].logic[Op.in]).toEqual(['授权TAG']);
  expect(buildListFilters({ officialOrderStatuses: '[]' }).where[Op.and]).toBeUndefined();
});

test.each([
  '[',
  '[1]',
  {},
  JSON.stringify(['A'.repeat(101)]),
  JSON.stringify(Array(101).fill('PICKED_UP')),
  '["A | B"]',
])('非法官网状态输入被拒绝 %s', value => {
  expect(() => buildListFilters({ officialOrderStatuses: value })).toThrow();
});

test('官网未知状态使用值转义而不是拼接 SQL 控制字符', () => {
  const { where } = buildListFilters({ officialOrderStatuses: ["UNKNOWN'); SELECT 1; --"] });
  expect(where[Op.and][0].val).toContain("'UNKNOWN''); SELECT 1; --'");
});

test('官网候选来自受限订单，拆分归一、排除自身筛选并保留其他筛选', async () => {
  const { Order } = require('../src/models');
  const { getFilterOptions } = require('../src/controllers/orderController');
  Order.findAll = jest
    .fn()
    .mockResolvedValue([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      { officialRawStatus: 'PICKUP_READY | PICKED_UP' },
      { officialRawStatus: 'READY_FOR_PICKUP' },
      { officialRawStatus: null },
      { officialRawStatus: 'CANCELED | NEW_STATUS' },
    ]);
  const res = { json: jest.fn() };
  await getFilterOptions(
    {
      query: { officialOrderStatuses: '["PICKED_UP"]', displayOrderStatuses: '["processing"]' },
      user: { role: 'operator', orderAccess: { mode: 'tags', tags: ['授权TAG'] } },
    },
    res
  );
  const options = res.json.mock.calls[0][0].data.officialOrderStatuses;
  expect(new Set(options)).toEqual(
    new Set(['READY_FOR_PICKUP', 'PICKED_UP', '__not_observed__', 'CANCELLED', 'NEW_STATUS'])
  );
  const query = Order.findAll.mock.calls[3][0];
  expect(query.where[Op.and][1].tag[Op.in]).toEqual(['授权TAG']);
  expect(query.where[Op.and][0][Op.and]).toHaveLength(1);
  expect(query.where[Op.and][0][Op.and][0].logic[Op.in]).toEqual(['processing']);
});

test('列表和导出都保留官网状态条件及授权范围', async () => {
  const { Order } = require('../src/models');
  const { listOrders, exportOrders } = require('../src/controllers/orderController');
  const req = {
    query: { officialOrderStatuses: '["PICKED_UP"]' },
    user: {
      id: 1,
      role: 'operator',
      orderAccess: { mode: 'tags', tags: ['授权TAG'] },
      permissions: [],
    },
  };
  Order.findAndCountAll = jest.fn().mockResolvedValue({ count: 0, rows: [] });
  Order.findAll = jest.fn().mockResolvedValue([]);
  await listOrders(req, { json: jest.fn() });
  await exportOrders(req, { setHeader: jest.fn(), send: jest.fn() });
  for (const query of [Order.findAndCountAll.mock.calls[0][0], Order.findAll.mock.calls[0][0]]) {
    expect(query.where[Op.and][1].tag[Op.in]).toEqual(['授权TAG']);
    expect(query.where[Op.and][0][Op.and][0].val).toContain("'PICKED_UP'");
  }
});

test('列表按当前页批量读取运行任务，普通用户及无编辑权限管理员不读取队列', async () => {
  const { Order, PickupDevice, sequelize } = require('../src/models');
  const { listOrders } = require('../src/controllers/orderController');
  const rows = [1, 2].map(id => ({
    id,
    setDataValue: jest.fn(),
    toJSON: () => ({ id, orderNumber: `W000000000${id}`, products: [] }),
  }));
  Order.findAndCountAll = jest.fn().mockResolvedValue({ count: rows.length, rows });
  PickupDevice.findAll = jest.fn().mockResolvedValue([]);
  sequelize.query = jest.fn().mockResolvedValue([{ orderId: 2 }]);
  const res = { json: jest.fn() };
  await listOrders({ query: {}, user: { role: 'admin', permissions: ['orders.edit'] } }, res);
  expect(sequelize.query).toHaveBeenCalledTimes(1);
  expect(sequelize.query.mock.calls[0][1].replacements.orderIds).toEqual([1, 2]);
  expect(sequelize.query.mock.calls[0][0]).toContain("state='running'");
  expect(res.json.mock.calls[0][0].data.orders.map(order => order.official_refresh_state)).toEqual([
    null,
    'running',
  ]);
  sequelize.query.mockClear();
  for (const user of [
    { role: 'operator', permissions: ['orders.edit'], orderAccess: { mode: 'all', tags: [] } },
    { role: 'admin', permissions: [] },
  ]) {
    res.json.mockClear();
    await listOrders({ query: {}, user }, res);
    expect(
      res.json.mock.calls[0][0].data.orders.every(order => order.official_refresh_state === null)
    ).toBe(true);
  }
  expect(sequelize.query).not.toHaveBeenCalled();
});

test('付款人多选精确匹配、优先于旧模糊参数并叠加官网状态', () => {
  const { where } = buildListFilters({
    payerNames: '["明威","明威二"]',
    payerName: '旧值',
    officialOrderStatuses: '["PICKED_UP"]',
  });
  expect(where.payerName[Op.in]).toEqual(['明威', '明威二']);
  expect(where[Op.and][0].val).toContain("'PICKED_UP'");
  expect(buildListFilters({ payerName: '明威' }).where.payerName[Op.iLike]).toBe('%明威%');
  expect(() => buildListFilters({ payerNames: '[1]' })).toThrow();
  expect(() => buildListFilters({ payerNames: ['x'.repeat(101)] })).toThrow();
});

test('付款人候选排除自身条件、保留商品和 TAG 权限且不取全局人员目录', async () => {
  const { Order } = require('../src/models');
  const { getFilterOptions } = require('../src/controllers/orderController');
  Order.findAll = jest
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      { payerName: '明威' },
      { payerName: '明威' },
      { payerName: '付款人乙' },
      { payerName: null },
    ]);
  const res = { json: jest.fn() };
  await getFilterOptions(
    {
      query: { payerNames: '["明威"]', productKeys: JSON.stringify(['name:' + 'a'.repeat(64)]) },
      user: { role: 'operator', orderAccess: { mode: 'tags', tags: ['授权TAG'] } },
    },
    res
  );
  expect(new Set(res.json.mock.calls[0][0].data.payers)).toEqual(new Set(['明威', '付款人乙']));
  const query = Order.findAll.mock.calls[4][0];
  expect(query.where[Op.and][0].payerName).toBeUndefined();
  expect(query.where[Op.and][0][Op.and][0].val).toContain('product_filter_items');
  expect(query.where[Op.and][1].tag[Op.in]).toEqual(['授权TAG']);
});

test('预约取货范围包含双边且独立组合实际取货日和旧单日条件', () => {
  const { where } = buildListFilters({
    pickupDateFrom: '2026-09-19',
    pickupDateTo: '2026-09-22',
    pickupDate: '2026-09-20',
    actualPickupDateFrom: '2026-09-23',
  });
  expect(where.emailPickupDate).toEqual({
    [Op.gte]: '2026-09-19',
    [Op.lte]: '2026-09-22',
    [Op.eq]: '2026-09-20',
  });
  expect(where.actualPickupDate).toEqual({ [Op.gte]: '2026-09-23' });
  expect(buildListFilters({ pickupDateFrom: '2026-09-19' }).where.emailPickupDate).toEqual({
    [Op.gte]: '2026-09-19',
  });
  expect(buildListFilters({ pickupDateTo: '2026-09-22' }).where.emailPickupDate).toEqual({
    [Op.lte]: '2026-09-22',
  });
  expect(
    buildListFilters({ pickupDateFrom: '', pickupDateTo: '' }).where.emailPickupDate
  ).toBeUndefined();
});

test.each([
  { pickupDateFrom: '2026-02-30' },
  { pickupDateTo: ['2026-09-20'] },
  { pickupDateFrom: '2026-09-22', pickupDateTo: '2026-09-19' },
])('预约取货范围拒绝非法参数 %j', query => {
  expect(() => buildListFilters(query)).toThrow();
});
