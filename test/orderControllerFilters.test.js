/* eslint-disable camelcase */
const { Op } = require('sequelize');

jest.mock('../src/models', () => ({
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
  serializeOrderListItem,
  serializeOrderDetail,
} = require('../src/controllers/orderController');

describe('订单列表付款状态筛选', () => {
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
});

describe('邮件快照展示回归', () => {
  const snapshot = {
    id: 1,
    appleId: 'account@example.test',
    recipientName: '测试取机人',
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
    Order.findAll = jest
      .fn()
      .mockResolvedValue([
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
