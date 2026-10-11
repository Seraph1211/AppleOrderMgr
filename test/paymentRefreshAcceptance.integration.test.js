/* eslint-disable no-magic-numbers, camelcase -- 独立数据库验收的明确间隔及合成数量。 */
const crypto = require('crypto');
const enabled = process.env.RUN_PAYMENT_REFRESH_ACCEPTANCE === 'true';
const suite = enabled ? describe : describe.skip;

suite('付款官网刷新独立隔离验收', () => {
  let db;
  let service;
  let queue;
  let admin;
  let staff;
  let outsider;
  let orders;
  let tasks;
  const originalFrom = process.env.PAYMENT_OFFICIAL_REFRESH_FROM;
  const sql = async (text, replacements = {}) => {
    try {
      return (await db.sequelize.query(text, { replacements }))[0];
    } catch (error) {
      error.component = 'paymentRefreshAcceptance';
      throw error;
    }
  };
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_payment_test_2026101101' ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许本轮专用付款验收库');
    process.env.PAYMENT_OFFICIAL_REFRESH_FROM = '2026-10-01T00:00:00Z';
    db = require('../src/models');
    service = require('../src/services/paymentOfficialRefreshService');
    queue = require('../src/services/officialOrderRefreshService');
    await sql('TRUNCATE orders,users,official_order_refresh_batches RESTART IDENTITY CASCADE');
    [admin, staff, outsider] = await Promise.all(
      ['admin', 'staff', 'outsider'].map((name, index) =>
        db.User.create({
          username: `payment_acceptance_${name}`,
          password: 'Synthetic-payment-1!',
          role: index === 0 ? 'admin' : 'operator',
          status: 'active',
        })
      )
    );
    await db.UserPermission.bulkCreate(
      [staff, outsider].flatMap(user =>
        ['payment_tasks.read_own', 'payment_tasks.handle_own', 'payment_tasks.link.read_own'].map(
          permissionCode => ({ userId: user.id, permissionCode, grantedBy: admin.id })
        )
      )
    );
    orders = await db.Order.bulkCreate(
      [1, 2, 3].map(index => ({
        orderNumber: `W991133000${index}`,
        appleId: `acceptance-${index}@example.test`,
        products: [{ name: '合成手机', quantity: 1 }],
        emailOrderStatus: 'confirmed',
        emailPaymentStatus: 'unknown',
        orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/W991133000${index}/synthetic`,
        orderDate: new Date(Date.now() - 86400000),
        officialRawStatus: 'PAYMENT_PENDING',
        officialStatusObservedAt: new Date(Date.now() - 3600000),
        notes: '保留人工备注',
      }))
    );
    tasks = await db.PaymentTask.bulkCreate(
      orders.map(order => ({
        orderId: order.id,
        assigneeUserId: staff.id,
        processingStatus: 'pending',
        processingNotes: '保留付款备注',
        deadlineAt: new Date(Date.now() - 1000),
      }))
    );
  });
  beforeEach(async () => {
    await sql('DELETE FROM official_order_refresh_jobs');
    await sql('DELETE FROM official_order_refresh_batches');
    await sql(
      'INSERT INTO official_order_refresh_runtime(id,heartbeat_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now()'
    );
    for (const order of orders)
      await order.update({
        emailPaymentStatus: 'unknown',
        officialRawStatus: 'PAYMENT_PENDING',
        createdAt: new Date(),
      });
    await sql('UPDATE orders SET created_at=now() WHERE id IN (:ids)', {
      ids: orders.map(order => order.id),
    });
    for (const task of tasks) await task.update({ assigneeUserId: staff.id });
  });
  afterAll(async () => {
    if (originalFrom === undefined) delete process.env.PAYMENT_OFFICIAL_REFRESH_FROM;
    else process.env.PAYMENT_OFFICIAL_REFRESH_FROM = originalFrom;
    if (db) await db.sequelize.close();
  });

  test('应该在手动并发与重放中只创建一个活动订单任务', async () => {
    const input = { requestKey: crypto.randomUUID() };
    const result = await Promise.all([
      service.enqueue(staff, Number(tasks[0].id), input),
      service.enqueue(admin, Number(tasks[0].id), { requestKey: crypto.randomUUID() }, true),
    ]);
    expect(result[0].jobId).toBe(result[1].jobId);
    expect((await sql('SELECT id FROM official_order_refresh_jobs')).length).toBe(1);
    expect((await service.enqueue(staff, Number(tasks[0].id), input)).jobId).toBe(result[0].jobId);
  });
  test('应该拒绝其他本人任务及转派后的旧处理人进度', async () => {
    await expect(
      service.enqueue(outsider, Number(tasks[0].id), { requestKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ statusCode: 404 });
    const result = await service.enqueue(staff, Number(tasks[0].id), {
      requestKey: crypto.randomUUID(),
    });
    await tasks[0].update({ assigneeUserId: outsider.id });
    await expect(service.progress(staff, Number(tasks[0].id), result.jobId)).rejects.toMatchObject({
      statusCode: 404,
    });
    const progress = await service.progress(outsider, Number(tasks[0].id), result.jobId);
    expect(progress.jobId).toBe(result.jobId);
    expect(progress).not.toHaveProperty('requestedBy');
    expect(progress).not.toHaveProperty('leaseToken');
    expect(await queue.claim()).toBeNull();
  });
  test('应该保持原订单管理员限制且付款列表读取同一官网状态', async () => {
    await expect(
      queue.enqueue(staff, {
        selection: 'ids',
        orderIds: [orders[0].id],
        requestKey: crypto.randomUUID(),
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    const own = await require('../src/services/paymentTaskService').listOwnTasks(staff.id, {
      page: 1,
      limit: 20,
    });
    const dispatch = await require('../src/services/paymentDispatchService').listDispatchTasks({
      page: 1,
      limit: 20,
    });
    expect(own.items.find(item => item.id === tasks[0].id).officialRawStatus).toBe(
      'PAYMENT_PENDING'
    );
    expect(dispatch.items.find(item => item.id === tasks[0].id).officialRawStatus).toBe(
      'PAYMENT_PENDING'
    );
  });
  test('应该失败保留旧观测并且成功只修改共用官网两列', async () => {
    const before = (
      await sql('SELECT to_jsonb(o) AS row FROM orders o WHERE id=:id', { id: orders[0].id })
    )[0].row;
    await service.enqueue(staff, Number(tasks[0].id), { requestKey: crypto.randomUUID() });
    let job = await queue.claim();
    await queue.finish({ ...job, outcome: 'COLLECTOR_FAILED' });
    expect(
      (await sql('SELECT to_jsonb(o) AS row FROM orders o WHERE id=:id', { id: orders[0].id }))[0]
        .row
    ).toEqual(before);
    await service.enqueue(staff, Number(tasks[0].id), { requestKey: crypto.randomUUID() });
    job = await queue.claim();
    const result = {
      systemOrderId: job.orderId,
      orderNumber: orders[0].orderNumber,
      identityMatched: true,
      sourceModel: 'orderDetail',
      completeItemCount: 1,
      orderPlacedDateText: '2026年10月10日',
      products: [
        {
          name: '合成手机',
          quantity: 1,
          rawStatus: 'PICKED_UP',
          pickupDateText: '已取货 10月11日',
        },
      ],
      source: {
        provider: 'Apple official website',
        host: 'secure6.www.apple.com.cn',
        status: 200,
        cached: false,
        runId: 44,
        sha256: 'a'.repeat(64),
        observedAt: new Date().toISOString(),
      },
    };
    expect(
      require('../src/services/officialPickupDate').deriveOfficialPickupDate(
        result,
        result.source.observedAt
      ).date
    ).toBe('2026-10-11');
    expect(
      (await queue.finish({ ...job, outcome: 'SUCCEEDED', transport: 'http', result })).state
    ).toBe('succeeded');
    const after = (
      await sql('SELECT to_jsonb(o) AS row FROM orders o WHERE id=:id', { id: orders[0].id })
    )[0].row;
    expect(after.official_raw_status).toBe('PICKED_UP');
    delete before.official_raw_status;
    delete before.official_status_observed_at;
    delete after.official_raw_status;
    delete after.official_status_observed_at;
    expect(after).toEqual(before);
  });
  test('应该无页面仍扫描本地过期订单，保守排除终态且三分钟去重', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'true';
    try {
      await orders[0].update({ officialRawStatus: 'PROCESSING | PAYMENT_PENDING' });
      await orders[1].update({ officialRawStatus: 'PROCESSING | MYSTERY' });
      await orders[2].update({ officialRawStatus: 'READY_FOR_PICKUP' });
      try {
        expect(await service.scan()).toEqual({ queued: 2 });
      } catch (error) {
        throw new Error(error.message, { cause: error });
      }
      expect(await service.scan()).toEqual({ queued: 0 });
      await sql(
        "UPDATE official_order_refresh_jobs SET state='failed',finished_at=now(),created_at=now()-interval '4 minutes'"
      );
      try {
        expect(await service.scan()).toEqual({ queued: 2 });
      } catch (error) {
        throw new Error(error.message, { cause: error });
      }
      await orders[0].update({ emailPaymentStatus: 'paid' });
      expect(service.needsRefresh(await orders[0].reload())).toBe(false);
    } finally {
      process.env.NODE_ENV = previous;
      delete process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED;
    }
  });
  test('应该只替换超过冷却的历史暂停单并保留暂停批次审计', async () => {
    await orders[1].update({ emailPaymentStatus: 'paid' });
    await orders[2].update({ emailPaymentStatus: 'paid' });
    const old = await service.enqueue(staff, Number(tasks[0].id), {
      requestKey: crypto.randomUUID(),
    });
    await sql("UPDATE official_order_refresh_jobs SET created_at=now()-interval '31 minutes'");
    await sql(
      "UPDATE official_order_refresh_batches SET paused_at=now()-interval '31 minutes',pause_reason='HTTP_541'"
    );
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'true';
    try {
      expect(await service.scan()).toEqual({ queued: 1 });
      expect(
        (
          await sql('SELECT state,error_code FROM official_order_refresh_jobs WHERE id=:id', {
            id: old.jobId,
          })
        )[0]
      ).toEqual({ state: 'cancelled', error_code: 'REQUEUED_FOR_PAYMENT' });
      expect(
        (
          await sql(
            "SELECT paused_at FROM official_order_refresh_batches WHERE purpose='payment_manual'"
          )
        )[0].paused_at
      ).not.toBeNull();
    } finally {
      process.env.NODE_ENV = previous;
      delete process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED;
    }
  });
  test('应该让已持锁转派完成后重新检查归属并拒绝旧处理人入队', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await tasks[0].update({ assigneeUserId: outsider.id }, { transaction });
      const pending = service.enqueue(staff, Number(tasks[0].id), {
        requestKey: crypto.randomUUID(),
      });
      const assertion = expect(pending).rejects.toMatchObject({ statusCode: 404 });
      await transaction.commit();
      await assertion;
      expect((await sql('SELECT id FROM official_order_refresh_jobs')).length).toBe(0);
    } catch (error) {
      if (!transaction.finished) await transaction.rollback();
      throw error;
    }
  });
  test('应该避免前500条官网终态阻塞之后的待付订单', async () => {
    for (const order of orders) await order.update({ emailPaymentStatus: 'paid' });
    const extraOrders = await db.Order.bulkCreate(
      Array.from({ length: 502 }, (_, index) => ({
        orderNumber: `W${String(8800000000 + index)}`,
        appleId: `fair-${index}@example.test`,
        products: [{ name: '合成手机', quantity: 1 }],
        emailOrderStatus: 'confirmed',
        emailPaymentStatus: 'unknown',
        orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/W${8800000000 + index}/synthetic`,
        orderDate: new Date(),
        officialRawStatus: index === 501 ? 'PAYMENT_PENDING' : 'READY_FOR_PICKUP',
      }))
    );
    await db.PaymentTask.bulkCreate(
      extraOrders.map(order => ({ orderId: order.id, processingStatus: 'pending' }))
    );
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'true';
    try {
      expect(await service.scan()).toEqual({ queued: 1 });
      expect((await sql('SELECT order_id FROM official_order_refresh_jobs'))[0].order_id).toBe(
        extraOrders[501].id
      );
    } finally {
      process.env.NODE_ENV = previous;
      delete process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED;
      await db.PaymentTask.destroy({ where: { orderId: extraOrders.map(order => order.id) } });
      await sql('DELETE FROM official_order_refresh_jobs');
      await sql('DELETE FROM official_order_refresh_batches');
      await db.Order.destroy({ where: { id: extraOrders.map(order => order.id) } });
    }
  });
  test('应该只自动核对cutoff等于和之后订单，历史手动刷新仍允许', async () => {
    const previous = process.env.NODE_ENV;
    const cutoff = '2026-10-11T06:00:00.000Z';
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'true';
    process.env.PAYMENT_OFFICIAL_REFRESH_FROM = cutoff;
    try {
      for (let index = 0; index < orders.length; index += 1) {
        await sql('UPDATE orders SET created_at=:created WHERE id=:id', {
          created: new Date(Date.parse(cutoff) + index - 1),
          id: orders[index].id,
        });
      }
      expect(await service.scan()).toEqual({ queued: 2 });
      const autoIds = (
        await sql('SELECT order_id FROM official_order_refresh_jobs ORDER BY order_id')
      ).map(row => row.order_id);
      expect(autoIds).toEqual([orders[1].id, orders[2].id]);
      // 三张订单均为本地倒计时过期，入队依据只按created_at界定而不按orderDate。
      const manual = await service.enqueue(staff, Number(tasks[0].id), {
        requestKey: crypto.randomUUID(),
      });
      expect(manual.created).toBe(true);
      expect(
        (
          await sql(
            'SELECT b.purpose FROM official_order_refresh_jobs j JOIN official_order_refresh_batches b ON b.id=j.batch_id WHERE j.id=:id',
            { id: manual.jobId }
          )
        )[0].purpose
      ).toBe('payment_manual');
      // 修改时间范围后领取必须再次校验；历史自动任务不能继续执行。
      process.env.PAYMENT_OFFICIAL_REFRESH_FROM = '2026-10-11T07:00:00.000Z';
      expect(await queue.claimHttp()).toBeNull();
      expect(await queue.claimHttp()).toBeNull();
      expect((await queue.claimHttp()).orderId).toBe(orders[0].id);
    } finally {
      process.env.NODE_ENV = previous;
      delete process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED;
      process.env.PAYMENT_OFFICIAL_REFRESH_FROM = '2026-10-01T00:00:00Z';
    }
  });
  test('应该在自动任务已领取后起点变化时拒绝回写旧范围', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'true';
    try {
      expect(await service.scan()).toEqual({ queued: 3 });
      const job = await queue.claimHttp();
      process.env.PAYMENT_OFFICIAL_REFRESH_FROM = new Date(Date.now() + 86400000).toISOString();
      expect(await queue.finish({ ...job, outcome: 'SUCCEEDED', result: {} })).toEqual({
        state: 'failed',
        errorCode: 'ACCESS_REVOKED',
      });
      const order = await db.Order.findByPk(job.orderId);
      expect(order.officialRawStatus).toBe('PAYMENT_PENDING');
    } finally {
      process.env.NODE_ENV = previous;
      delete process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED;
      process.env.PAYMENT_OFFICIAL_REFRESH_FROM = '2026-10-01T00:00:00Z';
    }
  });
  test.each([undefined, 'invalid'])('应该缺失或非法cutoff不扫描任何历史订单 %s', async value => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'true';
    if (value === undefined) delete process.env.PAYMENT_OFFICIAL_REFRESH_FROM;
    else process.env.PAYMENT_OFFICIAL_REFRESH_FROM = value;
    try {
      expect(await service.scan()).toEqual({ queued: 0 });
      expect((await sql('SELECT id FROM official_order_refresh_jobs')).length).toBe(0);
    } finally {
      process.env.NODE_ENV = previous;
      delete process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED;
      process.env.PAYMENT_OFFICIAL_REFRESH_FROM = '2026-10-01T00:00:00Z';
    }
  });
  test('应该拒绝共享requestKey对应其他订单而不是数据库500', async () => {
    const input = { requestKey: crypto.randomUUID() };
    await service.enqueue(staff, Number(tasks[0].id), input);
    await expect(service.enqueue(staff, Number(tasks[1].id), input)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
