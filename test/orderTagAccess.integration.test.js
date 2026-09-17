/* eslint-disable camelcase */
const run = process.env.RUN_ORDER_TAG_INTEGRATION === 'true';
const suite = run ? describe : describe.skip;

suite('订单 TAG 范围与付款任务独立授权（隔离库 HTTP）', () => {
  let models;
  let permissions;
  let server;
  let baseUrl;
  let admin;
  let staff;
  let other;
  let orders;
  let task;
  let staffToken;
  let adminToken;
  let otherToken;
  let grants;
  const headers = token => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });
  async function request(path, { token = staffToken, method = 'GET', body } = {}) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: headers(token),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : Buffer.from(await response.arrayBuffer());
      return { status: response.status, body: data };
    } catch (error) {
      throw new Error(`合成接口请求失败: ${error.message}`);
    }
  }
  async function setScope(tags, mode = 'tags') {
    try {
      await staff.reload();
      await staff.update({ orderAccess: { mode, tags } });
    } catch (error) {
      throw new Error(`合成配置失败: ${error.message}`);
    }
  }
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_tag_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    ) {
      throw new Error('只允许明确的订单 TAG 隔离测试库');
    }
    models = require('../src/models');
    permissions = require('../src/services/permissionService');
    await models.sequelize.query(
      'TRUNCATE order_refresh_batches, users, orders, recipients, apple_ids RESTART IDENTITY CASCADE'
    );
    const migration = require('../migrations/20260918000002-add-order-tag-access');
    const qi = models.sequelize.getQueryInterface();
    await migration.down(qi);
    await models.sequelize.query(
      "INSERT INTO users (username, password, role, created_at, updated_at) VALUES ('legacy_tag_user', 'synthetic-hash', 'operator', NOW(), NOW())"
    );
    await migration.up(qi, models.Sequelize);
    const [legacy] = await models.sequelize.query(
      "SELECT order_access FROM users WHERE username='legacy_tag_user'"
    );
    expect(legacy[0].order_access).toEqual({ mode: 'all', tags: [] });
    const sessions = [
      {
        id: 'synthetic-tag-session',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    ];
    [admin, staff, other] = await Promise.all(
      ['admin', 'staff', 'other'].map(name =>
        models.User.create({
          username: `tag_${name}`,
          password: 'Synthetic-Tag-Password-1!',
          role: name === 'admin' ? 'admin' : 'operator',
          status: 'active',
          activeSessions: sessions,
        })
      )
    );
    expect(staff.orderAccess).toEqual({ mode: 'tags', tags: [] });
    const { generateToken } = require('../src/utils/jwtUtils');
    [adminToken, staffToken, otherToken] = [admin, staff, other].map(user =>
      generateToken({
        userId: user.id,
        username: user.username,
        role: user.role,
        sessionId: sessions[0].id,
      })
    );
    const catalog = require('../src/constants/permissionCatalog');
    grants = [
      'orders.read',
      'orders.edit',
      'orders.export',
      'orders.refresh',
      'orders.payer.edit',
      'channels.read',
      'channels.rename',
      'dashboard.read',
      'stats.read',
      ...catalog.PAYMENT_EXECUTION_PERMISSIONS,
    ];
    await models.UserPermission.bulkCreate(
      [staff, other].flatMap(user =>
        grants.map(permissionCode => ({
          userId: user.id,
          permissionCode,
          grantedBy: admin.id,
        }))
      )
    );
    orders = await models.Order.bulkCreate(
      ['TAG-A', 'TAG-B', 'TAG-A-1', 'tag-a', null, ' TAG-A '].map((tag, i) => ({
        orderNumber: `W880000000${i}`,
        tag,
        sourceRecipientTag: i === 1 ? 'TAG-A' : null,
        ingestionSource: 'aos',
        status: 'payment_due',
        paymentStatus: 'unpaid',
        products: [{ name: `合成商品${i}`, model: `MODEL-${i}`, quantity: 1 }],
        pickupStore: `合成门店${i}`,
        recipientName: `合成取机人${i}`,
        officialOrderAmount: 100 + i,
        orderDate: new Date(),
        orderUrl: `https://example.invalid/order/${i}`,
      }))
    );
    const recipient = await models.Recipient.create({
      lastName: '合成',
      firstName: '取机人',
      idCardNumber: '110101199001010010',
      tag: 'PROFILE-DIFFERENT',
    });
    await orders[0].update({ recipientRef: recipient.id });
    task = await models.PaymentTask.create({
      orderId: orders[1].id,
      assigneeUserId: staff.id,
      processingStatus: 'pending',
      deadlineAt: new Date(Date.now() + 3600000),
      paymentLinkSource: 'order_url',
    });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use(require('../src/middleware/authMiddleware').authenticate);
    for (const [path, file] of [
      ['orders', 'orders'],
      ['channels', 'channels'],
      ['users', 'users'],
      ['stats', 'stats'],
      ['dashboard', 'dashboardRoutes'],
      ['order-refresh', 'orderRefresh'],
      ['payment-tasks', 'paymentTasks'],
    ])
      app.use(`/${path}`, require(`../src/routes/${file}`));
    app.use(require('../src/middleware/errorHandler'));
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }, 30000);
  beforeEach(async () => {
    await setScope(['TAG-A']);
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
  });

  test('精确匹配 orders.tag：不使用 AOS 来源、不匹配前缀/大小写/空白；分页不泄漏', async () => {
    const result = await request('/orders?limit=1');
    expect(result.status).toBe(200);
    expect(result.body.data.orders.map(row => row.id)).toEqual([orders[0].id]);
    expect(JSON.stringify(result.body)).not.toContain(orders[1].orderNumber);
    const page = await request('/orders?page=2&limit=1');
    expect(page.body.data.orders).toHaveLength(0);
    await setScope(['TAG-A', 'TAG-B']);
    expect((await request('/orders')).body.data.orders).toHaveLength(2);
  });
  test('空范围拒绝全部订单；管理员与显式全部范围包含无 TAG', async () => {
    await setScope([]);
    expect((await request('/orders')).body.data.orders).toHaveLength(0);
    expect((await request('/orders', { token: adminToken })).body.data.orders).toHaveLength(6);
    await setScope([], 'all');
    expect((await request('/orders')).body.data.orders).toHaveLength(6);
  });
  test('详情、编辑、刷新及付款人管理拒绝跨 TAG，订单保持不变', async () => {
    for (const [suffix, method, body] of [
      ['', 'GET'],
      ['', 'PUT', { paymentScreenshot: 'synthetic' }],
      ['/refresh', 'POST', {}],
      ['/payer', 'PUT', { payerName: 'synthetic', expectedVersion: 0, idempotencyKey: 'denied' }],
    ]) {
      expect((await request(`/orders/${orders[1].id}${suffix}`, { method, body })).status).toBe(
        404
      );
    }
    expect((await orders[1].reload()).paymentScreenshot).toEqual([]);
    expect((await request(`/orders/${orders[0].id}`)).status).toBe(200);
  });
  test('范围内编辑成功，普通编辑不能修改 TAG', async () => {
    expect(
      (
        await request(`/orders/${orders[0].id}`, {
          method: 'PUT',
          body: { paymentScreenshot: 'synthetic' },
        })
      ).status
    ).toBe(200);
    expect(
      (await request(`/orders/${orders[0].id}`, { method: 'PUT', body: { tag: 'TAG-B' } })).status
    ).toBe(400);
    expect((await orders[0].reload()).tag).toBe('TAG-A');
  });
  test('筛选候选及 Excel 导出仅来自可见订单', async () => {
    const options = await request('/orders/filter-options');
    expect(options.body.data.productNames).toEqual(['合成商品0']);
    const exported = await request('/orders/export');
    expect(exported.status).toBe(200);
    const xlsx = require('xlsx');
    const book = xlsx.read(exported.body, { type: 'buffer' });
    const rows = xlsx.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain(orders[0].orderNumber);
  });
  test('显式混合批量刷新与页面刷新整体拒绝，不创建任务', async () => {
    const before = await models.OrderRefreshJob.count();
    for (const [path, body] of [
      ['batch-refresh', { orderIds: orders.slice(0, 2).map(o => o.id) }],
      ['page-open-refresh', { order_ids: orders.slice(0, 2).map(o => o.id) }],
    ]) {
      expect((await request(`/orders/${path}`, { method: 'POST', body })).status).toBe(404);
    }
    expect(await models.OrderRefreshJob.count()).toBe(before);
  });
  test('渠道列表、统计和明细均不能旁路；指定 TAG 用户不能改名', async () => {
    const list = await request('/channels');
    expect(list.body.data.channels.map(row => row.tag)).toEqual(['TAG-A']);
    expect((await request('/channels/TAG-B/stats')).status).toBe(404);
    expect((await request('/channels/TAG-B/orders')).status).toBe(404);
    expect((await request('/channels/TAG-A/orders')).status).toBe(200);
    expect(
      (await request('/channels/TAG-A', { method: 'PUT', body: { newTag: 'NEW' } })).status
    ).toBe(403);
  });
  test('统计与仪表板 ORM/原生 SQL/筛选候选同范围', async () => {
    expect((await request('/stats/overview')).body.data.total_orders).toBe(1);
    expect((await request('/stats/apple-ids')).status).toBe(200);
    const recipientStats = await request('/stats/recipients');
    expect(recipientStats.status).toBe(200);
    expect(recipientStats.body.data).toHaveLength(1);
    expect(recipientStats.body.data[0].order_count).toBe(1);
    const products = await request('/stats/products');
    expect(products.status).toBe(200);
    expect(products.body.data.top_products.map(x => x.name)).toEqual(['合成商品0']);
    expect((await request('/dashboard/stats')).body.data.totalOrders).toBe(1);
    expect((await request('/dashboard/filter-options')).body.data.productModels).toEqual([
      'MODEL-0',
    ]);
    expect((await request('/dashboard/product-distribution')).body.data).toHaveLength(1);
    expect(
      (await request('/dashboard/daily-trend')).body.data.reduce((n, x) => n + x.count, 0)
    ).toBe(1);
    await setScope([]);
    expect((await request('/dashboard/filter-options')).body.data.productModels).toEqual([]);
  });
  test('本人跨 TAG 任务保留信息、链接、付款人登记、处理及刷新；订单接口仍拒绝', async () => {
    const baseline = await request(`/payment-tasks/${task.id}`, { token: adminToken });
    expect(baseline.status).toBe(404); // 管理员也不绕过本人任务归属
    const detail = await request(`/payment-tasks/${task.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.orderNumber).toBe(orders[1].orderNumber);
    await setScope([], 'all');
    const unrestricted = await request(`/payment-tasks/${task.id}`);
    const beforeFields = { ...unrestricted.body.data };
    delete beforeFields.remainingSeconds;
    const afterFields = { ...detail.body.data };
    delete afterFields.remainingSeconds;
    expect(afterFields).toEqual(beforeFields);
    await setScope(['TAG-A']);
    expect(
      (
        await request(`/payment-tasks/${task.id}`, {
          method: 'PUT',
          body: {
            processingNotes: '合成任务备注',
            expectedVersion: detail.body.data.version,
            idempotencyKey: 'own-task-note',
          },
        })
      ).status
    ).toBe(200);

    expect((await request(`/payment-tasks/${task.id}/payment-link`)).status).toBe(200);
    expect(
      (
        await request(`/payment-tasks/${task.id}/payer`, {
          method: 'PUT',
          body: { payerName: '合成付款人', expectedVersion: 0, idempotencyKey: 'own-task-payer' },
        })
      ).status
    ).toBe(200);
    const refresh = await request(`/payment-tasks/${task.id}/refresh`, {
      method: 'POST',
      body: {},
    });
    expect(refresh.status).toBe(202);
    expect(
      (await request(`/payment-tasks/${task.id}/refresh/${refresh.body.data.jobId}`)).status
    ).toBe(200);
    expect((await request(`/order-refresh/jobs/${refresh.body.data.jobId}`)).status).toBe(404);
    expect((await request(`/orders/${orders[1].id}`)).status).toBe(404);
    expect((await request(`/payment-tasks/${task.id}`, { token: otherToken })).status).toBe(404);
  });
  test('刷新全部只入队范围订单，范围缩小后不能读取旧批次', async () => {
    const result = await request('/orders/refresh-all', { method: 'POST', body: {} });
    expect(result.status).toBe(202);
    const batch = await models.OrderRefreshBatch.findByPk(result.body.data.batchId);
    expect(batch.orderIds).toEqual([orders[0].id]);
    expect((await request(`/order-refresh/batches/${batch.id}`)).status).toBe(200);
    await setScope([]);
    expect((await request(`/order-refresh/batches/${batch.id}`)).status).toBe(404);
    const otherResult = await request('/orders/refresh-all', {
      token: otherToken,
      method: 'POST',
      body: {},
    });
    expect(otherResult.status).toBe(202);
    expect(otherResult.body.data.batchId).not.toBe(batch.id);
  });
  test('管理员原子保存范围、审计、并发冲突、幂等内容冲突；旧 token 随即受限', async () => {
    const config = await request(`/users/${staff.id}/permissions`, { token: adminToken });
    const input = {
      permissions: grants,
      expectedVersion: config.body.data.version,
      orderAccess: { mode: 'tags', tags: ['TAG-B'] },
      idempotencyKey: 'scope-change',
    };
    const saved = await request(`/users/${staff.id}/permissions`, {
      token: adminToken,
      method: 'PUT',
      body: input,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.orderAccess).toEqual(input.orderAccess);
    expect((await request(`/orders/${orders[0].id}`)).status).toBe(404);
    expect((await request(`/orders/${orders[1].id}`)).status).toBe(200);
    expect(
      (
        await request(`/users/${staff.id}/permissions`, {
          token: adminToken,
          method: 'PUT',
          body: input,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await request(`/users/${staff.id}/permissions`, {
          token: adminToken,
          method: 'PUT',
          body: { ...input, orderAccess: { mode: 'all', tags: [] } },
        })
      ).status
    ).toBe(409);
    expect(
      (
        await request(`/users/${staff.id}/permissions`, {
          token: adminToken,
          method: 'PUT',
          body: { ...input, idempotencyKey: 'stale-version' },
        })
      ).status
    ).toBe(409);
    const event = await models.UserPermissionEvent.findOne({
      where: { idempotencyKey: 'scope-change' },
    });
    expect(event.beforeOrderAccess.tags).toEqual(['TAG-A']);
    expect(event.afterOrderAccess.tags).toEqual(['TAG-B']);
    expect((await request('/users/order-tag-options')).status).toBe(403);
    expect(
      (await request('/users/order-tag-options', { token: adminToken })).body.data.tags
    ).toContain('TAG-B');
  });
  test('旧客户端省略范围不会放宽授权；无 orders.read 仍不能读订单', async () => {
    await staff.reload();
    const result = await permissions.replaceUserPermissions(
      staff.id,
      {
        permissions: grants,
        expectedVersion: staff.permissionsVersion,
        idempotencyKey: 'legacy-client',
      },
      admin.id
    );
    expect(result.orderAccess).toEqual({ mode: 'tags', tags: ['TAG-A'] });
    await models.UserPermission.destroy({
      where: { userId: staff.id, permissionCode: 'orders.read' },
    });
    expect((await request('/orders')).status).toBe(403);
    expect((await request('/channels/TAG-A/orders')).status).toBe(403);
    await models.UserPermission.create({
      userId: staff.id,
      permissionCode: 'orders.read',
      grantedBy: admin.id,
    });
  });
  test('渠道改名同步授权和版本并留痕；拒绝已存在授权的目标 TAG', async () => {
    await other.update({ orderAccess: { mode: 'tags', tags: ['TAG-RESERVED'] } });
    expect(
      (
        await request('/channels/TAG-A', {
          token: adminToken,
          method: 'PUT',
          body: { newTag: 'TAG-RESERVED' },
        })
      ).status
    ).toBe(409);
    await staff.reload();
    const version = staff.permissionsVersion;
    expect(
      (
        await request('/channels/TAG-A', {
          token: adminToken,
          method: 'PUT',
          body: { newTag: 'TAG-RENAMED' },
        })
      ).status
    ).toBe(200);
    await staff.reload();
    expect(staff.orderAccess.tags).toEqual(['TAG-RENAMED']);
    expect(staff.permissionsVersion).toBe(version + 1);
    expect((await request('/orders')).body.data.orders.map(row => row.id)).toEqual([orders[0].id]);
    expect(
      await models.UserPermissionEvent.count({
        where: { userId: staff.id, source: 'channel_rename' },
      })
    ).toBe(1);
  });
});
