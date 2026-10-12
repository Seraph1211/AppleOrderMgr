jest.mock('../src/models', () => ({ Recipient: { findAll: jest.fn() } }));
jest.mock('../src/utils/logger', () => ({ warn: jest.fn() }));
const { Op } = require('sequelize');
const { Recipient } = require('../src/models');
const {
  loadRecipientCandidates,
  findRecipientForOrder,
} = require('../src/services/profileOrderMatching');

beforeEach(() => jest.clearAllMocks());

test('应按证件尾号批量加载全部候选，完整证件转换尾号并去重', async () => {
  const transaction = {};
  Recipient.findAll.mockResolvedValue([]);
  await loadRecipientCandidates(
    [
      { recipientIdLast4: '001x' },
      { recipientIdCard: '11010119900101001X' },
      { recipientIdLast4: '0001' },
      { recipientPhone: '13800000000', ingestionSource: 'aos' },
    ],
    transaction
  );
  expect(Recipient.findAll).toHaveBeenCalledWith({
    where: { idCardLast4: { [Op.in]: ['001X', '0001'] } },
    transaction,
  });
});

test('缺失、非法或互相冲突的证件证据不查询档案', async () => {
  expect(
    await loadRecipientCandidates([
      { recipientName: '测试', recipientPhone: '13800000000', ingestionSource: 'aos' },
      { recipientIdLast4: 'bad!' },
      { recipientIdLast4: '0001', recipientIdCard: '110101199001010002' },
    ])
  ).toEqual([]);
  expect(Recipient.findAll).not.toHaveBeenCalled();
});

test('新订单应忽略联系方式差异并关联唯一姓名尾号候选', async () => {
  const person = {
    id: 1,
    lastName: '测',
    firstName: '试',
    idCardLast4: '0001',
    phone: '13800000000',
  };
  Recipient.findAll.mockResolvedValue([person]);
  expect(
    await findRecipientForOrder({
      recipientName: '测试',
      recipientIdLast4: '0001',
      recipientPhone: '13900000001',
      ingestionSource: 'aos',
    })
  ).toBe(person);
});

test('应保留所有同尾号候选并拒绝同名歧义，即使完整证件可命中一个', async () => {
  Recipient.findAll.mockResolvedValue([
    { id: 1, lastName: '测', firstName: '试', idCardLast4: '0001' },
    { id: 2, lastName: '测', firstName: '试', idCardLast4: '0001' },
  ]);
  expect(
    await findRecipientForOrder({ recipientName: '测试', recipientIdCard: '110101199001010001' })
  ).toBeNull();
});

test('数据库读取失败应传播，不伪装为未匹配', async () => {
  const error = new Error('synthetic');
  Recipient.findAll.mockRejectedValue(error);
  await expect(
    findRecipientForOrder({ recipientName: '测试', recipientIdLast4: '0001' })
  ).rejects.toBe(error);
});
