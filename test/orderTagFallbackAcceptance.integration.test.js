/* eslint-disable camelcase, no-magic-numbers -- 隔离数据库独立验收的合成业务数据。 */
const enabled = process.env.RUN_ORDER_TAG_FALLBACK_ACCEPTANCE === 'true';
(enabled ? describe : describe.skip)('AOS优先与身份匹配兜底独立验收', () => {
  let db, server, baseUrl, users, tokens, recipients, orders, tasks;
  const ids = result => result.body.data.orders.map(row => row.id).sort((a, b) => a - b);
  async function request(path, actor = 'a', method = 'GET', body) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${tokens[actor]}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      throw new Error(`独立HTTP请求失败: ${error.message}`);
    }
  }
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_tag_fallback_acceptance_20261016' ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('拒绝非指定隔离测试数据库');
    db = require('../src/models');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use(require('../src/middleware/authMiddleware').authenticate);
    for (const [path, file] of [
      ['orders', 'orders'],
      ['pickups', 'pickups'],
      ['recipients', 'recipients'],
      ['channels', 'channels'],
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
      id: 'tag-fallback-acceptance',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    for (const actor of ['admin', 'a', 'b']) {
      users[actor] = await db.User.create({
        username: `fallback_${actor}`,
        password: 'Synthetic-only-123!',
        role: actor === 'admin' ? 'admin' : 'operator',
        status: 'active',
        activeSessions: [session],
        orderAccess: { mode: 'tags', tags: [actor === 'b' ? 'B' : 'A'] },
      });
      tokens[actor] = require('../src/utils/jwtUtils').generateToken({
        userId: users[actor].id,
        username: users[actor].username,
        role: users[actor].role,
        sessionId: session.id,
      });
    }
    await db.UserPermission.bulkCreate(
      ['a', 'b'].flatMap(actor =>
        [
          'orders.read',
          'pickups.read',
          'recipients.read',
          'recipients.edit',
          'recipients.create',
          'recipients.delete',
          'channels.read',
          'dashboard.read',
          ...require('../src/constants/permissionCatalog').PAYMENT_EXECUTION_PERMISSIONS,
        ].map(permissionCode => ({ userId: users[actor].id, permissionCode }))
      )
    );
    recipients = await db.Recipient.bulkCreate(
      [
        ['唯一', '甲', '110101199001011111', 'A'],
        ['唯一', '乙', '110101199001012222', 'B'],
        ['重名', '甲', '110101199001013333', 'A'],
        ['重名', '甲', '110101199101013333', 'A'],
        ['空白', '甲', '110101199001014444', '\ufeff\t '],
        ['尾号', '甲', '11010119900101123X', 'A'],
      ].map(([lastName, firstName, idCardNumber, tag]) => ({
        lastName,
        firstName,
        idCardNumber,
        idCardLast4: idCardNumber.slice(-4),
        tag,
      }))
    );
    const specs = [
      { sourceRecipientTag: 'A' },
      {
        sourceRecipientTag: 'A',
        recipientName: '唯一乙',
        recipientIdLast4: '2222',
        recipientRef: recipients[1].id,
      },
      { recipientName: '唯一甲', recipientIdLast4: '1111' },
      {
        sourceRecipientTag: '\ufeff\t ',
        recipientName: '唯一甲',
        recipientIdLast4: '1111',
        recipientRef: recipients[1].id,
      },
      { recipientName: '重名甲', recipientIdLast4: '3333', recipientRef: recipients[2].id },
      { recipientName: '空白甲', recipientIdLast4: '4444' },
      { recipientName: '唯一甲', recipientIdLast4: '1111', recipientIdCard: '110101199001012222' },
      {
        ingestionSource: 'email',
        sourceRecipientTag: 'EMAIL',
        recipientName: '唯一甲',
        recipientIdLast4: '1111',
      },
      { recipientName: '不存在', recipientIdLast4: '1111', recipientRef: recipients[0].id },
      { recipientName: '尾号甲', recipientIdLast4: '123x' },
      { sourceRecipientTag: ' A ' },
      { sourceRecipientTag: 'a' },
      {
        recipientName: '唯一甲',
        sourceLastName: '唯一',
        sourceFirstName: '乙',
        recipientIdLast4: '1111',
      },
      { recipientName: '唯一甲', recipientIdCard: '110101199001011111' },
    ];
    orders = await db.Order.bulkCreate(
      specs.map((spec, index) => ({
        orderNumber: `W96000000${String(index).padStart(2, '0')}`,
        ingestionSource: 'aos',
        sourceRecipientTag: null,
        tag: 'LEGACY',
        products: [{ name: '合成手机', quantity: 1 }],
        orderDate: new Date(),
        orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/W96000000${String(index).padStart(2, '0')}/synthetic`,
        emailOrderStatus: 'confirmed',
        emailPaymentStatus: 'unknown',
        ...spec,
      }))
    );
    tasks = await db.PaymentTask.bulkCreate(
      orders.map(order => ({
        orderId: order.id,
        assigneeUserId: users.a.id,
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

  test('原始AOS优先；身份唯一兜底不依赖关联；歧义、空白和冲突缺失', async () => {
    const response = await request('/orders?limit=100', 'admin');
    expect(response.status).toBe(200);
    const rows = new Map(response.body.data.orders.map(row => [row.id, row]));
    const expected = ['A', 'A', 'A', 'A', null, null, 'A', 'A', null, 'A', ' A ', 'a', null, null];
    for (const [index, tag] of expected.entries()) {
      expect({ index, tag: rows.get(orders[index].id).recipient_tag }).toEqual({ index, tag });
      expect(rows.get(orders[index].id).tag).toBe(tag);
      if (tag) expect(rows.get(orders[index].id).recipient_tag_state).toBe('present');
    }
    expect((await orders[3].reload()).recipientRef).toBe(recipients[1].id);
    expect((await orders[2].reload()).recipientRef).toBeNull();
    expect(rows.get(orders[3].id).recipient_name).toBe('唯一甲');
    const detail = await request(`/orders/${orders[3].id}`, 'admin');
    expect(detail.status).toBe(200);
    expect(detail.body.data.recipient_name).toBe('唯一甲');
    expect(detail.body.data.recipient.name).toBe('唯一乙');
    expect(detail.body.data.recipient.id).toBe(recipients[1].id);
    const payment = await request(`/payment-tasks/${tasks[3].id}`);
    expect(payment.status).toBe(200);
    expect(payment.body.data.recipientName).toBe('唯一甲');
  });
  test('精确TAG权限在分页之前过滤，详情、付款与渠道同口径', async () => {
    const expected = [0, 1, 2, 3, 6, 7, 9].map(index => orders[index].id);
    const first = await request('/orders?limit=4&page=1');
    const second = await request('/orders?limit=4&page=2');
    expect(first.body.data.total).toBe(expected.length);
    expect([...ids(first), ...ids(second)].sort((a, b) => a - b)).toEqual(expected);
    expect((await request(`/orders/${orders[10].id}`)).status).toBe(404);
    expect((await request(`/payment-tasks/${tasks[0].id}`)).status).toBe(200);
    expect((await request(`/payment-tasks/${tasks[4].id}`)).status).toBe(404);
    const channels = await request('/channels');
    expect(channels.body.data.channels.map(row => [row.tag, row.totalOrders])).toEqual([
      ['A', expected.length],
    ]);
    expect((await request('/dashboard/stats')).body.data.totalOrders).toBe(expected.length);
  });
  test('档案TAG变更只影响兜底订单，历史AOS TAG不随动', async () => {
    await recipients[0].update({ tag: 'B' });
    expect(ids(await request('/orders?limit=100'))).toEqual(
      [0, 1, 9].map(index => orders[index].id)
    );
    expect(ids(await request('/orders?limit=100', 'b'))).toEqual(
      [2, 3, 6, 7].map(index => orders[index].id)
    );
    expect((await request(`/payment-tasks/${tasks[2].id}`)).status).toBe(404);
    expect((await request(`/payment-tasks/${tasks[1].id}`)).status).toBe(200);
  });
  test('只读投影不写入订单关联、快照、原始TAG或档案', async () => {
    const snapshot = async () =>
      (
        await db.sequelize.query(
          'SELECT (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM orders o) orders, (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM recipients r) recipients'
        )
      )[0][0];
    const before = await snapshot();
    for (const path of ['/orders?limit=100', '/channels', '/dashboard/stats', '/payment-tasks'])
      expect((await request(path, 'admin')).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  test('计算SQL、JavaScript序列化、通知与付款规则使用相同最终TAG', async () => {
    const tags = require('../src/services/recipientTagService');
    const result = await db.Order.findAll({
      attributes: tags.recipientTagProjection(),
      order: [['id', 'ASC']],
    });
    for (const row of result) {
      const plain = row.toJSON();
      expect(tags.getRecipientTag(plain)).toBe(plain.recipientTag);
      expect(tags.getRecipientTag(row)).toBe(plain.recipientTag);
      const notification =
        require('../src/services/wecomNotificationContent').buildNotificationText(
          plain,
          'https://example.invalid/payment'
        );
      expect(notification.split(' || ')[1]).toBe(plain.recipientTag || 'TAG 缺失');
    }
    expect(tags.getRecipientTagSource(result[0])).toBe('aos');
    expect(tags.getRecipientTagSource(result[2])).toBe('recipient');
    expect(tags.getRecipientTagSource(result[4])).toBeNull();
  });

  test('自动分配按最终TAG匹配规则，缺失TAG不进入限定人员范围', async () => {
    await db.PaymentTask.update({ assigneeUserId: null }, { where: {} });
    await db.PaymentStaffSetting.bulkCreate(
      ['a', 'b'].map(actor => ({
        userId: users[actor].id,
        autoAssignEnabled: true,
        maxActiveTasks: 30,
      }))
    );
    await db.PaymentDispatchSetting.create({
      id: 1,
      enabled: true,
      mode: 'auto',
      scopeStartedAt: new Date(Date.now() - 60000),
    });
    await require('../src/services/paymentTagRuleService').saveRule(
      null,
      { name: 'A最终TAG专属', enabled: true, recipientTags: ['A'], assigneeUserIds: [users.a.id] },
      users.admin.id
    );
    const result = await require('../src/services/paymentDispatchService').runDispatchScan();
    expect(result.assigned).toBe(7);
    for (const index of [0, 1, 2, 3, 6, 7, 9])
      expect((await tasks[index].reload()).assigneeUserId).toBe(users.a.id);
    for (const index of [4, 5, 8, 10, 11, 12, 13])
      expect((await tasks[index].reload()).assigneeUserId).toBeNull();
  });

  test('有限TAG权限禁止通过修改身份或创建档案改变订单兜底范围', async () => {
    expect(
      (
        await request('/recipients', 'a', 'POST', {
          lastName: '合成',
          firstName: '新建',
          idCardNumber: '110101199001019999',
          tag: 'A',
        })
      ).status
    ).toBe(403);
    for (const body of [
      { lastName: '篡改' },
      { firstName: '篡改' },
      { idCardNumber: '110101199001019999' },
      { tag: 'B' },
    ]) {
      expect((await request(`/recipients/${recipients[0].id}`, 'a', 'PUT', body)).status).toBe(403);
    }
    const result = await request(`/recipients/${recipients[0].id}`, 'a', 'PUT', {
      notes: '普通备注允许修改',
    });
    expect(result.status).toBe(200);
    expect((await recipients[0].reload()).tag).toBe('A');
    expect(ids(await request('/orders?limit=100'))).toEqual(
      [0, 1, 2, 3, 6, 7, 9].map(index => orders[index].id)
    );
  });

  test('AOS渠道不能通过取机人档案改名，原始资料保持', async () => {
    const response = await request('/channels/A', 'admin', 'PUT', { newTag: '重命名' });
    expect(response.status).toBe(400);
    expect((await orders[0].reload()).sourceRecipientTag).toBe('A');
    expect((await recipients[0].reload()).tag).toBe('A');
  });

  test('付款规则候选包含仅AOS存在的TAG与已配置但无订单的旧值', async () => {
    const service = require('../src/services/paymentTagRuleService');
    await service.saveRule(
      null,
      {
        name: '旧配置',
        enabled: true,
        recipientTags: ['无订单旧TAG'],
        assigneeUserIds: [users.a.id],
      },
      users.admin.id
    );
    const response = await request('/payment-dispatch/tag-rules', 'admin');
    expect(response.status).toBe(200);
    expect(response.body.data.tagOptions).toEqual([' A ', 'A', 'a', '无订单旧TAG']);
    expect(response.body.data.tagOptions).not.toContain('LEGACY');
    expect(response.body.data.tagOptions).not.toContain('EMAIL');
    expect(response.body.data.tagOptions).not.toContain('B');
  });

  test('照片入口和库存来源按最终TAG授权，不信任旧关联且不调用真实OSS', async () => {
    const signer = jest
      .spyOn(require('../src/services/ossService'), 'createReadUrl')
      .mockReturnValue('https://example.invalid/synthetic-photo');
    const projection = require('../src/services/stockLedgerProjectionService');
    try {
      const photos = await request('/pickups');
      expect(photos.status).toBe(200);
      expect(photos.body.data.items.map(item => item.orderId).sort((a, b) => a - b)).toEqual(
        [0, 1, 2, 3, 6, 7, 9].map(index => orders[index].id)
      );
      expect(photos.body.data.items.every(item => item.tag === 'A')).toBe(true);
      for (const index of [0, 8]) {
        const record = await db.PickupRecord.create({ orderId: orders[index].id });
        const evidence = await db.PickupEvidence.create({
          pickupRecordId: record.id,
          kind: 'pickup',
          objectKey: `synthetic/photo-${index}.png`,
          originalName: 'photo.png',
          contentType: 'image/png',
          sizeBytes: 8,
        });
        const unit = await db.StockUnit.create({
          serialNumber: `TAGFALLBACK${index}`,
          originMode: 'legacy_binding',
        });
        await db.PickupDevice.create({
          stockUnitId: unit.id,
          orderId: orders[index].id,
          serialNumber: unit.serialNumber,
          serialBarcode: unit.serialNumber,
        });
        for (const actor of ['a', 'b']) {
          const allowed = index === 0 && actor === 'a';
          signer.mockClear();
          expect(
            (await request(`/pickups/${orders[index].id}/evidence/${evidence.id}`, actor)).status
          ).toBe(allowed ? 200 : 404);
          expect(signer).toHaveBeenCalledTimes(allowed ? 1 : 0);
          const ctx = {
            user: users[actor],
            permissions: new Set(['stock.read', 'stock.receive', 'orders.read']),
          };
          expect(
            (await projection.receivePreview(ctx, { serialNumber: unit.serialNumber })).unit
              .orderNumber
          ).toBe(allowed ? orders[index].orderNumber : null);
        }
        expect((await unit.reload()).state).toBe('registered');
        expect((await orders[index].reload()).recipientRef).toBe(
          index === 0 ? null : recipients[0].id
        );
      }
    } finally {
      signer.mockRestore();
    }
  });
});
