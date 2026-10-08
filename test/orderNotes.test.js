const { Op } = require('sequelize');

jest.mock('../src/models', () => ({
  Order: { findOne: jest.fn() },
  AppleId: {},
  Recipient: {},
  EmailLog: {},
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const { Order } = require('../src/models');
const { updateOrder } = require('../src/controllers/orderController');

let order;
let req;
let res;
beforeEach(() => {
  jest.clearAllMocks();
  order = {
    id: 1,
    orderNumber: 'W1234567890',
    notes: '原备注',
    paymentScreenshot: ['existing.png'],
    update: jest.fn(updates => Promise.resolve(Object.assign(order, updates))),
  };
  Order.findOne.mockResolvedValue(order);
  req = { params: { id: '1' }, user: { role: 'admin' }, body: {} };
  res = { json: jest.fn() };
});

test.each([' 新备注\n第二行 ', '-', '字'.repeat(2000)])(
  '独立更新备注并返回保存内容',
  async notes => {
    req.body = { notes, payerName: '不得更新', status: 'cancelled' };
    await updateOrder(req, res);
    expect(order.update).toHaveBeenCalledWith({ notes: notes.trim() });
    expect(order.paymentScreenshot).toEqual(['existing.png']);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ notes: notes.trim() }),
      })
    );
  }
);

test.each(['', ' \n ', null])('允许清空备注 %p', async notes => {
  req.body = { notes };
  await updateOrder(req, res);
  expect(order.update).toHaveBeenCalledWith({ notes: null });
});

test.each([123, false, [], {}, '字'.repeat(2001)])('拒绝非法备注且不更新截图 %p', async notes => {
  req.body = { notes, paymentScreenshot: [] };
  await expect(updateOrder(req, res)).rejects.toThrow(/备注/);
  expect(order.update).not.toHaveBeenCalled();
});

test('省略备注时保留原值并兼容截图更新', async () => {
  req.body = { paymentScreenshot: [] };
  await updateOrder(req, res);
  expect(order.update).toHaveBeenCalledWith({ paymentScreenshot: [] });
  expect(order.notes).toBe('原备注');
});

test('空请求不产生更新', async () => {
  await expect(updateOrder(req, res)).rejects.toThrow('没有可更新的字段');
  expect(order.update).not.toHaveBeenCalled();
});

test('按当前用户 TAG 范围查找并拒绝范围外订单', async () => {
  req.user = { role: 'operator', orderAccess: { mode: 'tags', tags: ['授权渠道'] } };
  req.body = { notes: '新备注' };
  Order.findOne.mockResolvedValue(null);
  await expect(updateOrder(req, res)).rejects.toThrow('订单不存在');
  expect(Order.findOne).toHaveBeenCalledWith({
    where: { [Op.and]: [{ id: 1 }, { tag: { [Op.in]: ['授权渠道'] } }] },
  });
  expect(order.update).not.toHaveBeenCalled();
});

test('保存异常返回失败而非成功', async () => {
  req.body = { notes: '新备注' };
  order.update.mockRejectedValue(new Error('synthetic database failure'));
  await expect(updateOrder(req, res)).rejects.toThrow('更新订单失败');
  expect(res.json).not.toHaveBeenCalled();
});
