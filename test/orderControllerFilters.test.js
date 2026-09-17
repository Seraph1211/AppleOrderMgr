/* eslint-disable camelcase */
const { Op } = require('sequelize');

jest.mock('../src/models', () => ({
  sequelize: {
    escape: value => `'${String(value).replaceAll("'", "''")}'`,
  },
  Order: {},
  AppleId: {},
  Recipient: {},
  EmailLog: {},
  OrderRefreshSchedule: {},
  OrderRefreshJob: {},
}));
jest.mock('../src/services/crawler/refreshJobService', () => ({}));
jest.mock('../src/services/crawler/refreshPolicy', () => ({
  getDisplayedFreshness: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  buildListFilters,
  getFilterOptions,
  serializeOrderListItem,
  serializeOrderDetail,
} = require('../src/controllers/orderController');

describe('订单列表组合筛选', () => {
  test('订单 completed 不再可筛选，读取归为 unknown 并可按 unknown 查到', () => {
    expect(() => buildListFilters({ status: 'completed' })).toThrow();
    const { where } = buildListFilters({ status: 'unknown' });
    expect(where.status[Op.or][1][Op.notIn]).not.toContain('completed');
    expect(where.status[Op.or][1][Op.notIn]).toContain('pending');
    const order = { toJSON: () => ({ id: 1, status: 'completed', products: [] }) };
    expect(serializeOrderListItem(order).status).toBe('unknown');
    expect(serializeOrderDetail(order).status).toBe('unknown');
  });
  test.each(['payment_due', 'payment_received', 'picked_up', 'payment_expired'])(
    '新生命周期 %s 可精确筛选',
    status => {
      expect(buildListFilters({ status }).where.status).toBe(status);
    }
  );
  test('unknown 同时包含字面值、NULL 和空字符串', () => {
    const { where } = buildListFilters({ payment_status: 'unknown' });
    const alternatives = where[Op.and][0][Op.or];

    expect(alternatives).toEqual(
      expect.arrayContaining([
        { paymentStatus: 'unknown' },
        { paymentStatus: null },
        { paymentStatus: '' },
      ])
    );
  });

  test('已付款状态使用精确匹配', () => {
    const { where } = buildListFilters({ payment_status: 'paid' });

    expect(where).toEqual({ paymentStatus: 'paid' });
  });

  test('非法付款状态被拒绝', () => {
    expect(() => buildListFilters({ payment_status: 'pending' })).toThrow('payment_status 非法');
  });

  test('订单状态多选同维度使用 OR', () => {
    const statuses = ['payment_due', 'ready_for_pickup'];
    const { where } = buildListFilters({ statuses: JSON.stringify(statuses) });

    expect(where.status[Op.in]).toEqual(statuses);
  });

  test('商品信息和门店多选与取货日期组合筛选', () => {
    const { where } = buildListFilters({
      productNames: JSON.stringify([
        'iPhone 18 Pro Max 512GB 勃艮第酒红色',
        'iPhone 18 Pro 256GB 银色',
      ]),
      pickupStores: JSON.stringify(['Apple Store 零售店', 'Apple 成都万象城']),
      pickupDate: '2026-09-19',
    });

    expect(where.pickupStore[Op.in]).toEqual(['Apple Store 零售店', 'Apple 成都万象城']);
    expect(where[Op.and][0].val).toContain("item->>'name' IN");
    expect(where[Op.and][0].val).toContain('iPhone 18 Pro Max 512GB 勃艮第酒红色');
    const pickupAlternatives = where[Op.and][1][Op.or];
    const [absoluteCondition, todayCondition, tomorrowCondition] = pickupAlternatives;
    expect(absoluteCondition.officialFulfillmentMessage[Op.iLike]).toBe('%2026/09/19%');
    expect(todayCondition[Op.and][0].officialFulfillmentMessage[Op.iLike]).toBe('%今天%');
    expect(todayCondition[Op.and][1].val).toContain("'2026-09-19'::date");
    expect(tomorrowCondition[Op.and][0].officialFulfillmentMessage[Op.iLike]).toBe('%明天%');
    expect(tomorrowCondition[Op.and][1].val).toContain("INTERVAL '1 day'");
  });

  test.each(['2026/09/19', '2026-02-30', 'bad'])('拒绝非法取货日期 %s', pickupDate => {
    expect(() => buildListFilters({ pickupDate })).toThrow(
      'pickupDate 必须是有效的 YYYY-MM-DD 日期'
    );
  });

  test('拒绝非法多选参数和状态值', () => {
    expect(() => buildListFilters({ statuses: '[invalid' })).toThrow('statuses 必须是合法数组');
    expect(() => buildListFilters({ statuses: '["not-a-status"]' })).toThrow('statuses 包含非法值');
    expect(() => buildListFilters({ productNames: '[123]' })).toThrow(
      'productNames 每项必须是字符串'
    );
  });
});

describe('邮件快照展示回归', () => {
  const snapshot = {
    id: 1,
    appleId: 'account@example.test',
    recipientName: '测试取机人',
    recipientEmail: 'contact@example.test',
    recipientPhone: '13800138000',
    tag: '测试渠道',
    products: [],
    lastCrawledAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
  };
  test('没有关联档案时列表和详情仍显示邮件信息并脱敏', () => {
    const order = { toJSON: () => snapshot };
    const list = serializeOrderListItem(order);
    const detail = serializeOrderDetail(order);
    expect(list.apple_id).toBe(snapshot.appleId);
    expect(list.recipient_name).toBe(snapshot.recipientName);
    expect(list.recipient_tag).toBe(snapshot.tag);
    expect(list.last_crawled_at).toBe(snapshot.lastCrawledAt);
    expect(detail.apple_id).toMatchObject({ id: null, apple_id: snapshot.appleId });
    expect(detail.recipient).toMatchObject({ id: null, name: snapshot.recipientName });
    expect(detail.recipient.phone).not.toBe(snapshot.recipientPhone);
    expect(detail.recipient_email).toBe(snapshot.recipientEmail);
    expect(detail.recipient_phone).not.toBe(snapshot.recipientPhone);
  });

  test('列表和详情从官网履约提示派生取货安排但保留原文', () => {
    const order = {
      toJSON: () => ({
        ...snapshot,
        officialFulfillmentMessage:
          '请于 星期六 2026/09/19 的 20:30 – 20:45 之间到 Apple Store 零售店签到',
      }),
    };

    expect(serializeOrderListItem(order).pickup_time).toBe('2026/09/19 20:30 – 20:45');
    expect(serializeOrderDetail(order)).toMatchObject({
      official_fulfillment_message:
        '请于 星期六 2026/09/19 的 20:30 – 20:45 之间到 Apple Store 零售店签到',
      official_pickup_date: '2026/09/19',
      official_pickup_time_slot: '20:30 – 20:45',
      pickup_time: '2026/09/19 20:30 – 20:45',
    });
  });

  test('今天明天以官网观测时间换算且商品履约提示同步返回绝对时间', () => {
    const order = {
      toJSON: () => ({
        ...snapshot,
        officialStatusObservedAt: '2026-09-18T01:02:36+08:00',
        officialFulfillmentMessage: '请于 明天 的 19:15 – 19:30 之间到店',
        officialProducts: [
          {
            name: 'iPhone 18 Pro Max',
            quantity: 1,
            fulfillmentMessage: '请于 明天 的 19:15 – 19:30 之间到店',
          },
        ],
      }),
    };

    expect(serializeOrderListItem(order)).toMatchObject({
      pickup_time: '2026/09/19 19:15 – 19:30',
      official_pickup_date: '2026/09/19',
      official_pickup_time_slot: '19:15 – 19:30',
      official_products: [{ pickupTime: '2026/09/19 19:15 – 19:30' }],
    });
  });
  test('关联档案优先，空标签回退订单标签', () => {
    const order = {
      toJSON: () => ({
        ...snapshot,
        appleAccount: { id: 8, appleId: 'linked@example.test' },
        recipient: { id: 9, lastName: '张', firstName: '三', tag: '' },
      }),
    };
    expect(serializeOrderListItem(order)).toMatchObject({
      apple_id: 'linked@example.test',
      recipient_name: '张三',
      recipient_tag: snapshot.tag,
    });
  });
  test('姓名筛选和关键词包含邮件快照', () => {
    const byName = buildListFilters({ recipientName: '测试' }).where;
    expect(byName[Op.and][0][Op.or]).toContainEqual({ recipientName: { [Op.iLike]: '%测试%' } });
    const byKeyword = buildListFilters({ keyword: '测试' }).where;
    expect(byKeyword[Op.or]).toContainEqual({ appleId: { [Op.iLike]: '%测试%' } });
    expect(byKeyword[Op.or]).toContainEqual({ recipientName: { [Op.iLike]: '%测试%' } });
  });
});

describe('订单筛选候选项', () => {
  test('商品信息候选使用完整商品名称并去重', async () => {
    const { Order } = require('../src/models');
    Order.findAll = jest.fn().mockResolvedValue([
      {
        products: [
          { model: 'MODEL-18', name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色' },
          { model: 'MODEL-18', name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色' },
        ],
        pickupStore: 'Apple Store 零售店',
      },
    ]);
    const res = { json: jest.fn() };

    await getFilterOptions({}, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        productModels: ['MODEL-18'],
        productNames: ['iPhone 18 Pro Max 512GB 勃艮第酒红色'],
        stores: ['Apple Store 零售店'],
        recipients: [],
        payers: [],
      },
    });
  });
});

describe('下单时间筛选日边界', () => {
  test('日期首尾覆盖北京时间完整一天', () => {
    const { where } = buildListFilters({ date_from: '2026-09-09', date_to: '2026-09-09' });
    expect(where.orderDate[Op.gte].toISOString()).toBe('2026-09-08T16:00:00.000Z');
    expect(where.orderDate[Op.lte].toISOString()).toBe('2026-09-09T15:59:59.999Z');
  });
});

test('Excel 导出保留来源下单秒数并明确北京时间', async () => {
  try {
    const { Order } = require('../src/models');
    const { exportOrders } = require('../src/controllers/orderController');
    const XLSX = require('xlsx');
    Order.findAll = jest.fn().mockResolvedValue([
      {
        toJSON: () => ({
          orderNumber: 'W1234567890',
          orderDate: new Date('2026-09-09T05:24:25Z'),
        }),
      },
    ]);
    const res = { setHeader: jest.fn(), send: jest.fn() };
    await exportOrders({ query: {}, user: { id: 1 } }, res);
    const workbook = XLSX.read(res.send.mock.calls[0][0], { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['订单']);
    expect(rows[0]['下单时间（北京时间，来源记录）']).toBe('2026/09/09 13:24:25');
  } catch (error) {
    error.message = `导出回归失败：${error.message}`;
    throw error;
  }
});
