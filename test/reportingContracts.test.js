/* eslint-disable camelcase */

const mockOrderCount = jest.fn();
const mockOrderSum = jest.fn();
const mockOrderFindAll = jest.fn();
const mockOrderFindAndCountAll = jest.fn();
const mockSequelizeQuery = jest.fn();
const mockRecipientCount = jest.fn();
const AVAILABLE_RECIPIENT_COUNT = 16; // eslint-disable-line no-magic-numbers

jest.mock('../src/models', () => ({
  Order: {
    count: mockOrderCount,
    sum: mockOrderSum,
    findAll: mockOrderFindAll,
    findAndCountAll: mockOrderFindAndCountAll,
  },
  AppleId: {},
  Recipient: { count: mockRecipientCount },
  sequelize: {
    query: mockSequelizeQuery,
    QueryTypes: { SELECT: 'SELECT' },
    transaction: jest.fn(),
  },
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const dashboardService = require('../src/services/dashboardService');
const channelController = require('../src/controllers/channelController');
const statsController = require('../src/controllers/statsController');

describe('统计口径契约', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('仪表板金额必须汇总官网订单金额字段', async () => {
    mockOrderCount.mockResolvedValue(4);
    mockRecipientCount.mockResolvedValue(AVAILABLE_RECIPIENT_COUNT);
    mockOrderSum.mockResolvedValueOnce('600.50').mockResolvedValueOnce('300.25');

    const result = await dashboardService.getStats({
      startDate: '2026-09-01',
      endDate: '2026-09-05',
    });

    expect(mockOrderSum).toHaveBeenCalledWith(
      'officialOrderAmount',
      expect.objectContaining({ where: expect.any(Object) })
    );
    expect(result.totalAmount).toBe(600.5);
    expect(result.amountGrowth).toBeCloseTo(100);
    expect(result.availableRecipients).toBe(AVAILABLE_RECIPIENT_COUNT);
    expect(result).not.toHaveProperty('activeRecipients');
    const recipientStatus = mockRecipientCount.mock.calls[0][0].where.status;
    expect(recipientStatus[require('sequelize').Op.in]).toEqual(['使用中', '未使用']);
  });

  test('渠道金额必须使用查询返回值而不是固定客单价', async () => {
    mockOrderFindAll.mockResolvedValue([
      {
        tag: '渠道A',
        totalOrders: '2',
        paidOrders: '1',
        deliveredOrders: '1',
        totalAmount: '12999.00',
        paidAmount: '6999.00',
        deliveredAmount: '6999.00',
        missingAmountOrders: '0',
      },
    ]);
    const res = { json: jest.fn() };
    const next = jest.fn();

    await channelController.getChannels({}, res, next);

    const channel = res.json.mock.calls[0][0].data.channels[0];
    expect(channel.totalAmount).toBe(12999);
    expect(channel.totalAmount).not.toBe(16000);
    expect(channel.amountSource).toBe('official_order_amount');
    expect(next).not.toHaveBeenCalled();
  });

  test('渠道订单列表不得返回完整手机号和 Apple 订单链接', async () => {
    mockOrderFindAndCountAll.mockResolvedValue({
      count: 1,
      rows: [
        {
          toJSON: () => ({
            id: 1,
            orderNumber: 'W1234567890',
            appleAccount: { appleId: 'buyer@example.com' },
            recipient: { lastName: '张', firstName: '三', phone: '13812345678' },
            products: [],
            status: 'processing',
            orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/buyer@example.com',
          }),
        },
      ],
    });
    const req = { params: { tag: '渠道A' }, query: {} };
    const res = { json: jest.fn() };
    const next = jest.fn();

    await channelController.getChannelOrders(req, res, next);

    const order = res.json.mock.calls[0][0].data.items[0];
    expect(order.recipientPhone).toBe('138****5678');
    expect(order.orderUrl).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  test('产品统计 SQL 应按 orders 主键去重', async () => {
    mockSequelizeQuery
      .mockResolvedValueOnce([{ name: 'iPhone', total_quantity: '2', order_count: '1' }])
      .mockResolvedValueOnce([]);
    const res = { json: jest.fn() };

    await statsController.getProductStats({ query: {} }, res);

    expect(mockSequelizeQuery.mock.calls[0][0]).toContain('COUNT(DISTINCT o.id)');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          top_products: [{ name: 'iPhone', total_quantity: 2, order_count: 1 }],
        }),
      })
    );
  });
});
