/* eslint-disable camelcase, no-magic-numbers -- API 字段与边界样本。 */
jest.mock('../src/models', () => ({
  sequelize: {
    fn: jest.fn((name, ...args) => ({ name, args })),
    col: jest.fn(column => ({ column })),
  },
  AppleId: { findAll: jest.fn(), findAndCountAll: jest.fn() },
}));
jest.mock('../src/utils/logger', () => ({ error: jest.fn() }));
const { AppleId } = require('../src/models');
const logger = require('../src/utils/logger');
const controller = require('../src/controllers/appleIdController');
const { ACCOUNT_STATUSES } = require('../src/constants/business');
const { Op } = require('sequelize');
const user = { permissions: ['apple_ids.read'] };
const response = () => ({ set: jest.fn(), json: jest.fn() });

beforeEach(() => jest.clearAllMocks());

describe('Apple ID 全局状态统计', () => {
  test('四种已知状态补0、未知状态保留、sum=total且忽略列表筛选与分页', async () => {
    AppleId.findAll.mockResolvedValue([
      { status: '未使用', count: '3' },
      { status: '异常', count: '2' },
      { status: '历史状态', count: '7' },
    ]);
    const res = response();
    await controller.getAppleIdStatistics(
      { user, query: { status: '使用中', page: '2', keyword: 'none' } },
      res
    );
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        total: 12,
        statuses: [
          ...ACCOUNT_STATUSES.map(status => ({
            status,
            count: { 未使用: 3, 异常: 2 }[status] || 0,
          })),
          { status: '历史状态', count: 7 },
        ],
      },
    });
    expect(AppleId.findAll).toHaveBeenCalledTimes(1);
    const options = AppleId.findAll.mock.calls[0][0];
    expect(options).toEqual({
      attributes: ['status', [{ name: 'COUNT', args: [{ column: 'id' }] }, 'count']],
      group: ['status'],
      order: [['status', 'ASC']],
      raw: true,
    });
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  test('空库总量0且四状态均为0', async () => {
    AppleId.findAll.mockResolvedValue([]);
    const res = response();
    await controller.getAppleIdStatistics({ user }, res);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        total: 0,
        statuses: ACCOUNT_STATUSES.map(status => ({ status, count: 0 })),
      },
    });
  });
});

describe('Apple ID 筛选全选', () => {
  test('与列表共用筛选且只查询ID，返回id倒序', async () => {
    const query = { keyword: '  sample  ', status: '使用中', country: '中国' };
    AppleId.findAll.mockResolvedValue([{ id: 9 }, { id: 2 }]);
    AppleId.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    const res = response();
    await controller.getAppleIdSelectionIds({ user, query }, res);
    await controller.listAppleIds(
      { user, query: { ...query, page: '2', limit: '50' } },
      response()
    );
    const selection = AppleId.findAll.mock.calls[0][0];
    const list = AppleId.findAndCountAll.mock.calls[0][0];
    expect(selection).toEqual({
      attributes: ['id'],
      where: { appleId: { [Op.iLike]: '%sample%' }, status: '使用中', country: '中国' },
      order: [['id', 'DESC']],
      limit: 5001,
      raw: true,
    });
    expect(selection.where).toEqual(list.where);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ids: [9, 2], total: 2 } });
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  test.each([0, 5000])('边界结果数 %i 完整返回', async count => {
    const ids = Array.from({ length: count }, (_, i) => count - i);
    AppleId.findAll.mockResolvedValue(ids.map(id => ({ id })));
    const res = response();
    await controller.getAppleIdSelectionIds({ user, query: {} }, res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ids, total: count } });
  });

  test('5001个目标明确拒绝，无截断或部分ID响应', async () => {
    AppleId.findAll.mockResolvedValue(Array.from({ length: 5001 }, (_, i) => ({ id: i + 1 })));
    const res = response();
    await expect(controller.getAppleIdSelectionIds({ user, query: {} }, res)).rejects.toMatchObject(
      {
        statusCode: 400,
        code: 'APPLE_ID_SELECTION_LIMIT_EXCEEDED',
      }
    );
    expect(res.json).not.toHaveBeenCalled();
  });

  test.each([
    { keyword: ['a', 'b'] },
    { keyword: {} },
    { keyword: 'x'.repeat(256) },
    { country: ['中国'] },
    { country: {} },
    { country: 'x'.repeat(51) },
    { status: ['未使用'] },
    { status: {} },
    { status: '历史状态' },
  ])('列表与筛选全选均拒绝非法过滤 %#', async query => {
    await expect(
      controller.getAppleIdSelectionIds({ user, query }, response())
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(controller.listAppleIds({ user, query }, response())).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(AppleId.findAll).not.toHaveBeenCalled();
    expect(AppleId.findAndCountAll).not.toHaveBeenCalled();
  });

  test.each([{ page: '2' }, { limit: '20' }, { unknown: 'x' }, { bound: 'true' }])(
    '筛选全选拒绝额外或已退役参数 %#',
    async query => {
      await expect(
        controller.getAppleIdSelectionIds({ user, query }, response())
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(AppleId.findAll).not.toHaveBeenCalled();
    }
  );

  test('空字符串过滤与空白keyword视为未筛选', async () => {
    AppleId.findAll.mockResolvedValue([]);
    await controller.getAppleIdSelectionIds(
      { user, query: { status: '', country: '', keyword: '  ' } },
      response()
    );
    expect(AppleId.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});

describe.each(['getAppleIdStatistics', 'getAppleIdSelectionIds'])('%s 权限和错误保护', name => {
  test.each([[[]], [['apple_ids.edit']]])(
    '缺少读取权限时拒绝 %#，且no-store',
    async permissions => {
      const res = response();
      await expect(
        controller[name]({ user: { permissions }, query: {} }, res)
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(AppleId.findAll).not.toHaveBeenCalled();
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    }
  );

  test('数据库异常不会把底层凭据或SQL写入日志、响应', async () => {
    AppleId.findAll.mockRejectedValue(new Error('synthetic-sensitive-database-value'));
    const res = response();
    let caught;
    try {
      await controller[name]({ user, query: {} }, res);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ statusCode: 500, code: 'DATABASE_ERROR' });
    expect(caught.message).not.toContain('synthetic-sensitive-database-value');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'synthetic-sensitive-database-value'
    );
    expect(res.json).not.toHaveBeenCalled();
  });
});
