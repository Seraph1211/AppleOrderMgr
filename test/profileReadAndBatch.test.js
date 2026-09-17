/* eslint-disable camelcase -- 遵循现有 DTO */
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../src/models', () => ({
  sequelize: { query: jest.fn(), fn: jest.fn(), col: jest.fn() },
  AppleId: { findAndCountAll: jest.fn(), findByPk: jest.fn() },
  Recipient: { findAndCountAll: jest.fn(), findByPk: jest.fn(), findAll: jest.fn() },
  Order: { findAll: jest.fn() },
  User: {},
}));
jest.mock('../src/services/crawler/refreshJobService', () => ({ enqueueMany: jest.fn() }));
const models = require('../src/models');
const appleController = require('../src/controllers/appleIdController');
const recipientController = require('../src/controllers/recipientController');
const orderController = require('../src/controllers/orderController');
const jobs = require('../src/services/crawler/refreshJobService');
const { normalizeRecipientPhone } = require('../src/utils/recipientPhone');
const { requirePermission } = require('../src/middleware/authMiddleware');

function response() {
  return { json: jest.fn(), set: jest.fn(), status: jest.fn().mockReturnThis() };
}

describe('基础资料读取权限与选填联系电话', () => {
  const oldEnv = process.env.NODE_ENV;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
    models.sequelize.query.mockResolvedValue([[]]);
    models.Recipient.findAll.mockResolvedValue([]);
    models.Order.findAll.mockResolvedValue([]);
  });
  afterAll(() => {
    process.env.NODE_ENV = oldEnv;
  });

  test.each(['admin', 'operator', 'readOnly'])(
    '%s 有对应读取权限可读密码、身份证和电话，无地址或密保扩权',
    async role => {
      const apple = {
        id: 1,
        appleId: 'synthetic@example.invalid',
        password: 'synthetic-password',
        securityQa: { question: 'hidden' },
      };
      const recipient = {
        id: 2,
        lastName: '测',
        firstName: '试',
        idCardNumber: '110101199001011234',
        phone: '13800000000',
        streetAddress: '合成地址',
        password: 'hidden',
      };
      const appleRow = { id: 1, toJSON: () => ({ ...apple }) };
      const recipientRow = { id: 2, toJSON: () => ({ ...recipient }) };
      models.AppleId.findAndCountAll.mockResolvedValue({ count: 1, rows: [appleRow] });
      models.AppleId.findByPk.mockResolvedValue(appleRow);
      models.Recipient.findAndCountAll.mockResolvedValue({ count: 1, rows: [recipientRow] });
      models.Recipient.findByPk.mockResolvedValue(recipientRow);
      const req = {
        query: {},
        params: { id: '1' },
        user: { id: 1, role, permissions: ['apple_ids.read', 'recipients.read'] },
      };
      for (const [method, key, expected] of [
        [appleController.listAppleIds, 'apple_ids', { password: apple.password }],
        [appleController.getAppleIdDetail, null, { password: apple.password }],
        [
          recipientController.listRecipients,
          'recipients',
          { id_card_number: recipient.idCardNumber, phone: recipient.phone, street_address: null },
        ],
        [
          recipientController.getRecipientDetail,
          null,
          { id_card_number: recipient.idCardNumber, phone: recipient.phone, street_address: null },
        ],
      ]) {
        const res = response();
        await method(req, res);
        const data = res.json.mock.calls[0][0].data;
        const item = key ? data[key][0] : data;
        expect(item).toMatchObject(expected);
        expect(item).not.toHaveProperty('securityQa');
        if (expected.phone) expect(item.password).toBe('hidden');
        expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
      }
    }
  );

  test.each(['apple_ids.read', 'recipients.read', 'orders.refresh'])(
    '无 %s 权限被后端拒绝',
    permission => {
      const next = jest.fn();
      const res = response();
      requirePermission(permission)({ user: { role: 'operator', permissions: [] } }, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  );

  test.each([undefined, null, '', '   '])('空联系电话 %s 接受并清空', value => {
    expect(normalizeRecipientPhone(value)).toBeNull();
  });
  test('非空联系电话规范化并拒绝错误值', () => {
    expect(normalizeRecipientPhone(' 13800000000 ')).toBe('13800000000');
    for (const value of [13800000000, {}, [], '12', '138****0000'])
      expect(() => normalizeRecipientPhone(value)).toThrow();
  });
});

describe('订单勾选批量刷新', () => {
  beforeEach(() => jest.clearAllMocks());
  test('去重且缺失订单保留逐项结果，不扩大到其他订单', async () => {
    models.Order.findAll.mockResolvedValue([{ id: 1 }]);
    jobs.enqueueMany.mockResolvedValue({
      total: 2,
      created: 1,
      merged: 0,
      missing: 1,
      results: [
        { orderId: 1, jobId: 7, created: true },
        { orderId: 9, jobId: null, reason: 'order_not_found' },
      ],
    });
    const res = response();
    await orderController.batchRefresh({ body: { orderIds: [1, '1', 9] }, user: { id: 2 } }, res);
    expect(jobs.enqueueMany).toHaveBeenCalledWith([1, 9], {
      trigger: 'manual_single',
      requestedBy: 2,
    });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json.mock.calls[0][0].data.missing).toBe(1);
  });
  test.each(
    [[], [0], ['1oops'], [1.2], [true], [null], Array(101).fill(1), 0, null].map(orderIds => [
      orderIds,
    ])
  )('非法 ID 拒绝入队 %#', async orderIds => {
    await expect(
      orderController.batchRefresh({ body: { orderIds }, user: { id: 2 } }, response())
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(jobs.enqueueMany).not.toHaveBeenCalled();
  });
});
