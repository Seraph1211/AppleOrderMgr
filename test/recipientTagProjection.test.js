jest.mock('../src/models', () => ({
  Order: { findAndCountAll: jest.fn(), findAll: jest.fn() },
  Recipient: {},
  PickupRecord: {},
  PickupEvidence: {},
  User: {},
  sequelize: {},
}));
jest.mock('../src/services/ossService', () => ({}));
jest.mock('../src/utils/logger', () => ({ error: jest.fn() }));
const { Op } = require('sequelize');
const { Order } = require('../src/models');
const pickup = require('../src/controllers/pickupController');
const stats = require('../src/controllers/statsController');

test.each([
  [null, null, 'unlinked'],
  [{ tag: ' \u00a0 ' }, null, 'missing'],
  [{ tag: ' A ' }, ' A ', 'present'],
])('取货照片列表使用档案 TAG %j，保留筛选交集', async (recipient, tag, state) => {
  const res = { json: jest.fn() };
  Order.findAndCountAll.mockResolvedValue({
    count: 1,
    rows: [
      {
        toJSON: () => ({
          id: 1,
          tag: 'SOURCE',
          sourceRecipientTag: 'AOS',
          recipient,
          products: [],
        }),
      },
    ],
  });
  await pickup.list(
    { user: { role: 'admin' }, query: { tags: '[" A "]', status: 'pending' } },
    res
  );
  expect(res.json.mock.calls[0][0].data.items[0]).toMatchObject({ tag, recipientTagState: state });
  const options = Order.findAndCountAll.mock.calls.at(-1)[0];
  expect(options.include[0].attributes).toContain('tag');
  expect(options.where[Op.and]).toHaveLength(2);
  expect(options.where[Op.and][0].logic[Op.in]).toEqual([' A ']);
});

test('取机人统计将空白 TAG 归一为缺失', async () => {
  Order.findAll.mockResolvedValue([
    { recipientRef: 1, recipient: { tag: '\ufeff' }, orderCount: '1' },
  ]);
  const res = { json: jest.fn() };
  await stats.getRecipientStats({ user: { role: 'admin' } }, res);
  expect(res.json.mock.calls[0][0].data[0].tag).toBeNull();
});
