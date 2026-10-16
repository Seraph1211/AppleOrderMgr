/* eslint-disable camelcase, no-magic-numbers -- 独立合成 HTTP 与 PostgreSQL 验收数据。 */
const enabled = process.env.RUN_RECIPIENT_TAG_ACCEPTANCE === 'true';
(enabled ? describe : describe.skip)('订单TAG身份兜底HTTP与真实PG回归验收', () => {
  let db, server, baseUrl, users, tokens, recipients, orders, tasks;
  const getIds = response => response.body.data.orders.map(row => row.id).sort((a, b) => a - b);
  async function request(path, actor = 'a', method = 'GET', body) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${tokens[actor]}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const content = response.headers.get('content-type') || '';
      return {
        status: response.status,
        body: content.includes('json')
          ? await response.json()
          : Buffer.from(await response.arrayBuffer()),
      };
    } catch (error) {
      throw new Error(`独立HTTP失败: ${error.message}`);
    }
  }
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_recipient_tag_acceptance_20261014' ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('拒绝非指定独立合成数据库');
    db = require('../src/models');
    // 精简生产 Worker 不包含 HTTP 路由，仅按名称运行自动分配服务用例。
    if (process.env.RECIPIENT_TAG_SERVICE_ONLY === 'true') return;
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use(require('../src/middleware/authMiddleware').authenticate);
    for (const [path, file] of [
      ['orders', 'orders'],
      ['pickups', 'pickups'],
      ['channels', 'channels'],
      ['recipients', 'recipients'],
      ['stats', 'stats'],
      ['dashboard', 'dashboardRoutes'],
      ['payment-tasks', 'paymentTasks'],
      ['payment-dispatch', 'paymentDispatch'],
    ])
      app.use(`/${path}`, require(`../src/routes/${file}`));
    app.use(require('../src/middleware/errorHandler'));
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    await db.sequelize.query(
      'TRUNCATE users,orders,recipients,payment_dispatch_settings,payment_tag_rules RESTART IDENTITY CASCADE'
    );
    users = {};
    tokens = {};
    const session = {
      id: 'recipient-tag-acceptance',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    for (const name of ['admin', 'a', 'b', 'pay']) {
      users[name] = await db.User.create({
        username: `accept_${name}`,
        password: 'Synthetic-only-123!',
        role: name === 'admin' ? 'admin' : 'operator',
        status: 'active',
        activeSessions: [session],
        orderAccess: { mode: 'tags', tags: name === 'b' ? ['B'] : ['A'] },
      });
      tokens[name] = require('../src/utils/jwtUtils').generateToken({
        userId: users[name].id,
        username: users[name].username,
        role: users[name].role,
        sessionId: session.id,
      });
    }
    const paymentPermissions =
      require('../src/constants/permissionCatalog').PAYMENT_EXECUTION_PERMISSIONS;
    await db.UserPermission.bulkCreate(
      ['a', 'b', 'pay'].flatMap(name =>
        (name === 'pay'
          ? paymentPermissions
          : [
            'orders.read',
            'pickups.read',
            'orders.edit',
            'orders.export',
            'channels.read',
            'channels.rename',
            'dashboard.read',
            'stats.read',
            'recipients.read',
            'recipients.edit',
            'recipients.delete',
            'recipients.create',
            'payment_dispatch.read',
            ...paymentPermissions,
          ]
        ).map(permissionCode => ({ userId: users[name].id, permissionCode }))
      )
    );
    recipients = await db.Recipient.bulkCreate(
      ['A', 'B', null, '', ' \t\n ', ' A ', 'a'].map((tag, index) => ({
        lastName: '合成',
        firstName: `测试${index}`,
        idCardNumber: `1101011990010100${String(index + 10)}`,
        idCardLast4: `00${String(index + 10)}`,
        tag,
      }))
    );
    orders = await db.Order.bulkCreate(
      Array.from({ length: 10 }, (_, index) => ({
        orderNumber: `W89000000${String(index).padStart(2, '0')}`,
        ingestionSource: index % 3 === 0 ? 'aos' : index % 3 === 1 ? 'email' : 'manual',
        sourceRecipientTag: null,
        recipientName: index === 7 ? null : `合成测试${index < 7 ? index : 0}`,
        recipientIdLast4: index === 7 ? null : recipients[index < 7 ? index : 0].idCardLast4,
        tag: 'LEGACY',
        recipientRef: index < 7 ? recipients[index].id : index === 7 ? null : recipients[0].id,
        products: [{ name: `合成手机${index}`, model: `MODEL${index}`, quantity: 1 }],
        emailOrderStatus: 'confirmed',
        emailPaymentStatus: 'unknown',
        orderDate: new Date(),
        orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/W89000000${String(index).padStart(2, '0')}/synthetic`,
        orderAmount: '100.00',
      }))
    );
    tasks = await db.PaymentTask.bulkCreate(
      orders.map(order => ({
        orderId: order.id,
        assigneeUserId: users.pay.id,
        processingStatus: 'pending',
        deadlineAt: new Date(Date.now() + 1800000),
        deadlineSource: 'source_order',
        paymentLinkSource: 'order_url',
      }))
    );
  }, 30000);
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.sequelize.close();
  });

  test('AC01 全来源实时值、精确权限、分页计数与来源保留', async () => {
    const response = await request('/orders?limit=100');
    expect(response.status).toBe(200);
    expect(getIds(response)).toEqual([orders[0].id, orders[8].id, orders[9].id]);
    expect(
      response.body.data.orders.every(row => row.recipient_tag === 'A' && row.tag === 'A')
    ).toBe(true);
    const page1 = await request('/orders?limit=2&page=1');
    const page2 = await request('/orders?limit=2&page=2');
    expect(page1.body.data.total).toBe(3);
    expect(new Set([...getIds(page1), ...getIds(page2)]).size).toBe(3);
    expect((await orders[0].reload()).sourceRecipientTag).toBeNull();
    expect(orders[0].tag).toBe('LEGACY');
  });
  test('AC02 未关联与NULL/空串/全空白均缺失且不回退', async () => {
    const response = await request('/orders?limit=100', 'admin');
    expect(response.status).toBe(200);
    const rows = new Map(response.body.data.orders.map(row => [row.id, row]));
    for (const index of [2, 3, 4, 7]) expect(rows.get(orders[index].id).recipient_tag).toBeNull();
    expect(rows.get(orders[7].id).recipient_tag_state).toBe('unlinked');
    for (const index of [2, 3, 4])
      expect(rows.get(orders[index].id).recipient_tag_state).toBe('missing');
    const options = await request('/orders/filter-options', 'admin');
    expect(options.status).toBe(200);
    expect(options.body.data.recipientTags.sort()).toEqual([' A ', 'A', 'B', 'a'].sort());
  });
  test('AC03 改TAG后同一token即时撤权并授予B，历史任务不转派', async () => {
    expect((await request(`/orders/${orders[0].id}`)).status).toBe(200);
    expect((await request(`/payment-tasks/${tasks[0].id}`, 'pay')).status).toBe(200);
    await recipients[0].update({ tag: 'B' });
    expect((await request(`/orders/${orders[0].id}`)).status).toBe(404);
    expect((await request(`/orders/${orders[0].id}`, 'b')).status).toBe(200);
    expect((await request(`/payment-tasks/${tasks[0].id}`, 'pay')).status).toBe(404);
    const list = await request('/payment-tasks', 'pay');
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(0);
    expect((await tasks[0].reload()).assigneeUserId).toBe(users.pay.id);
    expect(tasks[0].processingStatus).toBe('pending');
  });
  test('AC04 本人付款无需orders.read但私有链接/码/刷新必须TAG范围', async () => {
    expect((await request('/orders', 'pay')).status).toBe(403);
    expect((await request(`/payment-tasks/${tasks[0].id}/payment-link`, 'pay')).status).toBe(200);
    for (const suffix of ['', '/payment-link', '/alipay-payment-link', '/payment-code'])
      expect((await request(`/payment-tasks/${tasks[1].id}${suffix}`, 'pay')).status).toBe(404);
    expect(
      (
        await request(`/payment-tasks/${tasks[1].id}`, 'pay', 'PUT', {
          expectedVersion: 0,
          processingNotes: '越权更改',
          idempotencyKey: 'denied-unique',
        })
      ).status
    ).toBe(404);
    expect(
      (
        await request(`/payment-tasks/${tasks[1].id}/refresh`, 'pay', 'POST', {
          requestKey: '5d70d45a-e2e5-4bd6-a2d0-8b2f4de0f388',
        })
      ).status
    ).toBe(404);
    expect((await tasks[1].reload()).processingNotes).toBeNull();
  });
  test('AC05 混合越权导出整体拒绝，正常XLSX使用档案TAG', async () => {
    const query = ids =>
      `/orders/export?orderIds=${encodeURIComponent(JSON.stringify(ids))}&fields=${encodeURIComponent(JSON.stringify(['orderNumber', 'recipientTag']))}`;
    expect((await request(query([orders[0].id, orders[1].id]))).status).toBe(404);
    const good = await request(query([orders[0].id]));
    expect(good.status).toBe(200);
    const xlsx = require('xlsx');
    const book = xlsx.read(good.body, { type: 'buffer' });
    expect(xlsx.utils.sheet_to_json(book.Sheets[book.SheetNames[0]])[0]['订单 TAG']).toBe('A');
  });
  test('AC06 真实PG仪表板及渠道/统计聚合权限一致', async () => {
    const stats = await request('/dashboard/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.data.totalOrders).toBe(3);
    const channels = await request('/channels');
    expect(channels.status).toBe(200);
    expect(channels.body.data.channels.map(row => [row.tag, row.totalOrders])).toEqual([['A', 3]]);
    const detail = await request('/channels/A/stats');
    expect(detail.status).toBe(200);
    expect(detail.body.data.totalOrders).toBe(3);
    for (const path of [
      '/channels/A/orders',
      '/stats/overview',
      '/stats/recipients',
      '/stats/apple-ids',
      '/stats/products',
      '/dashboard/product-distribution',
      '/dashboard/store-distribution',
      '/dashboard/daily-trend',
      '/dashboard/city-distribution',
      '/dashboard/filter-options',
    ])
      expect((await request(path)).status).toBe(200);
    await recipients[0].update({ tag: 'B' });
    expect((await request('/dashboard/stats')).body.data.totalOrders).toBe(0);
    expect((await request('/channels')).body.data.channels).toHaveLength(0);
    expect((await request('/dashboard/stats', 'b')).body.data.totalOrders).toBe(4);
  });
  test('AC07 完整字符串匹配保留边界空格，订单/付款过滤不trim非空TAG', async () => {
    await users.pay.update({ orderAccess: { mode: 'all', tags: [] } });
    const query = encodeURIComponent(JSON.stringify([' A ']));
    const orderResult = await request(`/orders?recipientTags=${query}`, 'admin');
    expect(getIds(orderResult)).toEqual([orders[5].id]);
    const paymentResult = await request(`/payment-tasks?recipientTags=${query}`, 'pay');
    expect(paymentResult.status).toBe(200);
    expect(paymentResult.body.data.items.map(row => row.orderId)).toEqual([orders[5].id]);
  });
  test('AC08 有限范围档案TAG编辑/删除/新建拒绝，普通资料编辑保留', async () => {
    expect(
      (await request(`/recipients/${recipients[1].id}`, 'a', 'PUT', { tag: 'A' })).status
    ).toBe(403);
    expect((await request(`/recipients/${recipients[0].id}`, 'a', 'DELETE')).status).toBe(403);
    const ordinary = await request(`/recipients/${recipients[0].id}`, 'a', 'PUT', {
      notes: '普通备注',
    });
    expect(ordinary.status).toBe(200);
    expect((await recipients[1].reload()).tag).toBe('B');
  });
  test('AC09 渠道重命名同步授权但不改来源，已有目标冲突不写', async () => {
    expect((await request('/channels/A', 'admin', 'PUT', { newTag: 'B' })).status).toBe(400);
    const response = await request('/channels/A', 'admin', 'PUT', { newTag: 'RENAMED' });
    expect(response.status).toBe(200);
    expect((await recipients[0].reload()).tag).toBe('RENAMED');
    expect((await users.a.reload()).orderAccess.tags).toEqual(['RENAMED']);
    expect((await orders[0].reload()).tag).toBe('LEGACY');
    expect(orders[0].sourceRecipientTag).toBeNull();
    expect((await request(`/orders/${orders[0].id}`)).status).toBe(200);
  });
  test('AC10 删除档案后历史订单失去范围且不回退', async () => {
    const response = await request(`/recipients/${recipients[0].id}`, 'admin', 'DELETE');
    expect(response.status).toBe(200);
    expect((await request(`/orders/${orders[0].id}`)).status).toBe(404);
    const detail = await request(`/orders/${orders[0].id}`, 'admin');
    expect(detail.status).toBe(200);
    expect(detail.body.data.recipient_tag).toBeNull();
    expect(detail.body.data.recipient_tag_state).toBe('unlinked');
  });
  test('AC11 Unicode全空白的SQL、序列化和候选完全一致', async () => {
    const { recipientTagSql } = require('../src/services/recipientTagService');
    for (const tag of ['\u00a0', '\ufeff', '\u3000', '\u2007', '\u2028', ' \t\r\n']) {
      await recipients[0].update({ tag });
      const [rows] = await db.sequelize.query(
        `SELECT ${recipientTagSql()} AS value FROM orders "Order" WHERE id = :id`,
        { replacements: { id: orders[0].id } }
      );
      expect(rows[0].value).toBeNull();
      expect(
        (await request(`/orders/${orders[0].id}`, 'admin')).body.data.recipient_tag
      ).toBeNull();
      expect(
        (await request('/orders/filter-options', 'admin')).body.data.recipientTags
      ).not.toContain(tag);
    }
  });
  test('AC12 渠道审计失败事务回滚档案/权限/版本', async () => {
    const beforeVersion = users.a.permissionsVersion;
    const spy = jest
      .spyOn(db.UserPermissionEvent, 'create')
      .mockRejectedValueOnce(new Error('独立故障注入'));
    try {
      expect((await request('/channels/A', 'admin', 'PUT', { newTag: 'ROLLBACK' })).status).toBe(
        500
      );
      expect((await recipients[0].reload()).tag).toBe('A');
      expect((await users.a.reload()).orderAccess.tags).toEqual(['A']);
      expect(users.a.permissionsVersion).toBe(beforeVersion);
      expect(await db.UserPermissionEvent.count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  test('AC13 自动分配全来源按实时TAG/权限，缺失仅all并保护已有归属', async () => {
    await db.PaymentTask.update({ assigneeUserId: null }, { where: {} });
    await users.pay.update({ orderAccess: { mode: 'all', tags: [] } });
    await db.PaymentStaffSetting.bulkCreate(
      ['a', 'b', 'pay'].map(name => ({
        userId: users[name].id,
        autoAssignEnabled: true,
        maxActiveTasks: 20,
      }))
    );
    await db.PaymentDispatchSetting.create({
      id: 1,
      enabled: true,
      mode: 'auto',
      scopeStartedAt: new Date(Date.now() - 60000),
    });
    const rules = require('../src/services/paymentTagRuleService');
    await rules.saveRule(
      null,
      { name: '甲专属', enabled: true, recipientTags: ['A'], assigneeUserIds: [users.a.id] },
      users.admin.id
    );
    const dispatch = require('../src/services/paymentDispatchService');
    const result = await dispatch.runDispatchScan();
    expect(result.assigned).toBe(10);
    for (const index of [0, 8, 9])
      expect((await tasks[index].reload()).assigneeUserId).toBe(users.a.id);
    for (const index of [2, 3, 4, 7])
      expect((await tasks[index].reload()).assigneeUserId).toBe(users.pay.id);
    await recipients[0].update({ tag: 'B' });
    expect((await dispatch.runDispatchScan()).assigned).toBe(0);
    expect((await tasks[0].reload()).assigneeUserId).toBe(users.a.id);
  });

  test('AC14 真实认证刷新入队成功，TAG变化后队列执行与进度拒绝', async () => {
    await orders[0].update({ appleId: 'synthetic@example.invalid' });
    await db.sequelize.query(
      'INSERT INTO official_order_refresh_runtime (id,heartbeat_at) VALUES (1,now()) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now()'
    );
    const result = await request(`/payment-tasks/${tasks[0].id}/refresh`, 'pay', 'POST', {
      requestKey: 'f540394e-5dce-4c75-b106-56fe4f4789a7',
    });
    expect(result.status).toBe(202);
    const jobId = result.body.data.jobId;
    const [rows] = await db.sequelize.query(
      'SELECT j.order_id AS "orderId", j.order_number AS "orderNumber", j.account_key AS "accountKey", b.purpose, b.requested_by AS "requestedBy" FROM official_order_refresh_jobs j JOIN official_order_refresh_batches b ON b.id=j.batch_id WHERE j.id=:id',
      { replacements: { id: jobId } }
    );
    const service = require('../src/services/paymentOfficialRefreshService');
    expect(await db.sequelize.transaction(t => service.authorizedOrder(rows[0], t))).not.toBeNull();
    await recipients[0].update({ tag: 'B' });
    expect(await db.sequelize.transaction(t => service.authorizedOrder(rows[0], t))).toBeNull();
    expect((await request(`/payment-tasks/${tasks[0].id}/refresh/${jobId}`, 'pay')).status).toBe(
      404
    );
    expect((await tasks[0].reload()).assigneeUserId).toBe(users.pay.id);
  });
  test('AC15 导入覆盖TAG与历史补关联不可成为有限范围扩权路径', async () => {
    const service = require('../src/services/profileImportService');
    const plan = {
      conflicts: [],
      records: [],
      errors: [],
      writes: [
        { kind: 'recipient', existing: recipients[1], changed: ['tag'], data: { tag: 'A' } },
      ],
    };
    const req = { user: { ...users.a.toJSON(), permissions: ['recipients.edit'] } };
    await expect(
      db.sequelize.transaction(t => service.applyImportPlan(plan, req, t))
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await recipients[1].reload()).tag).toBe('B');
    const controller = require('../src/controllers/profileAssociationController');
    await expect(
      controller.executeAssociations(
        { ...req, body: { token: 'forged', orderIds: [orders[7].id] } },
        {}
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  test('AC16 历史照片列表使用当前TAG，TAG变化立即改变可见范围', async () => {
    const response = await request('/pickups');
    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(3);
    expect(response.body.data.items.every(item => item.tag === 'A')).toBe(true);
    const all = await request('/pickups', 'admin');
    expect(all.body.data.items.filter(item => item.recipientTagState === 'missing')).toHaveLength(
      3
    );
    await recipients[0].update({ tag: 'B' });
    expect((await request('/pickups')).body.data.total).toBe(0);
    expect((await request('/pickups', 'b')).body.data.total).toBe(4);
  });

  test('AC17 照片签名与库存来源在TAG变化后撤权，库存本身保持', async () => {
    const record = await db.PickupRecord.create({ orderId: orders[0].id });
    const evidence = await db.PickupEvidence.create({
      pickupRecordId: record.id,
      kind: 'pickup',
      objectKey: 'synthetic/photo.png',
      originalName: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 8,
    });
    const signer = jest
      .spyOn(require('../src/services/ossService'), 'createReadUrl')
      .mockReturnValue('https://example.invalid/synthetic');
    const unit = await db.StockUnit.create({
      serialNumber: 'TAGTEST001',
      originMode: 'legacy_binding',
    });
    await db.PickupDevice.create({
      stockUnitId: unit.id,
      orderId: orders[0].id,
      serialNumber: unit.serialNumber,
      serialBarcode: unit.serialNumber,
    });
    const projection = require('../src/services/stockLedgerProjectionService');
    const ctx = {
      user: users.a,
      permissions: new Set(['stock.read', 'stock.receive', 'orders.read']),
    };
    try {
      expect((await request(`/pickups/${orders[0].id}/evidence/${evidence.id}`)).status).toBe(200);
      expect(
        (await projection.receivePreview(ctx, { serialNumber: unit.serialNumber })).unit.orderNumber
      ).toBe(orders[0].orderNumber);
      await recipients[0].update({ tag: 'B' });
      signer.mockClear();
      expect((await request(`/pickups/${orders[0].id}/evidence/${evidence.id}`)).status).toBe(404);
      expect(signer).not.toHaveBeenCalled();
      expect(
        (await projection.receivePreview(ctx, { serialNumber: unit.serialNumber })).unit.orderNumber
      ).toBeNull();
      expect((await unit.reload()).state).toBe('registered');
    } finally {
      signer.mockRestore();
    }
  });
  test('AC18 档案改TAG事务与扫描并发，扫描等待并按提交后值分配', async () => {
    await db.PaymentTask.update({ assigneeUserId: null }, { where: {} });
    await db.PaymentStaffSetting.bulkCreate(
      ['a', 'b'].map(name => ({
        userId: users[name].id,
        autoAssignEnabled: true,
        maxActiveTasks: 20,
      }))
    );
    await db.PaymentDispatchSetting.create({
      id: 1,
      enabled: true,
      mode: 'auto',
      scopeStartedAt: new Date(Date.now() - 60000),
    });
    const transaction = await db.sequelize.transaction();
    let scanning,
      finished = false;
    try {
      if (process.env.RECIPIENT_TAG_SERVICE_ONLY === 'true') {
        // Worker 不执行 API 档案编辑；模拟真实 API 已验证的跨服务互斥锁。
        await db.sequelize.query('SELECT pg_advisory_xact_lock(742091)', { transaction });
      } else {
        await require('../src/services/profileBindingService').lockProfiles(
          transaction,
          users.admin.id
        );
      }
      await recipients[0].update({ tag: 'B' }, { transaction });
      scanning = require('../src/services/paymentDispatchService')
        .runDispatchScan()
        .then(result => {
          finished = true;
          return result;
        });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(finished).toBe(false);
      await transaction.commit();
      expect((await scanning).assigned).toBe(4);
      for (const index of [0, 1, 8, 9])
        expect((await tasks[index].reload()).assigneeUserId).toBe(users.b.id);
    } finally {
      if (!transaction.finished) await transaction.rollback();
      if (scanning) await scanning;
    }
  });
});
