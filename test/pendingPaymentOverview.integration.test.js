const runIntegration = process.env.RUN_PAYMENT_INTEGRATION === 'true';
(runIntegration ? describe : describe.skip)('全局待付款概览隔离库验收', () => {
  let models;
  let service;
  beforeAll(async () => {
    if (!/^apple_order_mgr_.+_test_\d+$/.test(process.env.DB_NAME || '')) {
      throw new Error('只允许隔离测试库');
    }
    models = require('../src/models');
    service = require('../src/services/paymentDispatchService');
    await models.sequelize.authenticate();
  });
  afterAll(async () => {
    if (models) await models.sequelize.close();
  });
  test('全局统计含无任务、零单账号和人工已完成，排除已付退款过期', async () => {
    const users = await models.User.bulkCreate(
      [1, 2, 3].map(index => ({
        username: `overview_${index}`,
        nickname: '同名付款员',
        password: 'synthetic-password',
        role: 'operator',
        status: index === 2 ? 'locked' : 'active',
      }))
    );
    const states = [
      ['payment_due', 'unpaid'],
      ['payment_due', 'unpaid'],
      ['payment_due', 'unpaid'],
      ['payment_due', null],
      ['payment_due', 'paid'],
      ['payment_due', 'refunded'],
      ['payment_expired', 'unpaid'],
      ['payment_received', 'paid'],
      ['pending', null],
    ];
    const orders = await models.Order.bulkCreate(
      states.map(([status, paymentStatus], index) => ({
        orderNumber: `W98000000${String(index).padStart(2, '0')}`,
        status,
        paymentStatus,
        products: [],
      }))
    );
    await models.PaymentTask.bulkCreate([
      { orderId: orders[1].id, processingStatus: 'pending' },
      { orderId: orders[2].id, assigneeUserId: users[0].id, processingStatus: 'completed' },
      { orderId: orders[3].id, assigneeUserId: users[1].id, processingStatus: 'exception' },
      ...orders.slice(4).map(order => ({
        orderId: order.id,
        assigneeUserId: users[0].id,
        processingStatus: 'pending',
      })),
    ]);
    const result = await service.getPendingOverview();
    expect(result).toMatchObject({ total: 4, unassignedCount: 2, assignedCount: 2 });
    expect(result.staff.map(person => person.count)).toEqual([1, 1, 0]);
    expect(result.staff[0].userId).not.toBe(result.staff[1].userId);
    await models.Order.bulkCreate(
      Array.from({ length: 205 }, (_, index) => ({
        orderNumber: `W9700000${String(index).padStart(3, '0')}`,
        status: 'payment_due',
        paymentStatus: 'unpaid',
        products: [],
      }))
    );
    expect(await service.getPendingOverview()).toMatchObject({
      total: 209,
      unassignedCount: 207,
      assignedCount: 2,
    });
    await models.Order.update({ paymentStatus: 'paid' }, { where: { status: 'payment_due' } });
    expect(await service.getPendingOverview()).toMatchObject({
      total: 0,
      assignedCount: 0,
      unassignedCount: 0,
    });
  });
});
