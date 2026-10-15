/* eslint-disable camelcase */
jest.mock('../src/models', () => ({
  sequelize: {
    transaction: jest.fn(),
    fn: jest.fn((name, ...args) => ({ name, args })),
    col: jest.fn(name => ({ column: name })),
  },
  AppleId: { findAll: jest.fn(), update: jest.fn(), findAndCountAll: jest.fn() },
  Order: { findAll: jest.fn() },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../src/services/profileBindingService', () => ({ lockProfiles: jest.fn() }));
const { sequelize, AppleId, Order } = require('../src/models');
const controller = require('../src/controllers/appleIdController');
const { lockProfiles } = require('../src/services/profileBindingService');
const logger = require('../src/utils/logger');
const response = () => ({ json: jest.fn(), set: jest.fn() });
const user = { id: 5, permissions: ['apple_ids.edit', 'apple_ids.read'] };

describe('Apple ID 批量管理', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sequelize.transaction.mockImplementation(callback => callback({ LOCK: { UPDATE: 'UPDATE' } }));
    AppleId.findAll.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    AppleId.update.mockResolvedValue([2]);
  });

  test.each(['accountNumber', 'account_number'])('CRUD 拒绝只读字段 %s', async field => {
    const req = { params: { id: '1' }, body: { [field]: 9 }, user };
    await expect(controller.createAppleId(req, response())).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(controller.updateAppleId(req, response())).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('最后下单时间优先 order_date 并回退 created_at，订单统计仍受访问范围约束', async () => {
    AppleId.findAndCountAll.mockResolvedValue({
      count: 1,
      rows: [{ id: 1, toJSON: () => ({ id: 1, accountNumber: 8 }) }],
    });
    Order.findAll.mockResolvedValue([{ appleIdRef: 1, count: '2', lastOrderDate: '2026-10-01' }]);
    const res = response();
    await controller.listAppleIds(
      {
        query: {},
        user: { ...user, role: 'admin', permissions: [...user.permissions, 'orders.read'] },
      },
      res
    );
    expect(sequelize.fn).toHaveBeenCalledWith(
      'COALESCE',
      { column: 'order_date' },
      { column: 'created_at' }
    );
    expect(sequelize.fn).toHaveBeenCalledWith('MAX', expect.objectContaining({ name: 'COALESCE' }));
    expect(Order.findAll).toHaveBeenCalledWith(expect.objectContaining({ group: ['appleIdRef'] }));
    expect(JSON.stringify(res.json.mock.calls)).toContain('2026-10-01');
    expect(JSON.stringify(res.json.mock.calls)).toContain('account_number');
  });

  test.each([
    {},
    null,
    [],
    { ids: [] },
    { ids: [1, 1], status: '未使用' },
    { ids: ['1'], status: '未使用' },
    { ids: [1.5], notes: null },
    { ids: [0], notes: null },
    { ids: [2147483648], notes: null },
    { ids: Array.from({ length: 5001 }, (_, i) => i + 1), notes: null },
    { ids: [1] },
    { ids: [1], status: null },
    { ids: [1], status: 'active' },
    { ids: [1], notes: 2 },
    { ids: [1], notes: 'a'.repeat(10001) },
    { ids: [1], status: '未使用', password: 'injected' },
    { ids: [1], notes: null, account_number: 7 },
  ])('非法批量参数整体拒绝 %#', async body => {
    await expect(controller.batchUpdateAppleIds({ body, user }, response())).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(AppleId.update).not.toHaveBeenCalled();
  });

  test('权限独立验证，不能用读取权限批量编辑', async () => {
    await expect(
      controller.batchUpdateAppleIds(
        {
          body: { ids: [1], notes: null },
          user: { permissions: ['apple_ids.read'] },
        },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test.each(['未使用', '使用中', '已下架', '异常'])(
    '状态 %s 只更新状态且锁定目标',
    async status => {
      const res = response();
      await controller.batchUpdateAppleIds({ body: { ids: [2, 1], status }, user }, res);
      expect(lockProfiles).toHaveBeenCalled();
      expect(AppleId.findAll).toHaveBeenCalledWith(expect.objectContaining({ lock: 'UPDATE' }));
      expect(AppleId.update).toHaveBeenCalledWith(
        { status },
        expect.objectContaining({ fields: ['status'] })
      );
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { updated: 2 } });
    }
  );

  test.each([null, '', '新备注'])('显式备注 %s 保留原始清空语义', async notes => {
    await controller.batchUpdateAppleIds({ body: { ids: [1, 2], notes }, user }, response());
    expect(AppleId.update).toHaveBeenCalledWith({ notes }, expect.any(Object));
  });

  test('任何目标缺失均不调用更新', async () => {
    AppleId.findAll.mockResolvedValue([{ id: 1 }]);
    await expect(
      controller.batchUpdateAppleIds(
        {
          body: { ids: [1, 2], notes: null },
          user,
        },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(AppleId.update).not.toHaveBeenCalled();
  });

  test('复制精确格式、按编号查询、不返回额外字段、no-store', async () => {
    AppleId.findAll.mockResolvedValue([
      { id: 1, accountNumber: 3, appleId: 'a@example.invalid', password: 'passA' },
      { id: 2, accountNumber: 9, appleId: 'b@example.invalid', password: 'passB' },
    ]);
    const res = response();
    await controller.copyImportAppleIds({ body: { ids: [2, 1] }, user }, res);
    expect(AppleId.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ order: [['accountNumber', 'ASC']] })
    );
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        count: 2,
        text: 'a@example.invalid,passA,\nb@example.invalid,passB,',
      },
    });
  });

  test.each(['comma,password', 'line\npassword', 'line\rpassword'])(
    '歧义密码整体拒绝且不泄密 %#',
    async password => {
      AppleId.findAll.mockResolvedValue([{ id: 1, appleId: 'a@example.invalid', password }]);
      const res = response();
      let caught;
      try {
        await controller.copyImportAppleIds({ body: { ids: [1] }, user }, res);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ statusCode: 400 });
      expect(JSON.stringify(caught)).not.toContain(password);
      expect(res.json).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    }
  );

  test('copy 拒绝额外字段、缺失目标和未授权读取', async () => {
    await expect(
      controller.copyImportAppleIds({ body: { ids: [1], notes: '' }, user }, response())
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      controller.copyImportAppleIds(
        { body: { ids: [1] }, user: { permissions: ['apple_ids.edit'] } },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    AppleId.findAll.mockResolvedValue([]);
    await expect(
      controller.copyImportAppleIds({ body: { ids: [1] }, user }, response())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('底层数据库错误不回传或记录可能包含凭据的 message', async () => {
    AppleId.findAll.mockRejectedValue(new Error('credential-secret'));
    await expect(
      controller.copyImportAppleIds({ body: { ids: [1] }, user }, response())
    ).rejects.toMatchObject({ message: '生成 Apple ID 导入文本失败' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('credential-secret');
    await expect(
      controller.batchUpdateAppleIds({ body: { ids: [1], notes: null }, user }, response())
    ).rejects.toMatchObject({ message: '批量更新 Apple ID 失败' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('credential-secret');
  });
});
