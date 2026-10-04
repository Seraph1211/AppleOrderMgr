/* eslint-disable no-magic-numbers, camelcase -- 隔离数据库真实队列与 HTTP 验证。 */
const enabled = process.env.RUN_OFFICIAL_REFRESH_INTEGRATION === 'true';
const suite = enabled ? describe : describe.skip;

suite('手动官网状态：持久队列、权限、全选及窄范围回写', () => {
  let models;
  let service;
  let admin;
  let staff;
  let outsider;
  let orders;
  let server;
  let base;
  let actor;
  const crypto = require('crypto');
  const input = ids => ({ selection: 'ids', requestKey: crypto.randomUUID(), orderIds: ids });
  const sql = async (query, replacements = {}) => {
    try {
      return (await models.sequelize.query(query, { replacements }))[0];
    } catch (error) {
      error.component = 'officialIntegration';
      throw error;
    }
  };
  beforeAll(async () => {
    if (!/^apple_official_test_\d+$/.test(process.env.DB_NAME || '') || process.env.DATABASE_URL)
      throw new Error('只允许独立官网测试库');
    models = require('../src/models');
    service = require('../src/services/officialOrderRefreshService');
    const name = `official_${Date.now()}`;
    [admin, staff, outsider] = await Promise.all(
      ['admin', 'staff', 'other'].map((role, index) =>
        models.User.create({
          username: `${name}_${index}`,
          password: 'Synthetic-official-Password-1!',
          role: role === 'admin' ? 'admin' : 'operator',
          status: 'active',
          orderAccess:
            role === 'admin'
              ? { mode: 'all', tags: [] }
              : { mode: 'tags', tags: ['official-test-A'] },
        })
      )
    );
    await models.UserPermission.bulkCreate(
      ['orders.read', 'orders.edit'].map(permissionCode => ({
        userId: staff.id,
        permissionCode,
        grantedBy: admin.id,
      }))
    );
    orders = await models.Order.bulkCreate(
      ['A', 'A', 'B', 'A'].map((tag, index) => ({
        orderNumber: `W991122330${index}`,
        tag: `official-test-${tag}`,
        sourceRecipientTag: `official-test-${tag}`,
        ingestionSource: 'aos',
        products: [{ name: '合成手机 512GB 蓝色', quantity: 1 }],
        emailOrderStatus: 'confirmed',
        emailPaymentStatus: 'unknown',
        orderDate: new Date(),
        notes: '不应被官网更新覆盖',
      }))
    );
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = actor;
      next();
    });
    app.use('/api/orders/official-refresh', require('../src/routes/officialOrderRefresh'));
    app.use((error, req, res, _next) =>
      res.status(error.statusCode || 500).json({ code: error.code })
    );
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api/orders/official-refresh`;
  });
  beforeEach(async () => {
    await sql('DELETE FROM official_order_refresh_jobs');
    await sql('DELETE FROM official_order_refresh_batches');
    await service.claim();
    actor = { ...staff.toJSON(), permissions: ['orders.read', 'orders.edit'] };
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
  });
  test('混合越权选择整体拒绝，零任务产生', async () => {
    await expect(service.enqueue(staff, input([orders[0].id, orders[2].id]))).rejects.toMatchObject(
      { statusCode: 404 }
    );
    expect(await service.listBatches(staff)).toHaveLength(0);
  });
  test('筛选全选使用当前 TAG 权限和列表筛选，排队后新增订单不扩大范围', async () => {
    const result = await service.enqueue(staff, {
      selection: 'filtered',
      requestKey: crypto.randomUUID(),
      filters: { recipientTags: ['official-test-A'], keyword: 'W991122330' },
    });
    expect(result.queued).toBe(3);
    const batch = await service.getBatch(staff, result.batchId);
    expect(batch.jobs.map(job => job.orderId).sort()).toEqual(
      [orders[0].id, orders[1].id, orders[3].id].sort()
    );
    expect(batch.counts.queued).toBe(3);
  });
  test('并发提交按订单去重，请求编号幂等且不同参数拒绝', async () => {
    const first = input([orders[0].id, orders[1].id]);
    const [a, b] = await Promise.all([
      service.enqueue(staff, first),
      service.enqueue(staff, input([orders[1].id, orders[3].id])),
    ]);
    expect(a.queued + b.queued).toBe(3);
    const retry = await service.enqueue(staff, first);
    expect(retry.batchId).toBe(a.batchId);
    await expect(
      service.enqueue(staff, { ...first, orderIds: [orders[3].id] })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  test('真实事务只改变两个官网字段，失败及重复完成不覆盖旧值', async () => {
    const [{ snapshot: before }] = await sql(
      'SELECT to_jsonb(o) AS snapshot FROM orders o WHERE id=:id',
      { id: orders[0].id }
    );
    const batch = await service.enqueue(staff, input([orders[0].id]));
    const job = await service.claim();
    const result = {
      systemOrderId: job.orderId,
      orderNumber: orders[0].orderNumber,
      identityMatched: true,
      sourceModel: 'orderDetail',
      completeItemCount: 1,
      products: [
        { name: '不同商品信息不得写入', quantity: 2, rawStatus: 'PAYMENT_EXPIRED_STORED_ORDER' },
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
    expect(await service.finish({ ...job, outcome: 'SUCCEEDED', result })).toEqual({
      state: 'succeeded',
      errorCode: null,
    });
    const [{ snapshot: after }] = await sql(
      'SELECT to_jsonb(o) AS snapshot FROM orders o WHERE id=:id',
      { id: orders[0].id }
    );
    expect(after.official_raw_status).toBe('PAYMENT_EXPIRED_STORED_ORDER');
    for (const key of ['official_raw_status', 'official_status_observed_at']) {
      delete before[key];
      delete after[key];
    }
    expect(after).toEqual(before);
    expect((await service.getBatch(staff, batch.batchId)).counts.succeeded).toBe(1);
    expect(await service.finish({ ...job, outcome: 'SUCCEEDED', result })).toEqual({
      ignored: true,
    });
    await service.enqueue(staff, input([orders[0].id]));
    const failedJob = await service.claim();
    await service.finish({ ...failedJob, outcome: 'HTTP_541' });
    await orders[0].reload();
    expect(orders[0].officialRawStatus).toBe('PAYMENT_EXPIRED_STORED_ORDER');
  });
  test('撤权后领取失败；运行期间撤权也不回写', async () => {
    await service.enqueue(staff, input([orders[1].id]));
    await staff.update({ orderAccess: { mode: 'tags', tags: [] } });
    expect(await service.claim()).toBeNull();
    const rows = await sql('SELECT state,error_code FROM official_order_refresh_jobs');
    expect(rows[0]).toEqual({ state: 'failed', error_code: 'ACCESS_REVOKED' });
    await staff.update({ orderAccess: { mode: 'tags', tags: ['official-test-A'] } });
    await service.enqueue(staff, input([orders[1].id]));
    const job = await service.claim();
    await staff.update({ orderAccess: { mode: 'tags', tags: [] } });
    expect((await service.finish({ ...job, outcome: 'SUCCEEDED', result: {} })).errorCode).toBe(
      'ACCESS_REVOKED'
    );
    await staff.update({ orderAccess: { mode: 'tags', tags: ['official-test-A'] } });
  });
  test('取消仅影响排队项，租约失联变失败且不重试', async () => {
    const batch = await service.enqueue(staff, input([orders[0].id, orders[1].id]));
    const job = await service.claim();
    expect(await service.cancelBatch(staff, batch.batchId)).toEqual({ cancelled: 1 });
    expect(await service.claim()).toBeNull();
    await sql(
      "UPDATE official_order_refresh_jobs SET started_at=now()-interval '6 minutes' WHERE id=:id",
      { id: job.id }
    );
    expect(await service.claim()).toBeNull();
    expect((await service.getBatch(staff, batch.batchId)).counts).toMatchObject({
      cancelled: 1,
      failed: 1,
      queued: 0,
    });
  });
  test('HTTP 权限、分页、私有完成入口及异步 202 契约', async () => {
    actor = { ...outsider.toJSON(), permissions: ['orders.read'] };
    expect(
      (
        await fetch(`${base}/batches`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input([orders[0].id])),
        })
      ).status
    ).toBe(403);
    actor = { ...staff.toJSON(), permissions: ['orders.read', 'orders.edit'] };
    const response = await fetch(`${base}/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input([orders[0].id])),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect((await fetch(`${base}/batches/${body.data.batchId}?page=invalid`)).status).toBe(400);
    expect((await fetch(`${base}/finish`, { method: 'POST' })).status).toBe(404);
    actor = { ...outsider.toJSON(), permissions: ['orders.read', 'orders.edit'] };
    expect((await fetch(`${base}/batches/${body.data.batchId}`)).status).toBe(404);
  });
  test('运行器离线拒绝提交，非法字段不变成无筛选全选', async () => {
    await sql('DELETE FROM official_order_refresh_runtime');
    await expect(service.enqueue(staff, input([orders[0].id]))).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(
      service.enqueue(staff, {
        selection: 'filtered',
        requestKey: crypto.randomUUID(),
        filters: { arbitrary: true },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
