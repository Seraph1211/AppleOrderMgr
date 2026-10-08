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
    await sql('TRUNCATE orders,official_order_refresh_batches,users RESTART IDENTITY CASCADE');
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
        appleId: `account-${index}@example.test`,
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
    await admin.update({ role: 'admin' });
    for (let i = 0; i < orders.length; i++)
      await orders[i].update({ appleId: `account-${i}@example.test` });
    await service.claim();
    actor = { ...admin.toJSON(), permissions: ['orders.read', 'orders.edit'] };
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
  });
  test('普通用户即使有读写权限也不能提交、读取或取消', async () => {
    await expect(service.enqueue(staff, input([orders[0].id, orders[2].id]))).rejects.toMatchObject(
      { statusCode: 403 }
    );
    expect(await service.listBatches(admin)).toHaveLength(0);
  });
  test('筛选全选使用当前 TAG 权限和列表筛选，排队后新增订单不扩大范围', async () => {
    const result = await service.enqueue(admin, {
      selection: 'filtered',
      requestKey: crypto.randomUUID(),
      filters: { recipientTags: ['official-test-A'], keyword: 'W991122330' },
    });
    expect(result.queued).toBe(3);
    const batch = await service.getBatch(admin, result.batchId);
    expect(batch.jobs.map(job => job.orderId).sort()).toEqual(
      [orders[0].id, orders[1].id, orders[3].id].sort()
    );
    expect(batch.counts.queued).toBe(3);
  });
  test('并发提交按订单去重，请求编号幂等且不同参数拒绝', async () => {
    const first = input([orders[0].id, orders[1].id]);
    const [a, b] = await Promise.all([
      service.enqueue(admin, first),
      service.enqueue(admin, input([orders[1].id, orders[3].id])),
    ]);
    expect(a.queued + b.queued).toBe(3);
    const retry = await service.enqueue(admin, first);
    expect(retry.batchId).toBe(a.batchId);
    await expect(
      service.enqueue(admin, { ...first, orderIds: [orders[3].id] })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  test('真实事务只改变两个官网字段，失败及重复完成不覆盖旧值', async () => {
    const [{ snapshot: before }] = await sql(
      'SELECT to_jsonb(o) AS snapshot FROM orders o WHERE id=:id',
      { id: orders[0].id }
    );
    const batch = await service.enqueue(admin, input([orders[0].id]));
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
    expect((await service.getBatch(admin, batch.batchId)).counts.succeeded).toBe(1);
    expect(await service.finish({ ...job, outcome: 'SUCCEEDED', result })).toEqual({
      ignored: true,
    });
    await service.enqueue(admin, input([orders[0].id]));
    const failedJob = await service.claim();
    await service.finish({ ...failedJob, outcome: 'HTTP_541' });
    await orders[0].reload();
    expect(orders[0].officialRawStatus).toBe('PAYMENT_EXPIRED_STORED_ORDER');
  });
  test('撤权后领取失败；运行期间撤权也不回写', async () => {
    await service.enqueue(admin, input([orders[1].id]));
    await admin.update({ role: 'operator' });
    expect(await service.claim()).toBeNull();
    const rows = await sql('SELECT state,error_code FROM official_order_refresh_jobs');
    expect(rows[0]).toEqual({ state: 'failed', error_code: 'ACCESS_REVOKED' });
    await admin.update({ role: 'admin' });
    await service.enqueue(admin, input([orders[1].id]));
    const job = await service.claim();
    await admin.update({ role: 'operator' });
    expect((await service.finish({ ...job, outcome: 'SUCCEEDED', result: {} })).errorCode).toBe(
      'ACCESS_REVOKED'
    );
    await admin.update({ role: 'admin' });
  });
  test('取消仅影响排队项，租约失联变失败且不重试', async () => {
    const batch = await service.enqueue(admin, input([orders[0].id, orders[1].id]));
    const job = await service.claim();
    expect(await service.cancelBatch(admin, batch.batchId)).toEqual({ cancelled: 1 });
    expect(await service.claim()).toBeNull();
    await sql(
      "UPDATE official_order_refresh_jobs SET started_at=now()-interval '6 minutes' WHERE id=:id",
      { id: job.id }
    );
    expect(await service.claim()).toBeNull();
    expect((await service.getBatch(admin, batch.batchId)).counts).toMatchObject({
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
    actor = { ...admin.toJSON(), permissions: ['orders.read', 'orders.edit'] };
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
    expect((await fetch(`${base}/batches/${body.data.batchId}`)).status).toBe(403);
    expect((await fetch(`${base}/batches`)).status).toBe(403);
    expect(
      (await fetch(`${base}/batches/${body.data.batchId}/cancel`, { method: 'POST' })).status
    ).toBe(403);
  });
  test('运行器离线拒绝提交，非法字段不变成无筛选全选', async () => {
    await sql('DELETE FROM official_order_refresh_runtime');
    await expect(service.enqueue(admin, input([orders[0].id]))).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(
      service.enqueue(admin, {
        selection: 'filtered',
        requestKey: crypto.randomUUID(),
        filters: { arbitrary: true },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  test.each([
    'AUTH_REJECTED',
    'AUTH_PRECONDITION_REQUIRED',
    'HTTP_AUTH_FAILED',
    'HUMAN_VERIFICATION_REQUIRED',
    'HTTP_541',
    'HTTP_429',
    'HTTP_407',
    'PROXY_CONNECTION_FAILED',
    'PROXY_COOLDOWN',
    'REQUEST_BUDGET',
  ])('%s 暂停批次且保留心跳，重启领取不会重放积压', async outcome => {
    const created = await service.enqueue(admin, input([orders[0].id, orders[1].id]));
    const job = await service.claim();
    await service.finish({ ...job, outcome });
    const held = await service.getBatch(admin, created.batchId);
    expect(held).toMatchObject({ pauseReason: outcome, workerOnline: true });
    expect(held.pausedAt).toBeTruthy();
    expect(held.counts).toMatchObject({ failed: 1, queued: 1 });
    expect(await service.claim()).toBeNull();
    expect(await service.claim()).toBeNull();
    expect((await service.listBatches(admin))[0].pauseReason).toBe(outcome);
  });
  test('手动选择只替代暂停批次中选中的排队项，幂等且不重放其他项', async () => {
    await orders[1].update({ appleId: orders[0].appleId });
    await orders[3].update({ appleId: orders[0].appleId });
    const created = await service.enqueue(admin, input([orders[0].id, orders[1].id, orders[3].id]));
    await sql(
      "UPDATE official_order_refresh_batches SET paused_at=now(),pause_reason='LEGACY_SAFETY_HOLD' WHERE id=:id",
      { id: created.batchId }
    );
    const selected = input([orders[1].id]);
    const [a, b] = await Promise.all([
      service.enqueue(admin, selected),
      service.enqueue(admin, selected),
    ]);
    expect(a.batchId).toBe(b.batchId);
    expect(a.queued).toBe(1);
    const held = await service.getBatch(admin, created.batchId);
    expect(held.counts).toMatchObject({ queued: 2, cancelled: 1 });
    expect(held.jobs.find(job => job.orderId === orders[1].id)).toMatchObject({
      state: 'cancelled',
      errorCode: 'REQUEUED_MANUALLY',
    });
    const job = await service.claim();
    expect(job.orderId).toBe(orders[1].id);
    await service.finish({ ...job, outcome: 'ORDER_ATTEMPT_LIMIT' });
    expect(await service.claim()).toBeNull();
  });
  test('普通用户不能替代他人的暂停项', async () => {
    const created = await service.enqueue(admin, input([orders[0].id, orders[2].id]));
    await sql(
      "UPDATE official_order_refresh_batches SET paused_at=now(),pause_reason='LEGACY_SAFETY_HOLD' WHERE id=:id",
      { id: created.batchId }
    );
    await expect(service.enqueue(staff, input([orders[0].id]))).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service.getBatch(staff, created.batchId)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service.listBatches(staff)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.cancelBatch(staff, created.batchId)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect((await service.getBatch(admin, created.batchId)).counts.queued).toBe(2);
  });
  test('暂停字段成对校验，迁移回滚不能删除保护状态', async () => {
    const created = await service.enqueue(admin, input([orders[0].id]));
    await expect(
      sql('UPDATE official_order_refresh_batches SET paused_at=now() WHERE id=:id', {
        id: created.batchId,
      })
    ).rejects.toThrow();
    await sql(
      "UPDATE official_order_refresh_batches SET paused_at=now(),pause_reason='LEGACY_SAFETY_HOLD' WHERE id=:id",
      { id: created.batchId }
    );
    const migration = require('../migrations/20261005000001-add-official-refresh-batch-pause');
    await expect(migration.down(models.sequelize.getQueryInterface())).rejects.toThrow(
      '官网更新批次暂停迁移回滚失败'
    );
    expect((await service.getBatch(admin, created.batchId)).pauseReason).toBe('LEGACY_SAFETY_HOLD');
    await sql('DELETE FROM official_order_refresh_jobs');
    await sql('DELETE FROM official_order_refresh_batches');
    await migration.down(models.sequelize.getQueryInterface());
    await migration.up(models.sequelize.getQueryInterface());
  });

  const resultFor = job => ({
    systemOrderId: job.orderId,
    orderNumber: orders.find(order => order.id === job.orderId).orderNumber,
    identityMatched: true,
    sourceModel: 'orderDetail',
    completeItemCount: 1,
    products: [{ name: '合成详情不可覆盖业务商品', quantity: 2, rawStatus: 'PICKED_UP' }],
    source: {
      provider: 'Apple official website',
      host: 'www.apple.com.cn',
      status: 200,
      cached: false,
      runId: 42,
      sha256: 'a'.repeat(64),
      observedAt: new Date().toISOString(),
    },
  });
  test.each(['ids', 'filtered'])(
    '%s 只固化所选订单，不展开同账号其他 TAG 或终态订单',
    async selection => {
      await orders[2].update({
        appleId: ' ACCOUNT-0@EXAMPLE.TEST ',
        emailOrderStatus: 'cancelled',
      });
      let request = input([orders[0].id]);
      if (selection === 'filtered') {
        request = {
          selection,
          requestKey: crypto.randomUUID(),
          filters: { keyword: orders[0].orderNumber },
        };
      }
      const created = await service.enqueue(admin, request);
      expect(created).toMatchObject({ selectedCount: 1, accountCount: 1, total: 1, queued: 1 });
      const batch = await service.getBatch(admin, created.batchId);
      expect(batch.jobs.map(job => job.orderId)).toEqual([orders[0].id]);
      await orders[3].update({ appleId: 'account-0@example.test' });
      expect((await service.getBatch(admin, created.batchId)).total).toBe(1);
    }
  );
  test('同账号不同订单跨批次允许排队，仅同一订单去重，领取时仍互斥', async () => {
    await orders[2].update({ appleId: ' ACCOUNT-0@EXAMPLE.TEST ' });
    const [a, b] = await Promise.all([
      service.enqueue(admin, input([orders[0].id])),
      service.enqueue(admin, input([orders[2].id])),
    ]);
    expect(a).toMatchObject({ total: 1, queued: 1 });
    expect(b).toMatchObject({ total: 1, queued: 1 });
    expect(await service.enqueue(admin, input([orders[0].id]))).toMatchObject({
      total: 1,
      queued: 0,
      skipped: 1,
      batchId: null,
    });
    const first = await service.claimHttp();
    expect(await service.claimHttp()).toBeNull();
    await service.finish({ ...first, outcome: 'ORDER_ATTEMPT_LIMIT' });
    const second = await service.claimHttp();
    expect(second).not.toBeNull();
    expect(new Set([first.orderId, second.orderId])).toEqual(new Set([orders[0].id, orders[2].id]));
  });
  test('多选按订单去重，跨批次并发提交不重复，兼容分组和重放计数保持', async () => {
    await orders[2].update({ appleId: orders[0].appleId });
    const first = input([orders[0].id, orders[2].id]);
    const a = await service.enqueue(admin, first);
    const [b, c] = await Promise.all([
      service.enqueue(admin, input([orders[0].id, orders[1].id])),
      service.enqueue(admin, input([orders[2].id, orders[1].id])),
    ]);
    expect(a.queued + b.queued + c.queued).toBe(3);
    expect(await service.enqueue(admin, first)).toMatchObject({ ...a, replayed: true });
    const job = await service.claim();
    expect(job.jobs).toHaveLength(2);
    expect(new Set(job.jobs.map(member => member.leaseToken)).size).toBe(1);
    expect(await service.claim()).toBeNull();
  });
  test('缺账号订单单独失败范围，不展开其他空账号', async () => {
    await orders[0].update({ appleId: null });
    await orders[2].update({ appleId: '' });
    expect(await service.enqueue(admin, input([orders[0].id]))).toMatchObject({
      total: 1,
      accountCount: 0,
    });
  });
  test('排队后部分订单换账号不阻断原组其他订单，回写逐单拒绝变化项', async () => {
    await orders[2].update({ appleId: orders[0].appleId });
    await service.enqueue(admin, input([orders[0].id, orders[2].id]));
    await orders[0].update({ appleId: 'changed-before-claim@example.test' });
    const group = await service.claim();
    expect(group.jobs).toHaveLength(2);
    expect(
      await service.finishGroup({
        ...group,
        results: group.jobs.map(job => ({
          ...job,
          outcome: 'SUCCEEDED',
          result: resultFor(job),
        })),
      })
    ).toMatchObject({ succeeded: 1, failed: 1 });
  });
  test('整组只回写两个字段，部分失败保留原值，重复完成忽略', async () => {
    await orders[2].update({ appleId: orders[0].appleId });
    const before = await sql('SELECT id,to_jsonb(o) AS snapshot FROM orders o ORDER BY id');
    const created = await service.enqueue(admin, input([orders[0].id, orders[2].id]));
    const group = await service.claim();
    const results = group.jobs.map((job, index) => ({
      ...job,
      outcome: index ? 'HTTP_541' : 'SUCCEEDED',
      result: resultFor(job),
    }));
    expect(await service.finishGroup({ ...group, results })).toMatchObject({
      succeeded: 1,
      failed: 1,
    });
    expect(await service.finishGroup({ ...group, results })).toEqual({ ignored: true });
    const after = await sql('SELECT id,to_jsonb(o) AS snapshot FROM orders o ORDER BY id');
    for (let index = 0; index < after.length; index++) {
      if (after[index].id === group.jobs[0].orderId) {
        expect(after[index].snapshot.official_raw_status).toBe('PICKED_UP');
        for (const key of ['official_raw_status', 'official_status_observed_at']) {
          delete after[index].snapshot[key];
          delete before[index].snapshot[key];
        }
      }
    }
    expect(after).toEqual(before);
    expect((await service.getBatch(admin, created.batchId)).pauseReason).toBe('HTTP_541');
  });
  test.each(['role', 'account', 'identity', 'stale', 'lease'])(
    '整组回写拒绝降权、账号变化、错单、旧观测和旧租约：%s',
    async kind => {
      await service.enqueue(admin, input([orders[0].id]));
      const group = await service.claim();
      const results = group.jobs.map(job => ({
        ...job,
        outcome: 'SUCCEEDED',
        result: resultFor(job),
      }));
      if (kind === 'role') await admin.update({ role: 'operator' });
      if (kind === 'account') await orders[0].update({ appleId: 'changed@example.test' });
      if (kind === 'identity') results[0].result.orderNumber = 'W9999999999';
      if (kind === 'stale') results[0].result.source.observedAt = '2020-01-01T00:00:00Z';
      if (kind === 'lease') group.leaseToken = crypto.randomUUID();
      const response = await service.finishGroup({ ...group, results });
      if (kind === 'lease') expect(response).toEqual({ ignored: true });
      else expect(response).toMatchObject({ succeeded: 0, failed: 1 });
      await admin.update({ role: 'admin' });
    }
  );
  test('正式账号迁移保留审计，非空分组禁止 down；空表 up/down 可重放', async () => {
    const migration = require('../migrations/20261005000002-group-official-refresh-by-account');
    await service.enqueue(admin, input([orders[0].id]));
    await expect(migration.down(models.sequelize.getQueryInterface())).rejects.toThrow(
      '官网账号分组迁移回滚失败'
    );
    await sql('DELETE FROM official_order_refresh_jobs');
    await sql('DELETE FROM official_order_refresh_batches');
    await migration.down(models.sequelize.getQueryInterface());
    await migration.up(models.sequelize.getQueryInterface());
  });
  test('迁移暂停旧排队批次，保留原暂停原因且不自动恢复旧任务', async () => {
    const migration = require('../migrations/20261005000002-group-official-refresh-by-account');
    await migration.down(models.sequelize.getQueryInterface());
    const first = crypto.randomUUID();
    const held = crypto.randomUUID();
    for (const id of [first, held]) {
      await sql(
        `INSERT INTO official_order_refresh_batches
        (id,requested_by,request_key,request_fingerprint,selection_mode)
        VALUES(:id,:userId,:key,'synthetic','ids')`,
        { id, userId: admin.id, key: crypto.randomUUID() }
      );
    }
    await sql(
      "UPDATE official_order_refresh_batches SET paused_at=now(),pause_reason='HTTP_541' WHERE id=:id",
      { id: held }
    );
    await sql(
      `INSERT INTO official_order_refresh_jobs(id,batch_id,order_id,order_number)
      VALUES(:id,:batch,:orderId,:number)`,
      {
        id: crypto.randomUUID(),
        batch: first,
        orderId: orders[0].id,
        number: orders[0].orderNumber,
      }
    );
    await migration.up(models.sequelize.getQueryInterface());
    expect((await service.getBatch(admin, first)).pauseReason).toBe('LEGACY_ACCOUNT_SCOPE');
    expect((await service.getBatch(admin, held)).pauseReason).toBe('HTTP_541');
    expect(await service.claim()).toBeNull();
    expect((await service.getBatch(admin, first)).counts.queued).toBe(1);
  });
  test('采集前批量读取只限已领取组，降权、账号变化和单单缺凭据分别拒绝', async () => {
    const { readOfficialOrderGroupInput } = require('../src/services/officialOrderInput');
    const { encrypt } = require('../src/utils/fieldEncryption');
    await orders[2].update({ appleId: orders[0].appleId });
    await sql('UPDATE orders SET apple_password=:password,order_url=:url WHERE id=:id', {
      password: encrypt('synthetic-password'),
      url: `https://www.apple.com.cn/shop/order/list/${orders[0].orderNumber}/contact%40example.test`,
      id: orders[0].id,
    });
    await service.enqueue(admin, input([orders[0].id, orders[2].id]));
    const group = await service.claim();
    const client = await models.sequelize.connectionManager.getConnection();
    try {
      const value = await readOfficialOrderGroupInput(
        client,
        group.accountGroupId,
        group.leaseToken
      );
      expect(value.samples).toHaveLength(1);
      expect(value.samples[0].id).toBe(orders[0].id);
      expect(value.failures).toEqual([
        { orderId: orders[2].id, outcome: 'ORDER_CREDENTIALS_MISSING' },
      ]);
      await orders[0].update({ appleId: 'changed@example.test' });
      expect(
        (await readOfficialOrderGroupInput(client, group.accountGroupId, group.leaseToken)).failures
      ).toContainEqual({ orderId: orders[0].id, outcome: 'ACCOUNT_CHANGED' });
      await admin.update({ role: 'operator' });
      expect(
        (await readOfficialOrderGroupInput(client, group.accountGroupId, group.leaseToken)).failures
      ).toEqual(group.jobs.map(job => ({ orderId: job.orderId, outcome: 'ACCESS_REVOKED' })));
      await expect(
        readOfficialOrderGroupInput(client, group.accountGroupId, crypto.randomUUID())
      ).rejects.toThrow('ACCESS_REVOKED');
    } finally {
      await models.sequelize.connectionManager.releaseConnection(client);
      await admin.update({ role: 'admin' });
    }
  });
  test('HTTP 同账号逐单互斥，不同账号可以并行，过期租约不自动重放', async () => {
    await orders[1].update({ appleId: orders[0].appleId });
    await service.enqueue(admin, input(orders.map(order => order.id)));
    const first = await service.claimHttp();
    const second = await service.claimHttp();
    const third = await service.claimHttp();
    expect(new Set([first.accountKey, second.accountKey, third.accountKey]).size).toBe(3);
    expect(await service.claimHttp()).toBeNull();
    await service.finish({ ...first, outcome: 'NO_VALID_ORDER_DATA' });
    expect((await service.claimHttp()).orderId).toBe(orders[1].id);
    await sql(
      "UPDATE official_order_refresh_jobs SET started_at=now()-interval '21 minutes' WHERE state='running'"
    );
    expect(await service.claimHttp()).toBeNull();
    const rows = await sql(
      "SELECT count(*)::int AS count FROM official_order_refresh_jobs WHERE error_code='WORKER_INTERRUPTED'"
    );
    expect(rows[0].count).toBe(3);
  });
  test('HTTP 完整结果补取货日期空值，已有日期与人工字段保持', async () => {
    await sql('UPDATE orders SET actual_pickup_date=NULL WHERE id=:id', { id: orders[0].id });
    await service.enqueue(admin, input([orders[0].id]));
    const job = await service.claimHttp();
    const result = {
      systemOrderId: job.orderId,
      orderNumber: job.orderNumber,
      identityMatched: true,
      sourceModel: 'orderDetail',
      completeItemCount: 1,
      orderPlacedDateText: '2026年9月18日',
      products: [
        { name: '合成手机', quantity: 1, rawStatus: 'PICKED_UP', pickupDateText: '已取货 9月22日' },
      ],
      source: {
        provider: 'Apple official website',
        host: 'secure6.www.apple.com.cn',
        status: 200,
        cached: false,
        runId: 100,
        sha256: 'b'.repeat(64),
        observedAt: new Date().toISOString(),
      },
    };
    expect(
      (await service.finish({ ...job, outcome: 'SUCCEEDED', transport: 'http', result })).state
    ).toBe('succeeded');
    await orders[0].reload();
    expect(
      (
        await sql('SELECT actual_pickup_date::text AS date FROM orders WHERE id=:id', {
          id: orders[0].id,
        })
      )[0].date
    ).toBe('2026-09-22');
    const notes = orders[0].notes;
    await service.enqueue(admin, input([orders[0].id]));
    const again = await service.claimHttp();
    result.products[0].pickupDateText = '已取货 9月23日';
    result.source.observedAt = new Date().toISOString();
    await service.finish({ ...again, outcome: 'SUCCEEDED', transport: 'http', result });
    await orders[0].reload();
    expect(
      (
        await sql('SELECT actual_pickup_date::text AS date FROM orders WHERE id=:id', {
          id: orders[0].id,
        })
      )[0].date
    ).toBe('2026-09-22');
    expect(orders[0].notes).toBe(notes);
  });
});
