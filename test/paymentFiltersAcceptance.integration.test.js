/* eslint-disable no-magic-numbers -- 独立筛选数据库固定合成场景与分页边界。 */
const enabled = process.env.RUN_PAYMENT_FILTER_ACCEPTANCE === 'true';
const suite = enabled ? describe : describe.skip;

suite('付款官网筛选独立真实数据库验收', () => {
  let db;
  let own;
  let dispatch;
  let staff;
  let other;
  let orders;
  const query = values => ({ officialOrderStatuses: JSON.stringify(values), limit: 100 });
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_payment_test_2026101102' ||
      process.env.DB_NAME_TEST !== 'apple_order_mgr_payment_test_2026101102' ||
      process.env.DATABASE_URL
    )
      throw new Error('只允许本轮合成筛选测试库');
    db = require('../src/models');
    own = require('../src/services/paymentTaskService');
    dispatch = require('../src/services/paymentDispatchService');
    await db.sequelize.query('TRUNCATE orders,users RESTART IDENTITY CASCADE');
    [staff, other] = await Promise.all(
      ['self', 'other'].map(name =>
        db.User.create({
          username: `filter_${name}`,
          password: 'Synthetic-filter-1!',
          role: 'operator',
          status: 'active',
        })
      )
    );
    const states = ['PROCESSING | PAYMENT_PENDING', 'READY_FOR_PICKUP', 'MYSTERY_STATE', null];
    orders = await db.Order.bulkCreate(
      Array.from({ length: 25 }, (_, index) => ({
        orderNumber: `W${String(7700000000 + index)}`,
        products: [{ name: 'iPhone 18 Pro Max 512GB 银色', model: 'MG123CH/A', quantity: 1 }],
        officialRawStatus: index === 24 ? 'OTHER_PRIVATE_STATE' : states[index % 4],
        emailOrderStatus: 'confirmed',
        emailPaymentStatus: 'unknown',
        orderDate: new Date('2026-10-10T06:00:00Z'),
        tag: '独立筛选',
      }))
    );
    await db.PaymentTask.bulkCreate(
      orders.map((order, index) => ({
        orderId: order.id,
        assigneeUserId: index === 24 ? other.id : staff.id,
        processingStatus: 'pending',
      }))
    );
  });
  afterAll(async () => {
    if (db) await db.sequelize.close();
  });
  test.each(['PROCESSING', 'PAYMENT_PENDING'])('应该复合状态逐项匹配 %s', async status => {
    const result = await own.listOwnTasks(staff.id, query([status]));
    expect(result.pagination.total).toBe(6);
    expect(
      result.items.every(item => item.officialRawStatus === 'PROCESSING | PAYMENT_PENDING')
    ).toBe(true);
  });
  test('应该多状态OR、重复值去重而不重复订单', async () => {
    const result = await own.listOwnTasks(
      staff.id,
      query(['PAYMENT_PENDING', 'READY_FOR_PICKUP', 'PAYMENT_PENDING'])
    );
    expect(result.pagination.total).toBe(12);
    expect(new Set(result.items.map(item => item.id)).size).toBe(12);
  });
  test('应该未知与尚未更新分别筛选，空选择返回全部本人记录', async () => {
    expect((await own.listOwnTasks(staff.id, query(['MYSTERY_STATE']))).pagination.total).toBe(6);
    expect((await own.listOwnTasks(staff.id, query(['__not_observed__']))).pagination.total).toBe(
      6
    );
    expect((await own.listOwnTasks(staff.id, query([]))).pagination.total).toBe(24);
    expect((await own.listOwnTasks(staff.id, { limit: 100 })).pagination.total).toBe(24);
  });
  test('应该候选忽略本次已选状态、不受当前分页影响且不泄露他人候选', async () => {
    const result = await own.listOwnTasks(staff.id, { ...query(['READY_FOR_PICKUP']), limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.officialOrderStatuses.sort()).toEqual(
      [
        'MYSTERY_STATE',
        'PAYMENT_PENDING',
        'PROCESSING',
        'READY_FOR_PICKUP',
        '__not_observed__',
      ].sort()
    );
    expect(result.officialOrderStatuses).not.toContain('OTHER_PRIVATE_STATE');
    expect((await own.listOwnTasks(other.id, query([]))).officialOrderStatuses).toEqual([
      'OTHER_PRIVATE_STATE',
    ]);
  });
  test('应该在数据库分页前筛选并保持两页计数及无重漏', async () => {
    const first = await dispatch.listDispatchTasks({
      ...query(['PAYMENT_PENDING']),
      page: 1,
      limit: 2,
    });
    const second = await dispatch.listDispatchTasks({
      ...query(['PAYMENT_PENDING']),
      page: 2,
      limit: 2,
    });
    const third = await dispatch.listDispatchTasks({
      ...query(['PAYMENT_PENDING']),
      page: 3,
      limit: 2,
    });
    expect(first.pagination.total).toBe(6);
    expect(second.pagination.total).toBe(6);
    expect(third.pagination.total).toBe(6);
    expect(
      new Set([...first.items, ...second.items, ...third.items].map(item => item.id)).size
    ).toBe(6);
  });
  test('应该旧邮件条件与新官网条件组合为AND而非覆盖', async () => {
    await orders[0].update({ emailOrderStatus: 'processing' });
    const result = await own.listOwnTasks(staff.id, {
      ...query(['PAYMENT_PENDING']),
      emailOrderStatuses: '["processing"]',
    });
    expect(result.pagination.total).toBe(1);
    expect(result.items[0].orderId).toBe(orders[0].id);
  });
  test.each(['[not-json', '[{}]', '[null]', '["bad|value"]'])(
    '应该非法官网筛选拒绝 %s',
    async value => {
      await expect(
        own.listOwnTasks(staff.id, { officialOrderStatuses: value })
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  );
});
