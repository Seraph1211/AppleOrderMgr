jest.mock('../src/models', () => ({ sequelize: {} }));
const batchId = 'a1111111-1111-4111-8111-111111111111';

test('筛选全选允许预约取货范围并保留组合条件', () => {
  const { validateSelection } = require('../src/services/officialOrderRefreshService');
  const filters = {
    pickupDateFrom: '2026-09-19',
    pickupDateTo: '2026-09-22',
    actualPickupDateFrom: '2026-09-23',
    dateFrom: '2026-09-01',
  };
  expect(
    validateSelection({
      requestKey: batchId,
      selection: 'filtered',
      filters,
    })
  ).toEqual({ selection: 'filtered', filters });
});
