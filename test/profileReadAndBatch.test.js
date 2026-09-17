/* eslint-disable camelcase -- 遵循现有 DTO */
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../src/models', () => ({
  sequelize: {
    query: jest.fn(),
    fn: jest.fn(),
    col: jest.fn(),
    where: jest.fn(),
    escape: jest.fn(value => `'${value}'`),
    literal: jest.fn(value => ({ literal: value })),
  },
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
const { Op } = require('sequelize');

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

  test('Apple ID 列表按账号或取机人姓名搜索，并返回当前绑定姓名', async () => {
    const appleRow = {
      id: 1,
      toJSON: () => ({ id: 1, appleId: 'synthetic@example.invalid', status: '使用中' }),
    };
    models.AppleId.findAndCountAll.mockResolvedValue({ count: 1, rows: [appleRow] });
    models.Recipient.findAll.mockResolvedValue([
      { id: 2, appleIdRef: 1, lastName: '欧阳', firstName: '明' },
    ]);
    const res = response();
    await appleController.listAppleIds(
      {
        query: { keyword: '欧阳明', bound: 'true' },
        user: { permissions: ['apple_ids.read'] },
      },
      res
    );

    const query = models.AppleId.findAndCountAll.mock.calls[0][0];
    expect(query.where[Op.or]).toHaveLength(2);
    expect(models.sequelize.literal).toHaveBeenCalledWith(expect.stringContaining('concat_ws'));
    expect(models.sequelize.literal).toHaveBeenCalledWith(expect.stringContaining('EXISTS'));
    expect(res.json.mock.calls[0][0].data.apple_ids[0]).toMatchObject({
      recipient_count: 1,
      recipient_names: ['欧阳明'],
    });
  });

  test.each([undefined, null, '', '   '])('空联系电话 %s 接受并清空', value => {
    expect(normalizeRecipientPhone(value)).toBeNull();
  });
  test('非空联系电话规范化并拒绝错误值', () => {
    expect(normalizeRecipientPhone(' 13800000000 ')).toBe('13800000000');
    for (const value of [13800000000, {}, [], '12', '138****0000'])
      expect(() => normalizeRecipientPhone(value)).toThrow();
  });

  test('取机人筛选项返回去重排序后的真实 TAG', async () => {
    models.Recipient.findAll.mockResolvedValue([
      { tag: '北京-负责人甲' },
      { tag: '上海-负责人乙' },
      { tag: '' },
    ]);
    const res = response();
    await recipientController.getFilterOptions({}, res);
    expect(models.Recipient.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ group: ['tag'], order: [['tag', 'ASC']], raw: true })
    );
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { tags: ['北京-负责人甲', '上海-负责人乙'] },
    });
  });

  test('取机人列表支持多个 TAG、Apple ID 与身份证后四位关键词', async () => {
    models.Recipient.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
    const res = response();
    await recipientController.listRecipients(
      {
        query: {
          tags: ['北京-负责人甲', '上海-负责人乙'],
          keyword: 'a@example.invalid',
        },
        user: { permissions: ['recipients.read'] },
      },
      res
    );
    let where = models.Recipient.findAndCountAll.mock.lastCall[0].where;
    expect(where.tag[Op.in]).toEqual(['北京-负责人甲', '上海-负责人乙']);
    expect(where[Op.or]).toEqual(
      expect.arrayContaining([{ appleId: { [Op.iLike]: '%a@example.invalid%' } }])
    );

    await recipientController.listRecipients(
      {
        query: { keyword: '000X' },
        user: { permissions: ['recipients.read'] },
      },
      response()
    );
    where = models.Recipient.findAndCountAll.mock.lastCall[0].where;
    expect(where[Op.or]).toEqual(expect.arrayContaining([{ idCardLast4: '000X' }]));

    await recipientController.listRecipients(
      {
        query: { tags: ['城市,负责人'] },
        user: { permissions: ['recipients.read'] },
      },
      response()
    );
    expect(models.Recipient.findAndCountAll.mock.lastCall[0].where.tag).toBe('城市,负责人');

    await expect(
      recipientController.listRecipients(
        {
          query: { tags: { invalid: true } },
          user: { permissions: ['recipients.read'] },
        },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      recipientController.listRecipients(
        {
          query: { keyword: ['姓名', '账号'] },
          user: { permissions: ['recipients.read'] },
        },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 400 });
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
