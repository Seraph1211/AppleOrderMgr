jest.mock('../src/models', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/services/orderAccessService', () => ({ assertOrderIdsAccess: jest.fn() }));
jest.mock('../src/services/permissionService', () => ({ getEffectivePermissions: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn() }));

const { sequelize } = require('../src/models');
const { assertOrderIdsAccess } = require('../src/services/orderAccessService');
const { getBatch } = require('../src/services/officialOrderRefreshService');
const batchId = 'a1111111-1111-4111-8111-111111111111';

test('批次进度返回领取和完成时间及服务器时间，仍核验订单权限', async () => {
  const startedAt = new Date('2026-10-09T03:53:00Z');
  const finishedAt = new Date('2026-10-09T03:53:44Z');
  sequelize.query
    .mockResolvedValueOnce([{ id: batchId, requestedBy: 1 }])
    .mockResolvedValueOnce([{ id: 1 }])
    .mockResolvedValueOnce([{ id: 1 }])
    .mockResolvedValueOnce([{ state: 'succeeded', count: 1 }])
    .mockResolvedValueOnce([{ id: 'job', orderId: 1, state: 'succeeded', startedAt, finishedAt }])
    .mockResolvedValueOnce([{ count: 1 }]);
  const user = { id: 1, role: 'admin' };
  const before = Date.now();
  const result = await getBatch(user, batchId);
  expect(Date.parse(result.serverTime)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(result.serverTime)).toBeLessThanOrEqual(Date.now());
  expect(result.jobs[0]).toMatchObject({ startedAt, finishedAt });
  const jobSql = sequelize.query.mock.calls.find(([sql]) => sql.includes('result_status'))[0];
  expect(jobSql).toContain('started_at AS "startedAt"');
  expect(jobSql).toContain('finished_at AS "finishedAt"');
  expect(assertOrderIdsAccess).toHaveBeenCalledWith(user, [1], { transaction: undefined });
});

test('普通用户不能通过耗时接口读取队列', async () => {
  sequelize.query.mockClear();
  await expect(getBatch({ id: 1, role: 'operator' }, batchId)).rejects.toMatchObject({
    statusCode: 403,
  });
  expect(sequelize.query).not.toHaveBeenCalled();
});
