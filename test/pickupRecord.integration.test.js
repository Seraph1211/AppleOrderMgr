const run = process.env.RUN_PICKUP_INTEGRATION === 'true';
const suite = run ? describe : describe.skip;

suite('取货记录数据库与 TAG 范围', () => {
  let models;
  let controller;
  let user;
  let visibleOrder;
  let hiddenOrder;

  function response() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
  }

  beforeAll(async () => {
    if (
      !/^apple_order_mgr_pickup_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    ) {
      throw new Error('只允许明确的取货记录隔离测试库');
    }
    models = require('../src/models');
    controller = require('../src/controllers/pickupController');
    await models.sequelize.query(
      'TRUNCATE pickup_record_events, pickup_evidence, pickup_records, users, orders RESTART IDENTITY CASCADE'
    );
    user = await models.User.create({
      username: 'pickup_staff_test',
      password: 'Synthetic-Pickup-Password-1!',
      role: 'pickupStaff',
      orderAccess: { mode: 'tags', tags: ['TAG-INTERNAL'] },
    });
    [visibleOrder, hiddenOrder] = await models.Order.bulkCreate([
      {
        orderNumber: 'W9700000001',
        tag: 'TAG-INTERNAL',
        recipientName: '合成取机人甲',
        products: [{ name: '合成手机', model: 'TEST-1', quantity: 2 }],
        emailPickupDate: '2026-09-23',
        emailPickupInfo: {
          storeName: '合成门店',
          pickupDate: '2026-09-23',
          startTime: '10:00',
          endTime: '10:15',
        },
      },
      {
        orderNumber: 'W9700000002',
        tag: 'TAG-EXTERNAL',
        recipientName: '合成取机人乙',
        products: [{ name: '合成手机', model: 'TEST-2', quantity: 1 }],
      },
    ]);
  });

  afterAll(async () => {
    await models.sequelize.close();
  });

  test('列表和待取货筛选只返回授权订单 TAG', async () => {
    const res = response();
    await controller.list(
      {
        query: { page: '1', pageSize: '20', status: 'pending' },
        user: { id: user.id, role: user.role, orderAccess: user.orderAccess },
      },
      res
    );
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items.map(item => item.orderId)).toEqual([visibleOrder.id]);
  });

  test('登记已取货自动写时间并追加操作记录', async () => {
    const res = response();
    await controller.update(
      {
        params: { orderId: String(visibleOrder.id) },
        body: {
          status: 'picked_up',
          settlementAmount: '88.50',
          settlementPerson: '测试结款人',
          notes: '',
          expectedVersion: 0,
        },
        user: {
          id: user.id,
          role: user.role,
          username: user.username,
          nickname: '测试员工',
          orderAccess: user.orderAccess,
        },
      },
      res
    );
    expect(res.body.data.status).toBe('picked_up');
    expect(res.body.data.pickedUpAt).toBeTruthy();
    expect(Number(res.body.data.settlementAmount)).toBe(88.5);
    expect(await models.PickupRecordEvent.count({ where: { orderId: visibleOrder.id } })).toBe(1);
  });

  test('越权订单和陈旧版本均被拒绝', async () => {
    await expect(
      controller.update(
        {
          params: { orderId: String(hiddenOrder.id) },
          body: { status: 'picked_up', expectedVersion: 0 },
          user: { id: user.id, role: user.role, orderAccess: user.orderAccess },
        },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      controller.update(
        {
          params: { orderId: String(visibleOrder.id) },
          body: { status: 'exception', expectedVersion: 0 },
          user: { id: user.id, role: user.role, orderAccess: user.orderAccess },
        },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONCURRENT_MODIFICATION' });
  });
});
