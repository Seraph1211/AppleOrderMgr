jest.mock('../src/models', () => ({ Order: { count: jest.fn() } }));
jest.mock('../src/utils/logger', () => ({ warn: jest.fn() }));
const { Op } = require('sequelize');
const {
  validateOrderAccess,
  getOrderAccess,
  scopeOrderWhere,
  assertTagAccess,
  assertOrderIdsAccess,
} = require('../src/services/orderAccessService');

describe('订单 TAG 授权边界', () => {
  test.each([
    null,
    {},
    { mode: 'any', tags: [] },
    { mode: 'tags', tags: 'A' },
    { mode: 'tags', tags: [''] },
    { mode: 'tags', tags: [' '] },
    { mode: 'tags', tags: [1] },
    { mode: 'tags', tags: ['x'.repeat(501)] },
    { mode: 'tags', tags: Array(501).fill('A') },
  ])('非法范围拒绝 %#', value => expect(() => validateOrderAccess(value)).toThrow());
  test('TAG 去重不改写大小写或空白，all 清空 TAG', () => {
    expect(validateOrderAccess({ mode: 'tags', tags: ['a', 'A', 'a', ' A '] }).tags).toEqual([
      ' A ',
      'A',
      'a',
    ]);
    expect(validateOrderAccess({ mode: 'all', tags: ['A'] })).toEqual({ mode: 'all', tags: [] });
  });
  test('缺失账号或配置不能回退全权；管理员始终全范围', () => {
    expect(getOrderAccess()).toEqual({ mode: 'tags', tags: [] });
    expect(getOrderAccess({ role: 'operator' })).toEqual({ mode: 'tags', tags: [] });
    expect(getOrderAccess({ role: 'admin', orderAccess: { mode: 'tags', tags: [] } })).toEqual({
      mode: 'all',
      tags: [],
    });
  });
  test('请求 tag 和 OR 筛选与授权相交，不能覆盖授权', () => {
    const user = { orderAccess: { mode: 'tags', tags: ['A'] } };
    const filter = { tag: 'B', [Op.or]: [{ status: 'pending' }, { status: 'paid' }] };
    const where = scopeOrderWhere(user, filter);
    expect(where[Op.and]).toEqual([filter, { tag: { [Op.in]: ['A'] } }]);
    expect(() => assertTagAccess(user, 'B')).toThrow();
    expect(() => assertTagAccess(user, 'A')).not.toThrow();
  });
});

test('ID 范围查询去重，缺失或越权整体拒绝，数据库异常不放行', async () => {
  const { Order } = require('../src/models');
  const user = { orderAccess: { mode: 'tags', tags: ['A'] } };
  Order.count.mockResolvedValueOnce(1);
  await expect(assertOrderIdsAccess(user, [1, 1])).resolves.toBeUndefined();
  expect(Order.count.mock.calls[0][0].where[Op.and][0].id[Op.in]).toEqual([1]);
  Order.count.mockResolvedValueOnce(0);
  await expect(assertOrderIdsAccess(user, [1])).rejects.toMatchObject({ statusCode: 404 });
  Order.count.mockRejectedValueOnce(new Error('synthetic unavailable'));
  await expect(assertOrderIdsAccess(user, [1])).rejects.toThrow('synthetic unavailable');
});
