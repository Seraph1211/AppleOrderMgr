const crypto = require('crypto');
const enabled = process.env.RUN_ORDER_MAIL_LIFECYCLE_DB === 'true';

(enabled ? describe : describe.skip)('订单邮件生命周期隔离数据库事务回归', () => {
  let models;
  let lifecycle;
  let sequence = 3000000000;
  const verifier = () => ({
    results: [
      {
        signingDomain: 'orders.apple.com',
        selector: 'synthetic',
        algo: 'rsa-sha256',
        signatureTimeValid: true,
        status: { result: 'pass' },
      },
    ],
  });
  const config = {
    senderDomains: ['apple.com'],
    lifecycle: { parseEnabled: true, applyEnabled: true, paymentTaskApplyEnabled: true },
  };

  function mime(orderNumber, products, type = 'processing') {
    const title =
      type === 'ready'
        ? `关于你的 Apple 订单 ${orderNumber} 的更新信息`
        : type === 'personal_setup'
          ? '个人设置辅导，帮你上手新 iPhone。'
          : `我们正在处理你的订单 ${orderNumber}`;
    const lead =
      type === 'ready'
        ? '你的订单商品已可取货。'
        : type === 'personal_setup'
          ? `订单号 ${orderNumber}\n个人设置辅导`
          : '你的订单正在处理中。';
    if (type === 'personal_setup') products = [];
    const rows = products.flatMap(product => [
      product.name,
      type === 'ready' ? '取货日期： 星期日, 9月 20日, 2026' : '取货日期:',
      type === 'ready' ? '到店时间： 08:00 PM - 08:15 PM' : '签到时间: 16:00 - 16:15',
      `数量 ${product.quantity}`,
    ]);
    const pickupStoreRows =
      type === 'personal_setup'
        ? []
        : ['取货零售店:', 'Apple', '测试门店', '测试市测试路 1 号', '400000'];
    return Buffer.from(
      [
        'From: Apple <orders@orders.apple.com>',
        'To: archive@example.test',
        `Subject: ${title}`,
        'Date: Sun, 20 Sep 2026 01:00:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        lead,
        ...rows,
        ...pickupStoreRows,
      ].join('\r\n')
    );
  }

  async function archive(orderNumber, rawBuffer) {
    const message = await models.OrderMailMessage.create({
      id: crypto.randomUUID(),
      mailboxIdentityHash: 'a'.repeat(64),
      uidValidity: '1',
      emailUid: String(++sequence),
      orderNumber,
      mimeSha256: crypto.createHash('sha256').update(rawBuffer).digest('hex'),
      metadata: { subject: 'synthetic' },
      rawContent: rawBuffer.toString('base64'),
      emailDate: new Date('2026-09-20T01:00:00Z'),
      receivedAt: new Date('2026-09-20T01:00:05Z'),
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });
    await lifecycle.enqueueLifecycleJob(message.id);
    return message;
  }

  beforeAll(() => {
    if (
      !/^apple_order_mgr_mail_lifecycle_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('必须使用独立订单邮件生命周期测试库');
    process.env.FIELD_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
    models = require('../src/models');
    lifecycle = require('../src/services/orderMailLifecycleService');
  });

  beforeEach(async () => {
    await models.sequelize.query(
      'TRUNCATE order_mail_events, order_mail_processing_jobs, order_mail_messages, payment_task_events, payment_tasks, orders RESTART IDENTITY CASCADE'
    );
  });

  afterAll(async () => {
    await models?.sequelize.close();
  });

  test('已验证处理邮件原子更新独立状态并完成既有付款任务', async () => {
    const products = [{ name: 'iPhone 18 Pro Max 勃艮第酒红色 512G', quantity: 2 }];
    const order = await models.Order.create({
      orderNumber: `W${++sequence}`,
      products,
      orderDate: new Date('2026-09-20T00:30:00Z'),
    });
    const task = await models.PaymentTask.create({
      orderId: order.id,
      processingStatus: 'processing',
    });
    const message = await archive(
      order.orderNumber,
      mime(order.orderNumber, [
        { name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', quantity: 1 },
        { name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', quantity: 1 },
      ])
    );

    expect(await lifecycle.processNextLifecycleJob({ config, verifier })).toBe(true);
    await Promise.all([order.reload(), task.reload()]);
    expect(order).toMatchObject({
      emailOrderStatus: 'processing',
      emailPaymentStatus: 'paid',
      emailStatusNeedsReview: false,
    });
    expect(task.processingStatus).toBe('completed');
    expect(task.completedAt).toBeInstanceOf(Date);
    const firstCompletedAt = task.completedAt;
    expect(
      await models.PaymentTaskEvent.count({
        where: { paymentTaskId: task.id, eventType: 'mail_payment_confirmed' },
      })
    ).toBe(1);

    await models.OrderMailProcessingJob.update(
      { status: 'pending', notBefore: new Date(), completedAt: null },
      { where: { messageId: message.id } }
    );
    await lifecycle.processNextLifecycleJob({ config, verifier });
    await task.reload();
    expect(task.completedAt).toEqual(firstCompletedAt);
    expect(
      await models.PaymentTaskEvent.count({
        where: { paymentTaskId: task.id, eventType: 'mail_payment_confirmed' },
      })
    ).toBe(1);
  });

  test('邮件先到时等待订单，订单和任务创建后在同一事务补应用', async () => {
    const orderNumber = `W${++sequence}`;
    const products = [{ name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 }];
    await archive(orderNumber, mime(orderNumber, products, 'ready'));
    await lifecycle.processNextLifecycleJob({ config, verifier });
    expect(await models.OrderMailProcessingJob.count({ where: { status: 'waiting_order' } })).toBe(
      1
    );

    let order;
    let task;
    await models.sequelize.transaction(async transaction => {
      order = await models.Order.create({ orderNumber, products }, { transaction });
      task = await models.PaymentTask.create({ orderId: order.id }, { transaction });
      await lifecycle.applyWaitingOrderLifecycle(order, transaction, config);
    });
    await Promise.all([order.reload(), task.reload()]);
    expect(order.emailOrderStatus).toBe('ready_for_pickup');
    expect(order.emailPickupInfo).toMatchObject({
      storeName: 'Apple 测试门店',
      pickupDate: '2026-09-20',
      startTime: '20:00',
      endTime: '20:15',
    });
    expect(task.processingStatus).toBe('completed');
  });

  test('辅导邮件推定已取货，不改人工取货记录或实际取货时间', async () => {
    const order = await models.Order.create({
      orderNumber: `W${++sequence}`,
      products: [{ name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 }],
    });
    const task = await models.PaymentTask.create({ orderId: order.id });
    const pickup = await models.PickupRecord.create({ orderId: order.id, status: 'pending' });
    await archive(order.orderNumber, mime(order.orderNumber, [], 'personal_setup'));

    await lifecycle.processNextLifecycleJob({ config, verifier });
    await Promise.all([order.reload(), task.reload(), pickup.reload()]);

    expect(order).toMatchObject({
      emailOrderStatus: 'picked_up',
      emailPaymentStatus: 'paid',
      emailStatusNeedsReview: false,
    });
    expect(order.emailStatusEvidenceAt).toEqual(new Date('2026-09-20T01:00:00Z'));
    expect(task.processingStatus).toBe('completed');
    expect(pickup.status).toBe('pending');
    expect(pickup.pickedUpAt).toBeNull();
    const event = await models.OrderMailEvent.findOne({ where: { orderId: order.id } });
    expect(event).toMatchObject({
      templateType: 'personal_setup',
      orderStatus: 'picked_up',
      paymentStatus: 'paid',
      needsReview: false,
    });
    expect(event.evidence).toMatchObject({ productScope: 'not_required_personal_setup' });
  });

  test('部分商品范围进入待核对，不更新为已付款也不完成任务', async () => {
    const order = await models.Order.create({
      orderNumber: `W${++sequence}`,
      products: [
        { name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 },
        { name: 'iPhone 18 Pro Max 512GB 黑色', quantity: 1 },
      ],
    });
    const task = await models.PaymentTask.create({ orderId: order.id });
    await archive(
      order.orderNumber,
      mime(order.orderNumber, [{ name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 }], 'ready')
    );
    await lifecycle.processNextLifecycleJob({ config, verifier });
    await Promise.all([order.reload(), task.reload()]);
    expect(order.emailOrderStatus).toBe('unknown');
    expect(order.emailPaymentStatus).toBe('unknown');
    expect(order.emailStatusNeedsReview).toBe(true);
    expect(task.processingStatus).toBe('pending');
  });

  test('影子解析、订单应用和付款联动可分阶段继续同一任务', async () => {
    const order = await models.Order.create({
      orderNumber: `W${++sequence}`,
      products: [{ name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 }],
    });
    const task = await models.PaymentTask.create({ orderId: order.id });
    await archive(
      order.orderNumber,
      mime(order.orderNumber, [{ name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 }])
    );

    await lifecycle.processNextLifecycleJob({
      config: {
        ...config,
        lifecycle: { parseEnabled: true, applyEnabled: false, paymentTaskApplyEnabled: false },
      },
      verifier,
    });
    await order.reload();
    expect(order.emailPaymentStatus).toBe('unknown');
    expect(await models.OrderMailProcessingJob.count({ where: { status: 'parsed' } })).toBe(1);

    await lifecycle.processNextLifecycleJob({
      config: {
        ...config,
        lifecycle: { parseEnabled: true, applyEnabled: true, paymentTaskApplyEnabled: false },
      },
      verifier,
    });
    await Promise.all([order.reload(), task.reload()]);
    expect(order.emailPaymentStatus).toBe('paid');
    expect(task.processingStatus).toBe('pending');
    expect(
      await models.OrderMailProcessingJob.count({ where: { status: 'applied_pending_payment' } })
    ).toBe(1);

    await lifecycle.processNextLifecycleJob({ config, verifier });
    await task.reload();
    expect(task.processingStatus).toBe('completed');
    expect(await models.OrderMailProcessingJob.count({ where: { status: 'applied' } })).toBe(1);
  });

  test('人工核定追加事件并用邮件版本拒绝并发覆盖', async () => {
    const order = await models.Order.create({
      orderNumber: `W${++sequence}`,
      products: [{ name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 }],
    });
    const message = await archive(
      order.orderNumber,
      mime(order.orderNumber, [{ name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 }])
    );
    await lifecycle.processNextLifecycleJob({ config, verifier });
    await order.reload();
    const expectedVersion = order.emailStatusVersion;
    const user = await models.User.create({
      username: `mail_review_${sequence}_${crypto.randomBytes(4).toString('hex')}`,
      password: 'SyntheticOnlyPassword123!',
      role: 'admin',
    });
    const actor = {
      id: user.id,
      role: 'admin',
      permissions: ['orders.read', 'order_mail.manage'],
      orderAccess: { mode: 'all', tags: [] },
    };
    const first = await lifecycle.reviewLifecycleEvent(actor, order.id, message.id, {
      expectedVersion,
      reason: '依据关联官方处理邮件人工复核',
      orderStatus: 'processing',
      paymentStatus: 'paid',
    });
    expect(first).toMatchObject({ status: 'parsed', version: expectedVersion + 1 });
    expect(
      await models.OrderMailEvent.count({ where: { messageId: message.id, source: 'manual' } })
    ).toBe(1);
    await expect(
      lifecycle.reviewLifecycleEvent(actor, order.id, message.id, {
        expectedVersion,
        reason: '使用旧版本重复核定应被拒绝',
        orderStatus: 'processing',
        paymentStatus: 'paid',
      })
    ).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
  });

  test('按订单批量重放全部关联邮件并复用活动任务', async () => {
    const products = [{ name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 }];
    const orders = await Promise.all(
      [1, 2].map(() =>
        models.Order.create({
          orderNumber: `W${++sequence}`,
          products,
        })
      )
    );
    for (const order of orders) {
      await archive(order.orderNumber, mime(order.orderNumber, products));
    }
    const user = await models.User.create({
      username: `mail_batch_${sequence}_${crypto.randomBytes(4).toString('hex')}`,
      password: 'SyntheticOnlyPassword123!',
      role: 'admin',
    });
    const actor = {
      id: user.id,
      role: 'admin',
      permissions: ['orders.read', 'order_mail.manage'],
      orderAccess: { mode: 'all', tags: [] },
    };

    const first = await lifecycle.enqueueOrderReplay(
      actor,
      orders.map(order => order.id)
    );
    expect(first).toMatchObject({
      totals: { orders: 2, messages: 2, enqueued: 0, active: 2, withoutMail: 0 },
    });

    await models.OrderMailProcessingJob.update({ status: 'parsed' }, { where: {} });
    const second = await lifecycle.enqueueOrderReplay(
      actor,
      orders.map(order => order.id)
    );
    expect(second).toMatchObject({
      totals: { orders: 2, messages: 2, enqueued: 2, active: 0, withoutMail: 0 },
    });
    expect(
      await models.OrderMailProcessingJob.count({ where: { status: 'pending', attempts: 0 } })
    ).toBe(2);
    await expect(
      lifecycle.enqueueOrderReplay(
        { ...actor, permissions: ['orders.read'] },
        orders.map(order => order.id)
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test.each(['expired', 'cancelled'])('真实事务应用 %s 邮件且重复、旧邮件不回退', async status => {
    const products = [{ name: 'iPhone 18 Pro Max 512GB 冰川蓝色', quantity: 1 }];
    const order = await models.Order.create({
      orderNumber: `W${++sequence}`,
      products,
      emailOrderStatus: 'confirmed',
      orderDate: new Date('2026-09-20T00:30:00Z'),
    });
    const task = await models.PaymentTask.create({
      orderId: order.id,
      processingStatus: 'processing',
    });
    if (status === 'cancelled') await order.update({ products: [{ ...products[0], quantity: 2 }] });
    const label = status === 'expired' ? '已过期' : '已取消';
    const raw = Buffer.from(
      [
        'From: Apple <orders@orders.apple.com>',
        'To: archive@example.test',
        `Subject: 订单 ${order.orderNumber} ${label}。`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        `你的取货安排${label}。`,
        ...(status === 'expired'
          ? ['你未在限定的时间内取货。我们已取消你的订单，并正在为你办理退款。']
          : []),
        '我们正在为你办理退款。',
        '已取消的商品',
        products[0].name,
        '数量 1',
      ].join('\r\n')
    );
    await archive(order.orderNumber, raw);
    await lifecycle.processNextLifecycleJob({ config });
    await Promise.all([order.reload(), task.reload()]);
    expect(order).toMatchObject({
      emailOrderStatus: status === 'cancelled' ? 'partially_cancelled' : status,
      emailPaymentStatus: 'unknown',
      emailStatusNeedsReview: false,
    });
    expect(task.processingStatus).toBe('processing');
    expect(await models.PaymentTaskEvent.count()).toBe(0);
    await lifecycle.applyOrderLifecycle(order.id, null, config);
    await order.reload();
    expect(order.emailOrderStatus).toBe(status === 'cancelled' ? 'partially_cancelled' : status);
    if (status === 'cancelled') {
      await archive(order.orderNumber, Buffer.concat([raw, Buffer.from('\r\n')]));
      await lifecycle.processNextLifecycleJob({ config });
      await order.reload();
      expect(order.emailOrderStatus).toBe('cancelled');
    }
    // 迟到的旧付款邮件仅补全付款证据，不能撤销终态。
    await archive(order.orderNumber, mime(order.orderNumber, order.products));
    await lifecycle.processNextLifecycleJob({ config });
    await order.reload();
    expect(order).toMatchObject({ emailOrderStatus: status, emailPaymentStatus: 'paid' });
  });

  test('展示 SQL、分页筛选与 JavaScript 对各类状态使用相同口径', async () => {
    const {
      DISPLAY_ORDER_STATUS_SQL,
      getDisplayOrderStatus,
    } = require('../src/utils/orderDisplayStatus');
    const { buildListFilters } = require('../src/controllers/orderController');
    const cases = [
      ['confirmed', 'unknown', new Date(Date.now() - 31 * 60_000), 'payment_timeout'],
      ['confirmed', 'unknown', new Date(Date.now() - 29 * 60_000), 'confirmed'],
      ['confirmed', 'paid', new Date(Date.now() - 31 * 60_000), 'confirmed'],
      ['confirmed', 'unknown', null, 'confirmed'],
      ['expired', 'paid', new Date(Date.now() - 31 * 60_000), 'expired'],
      ['partially_cancelled', 'unknown', new Date(Date.now() - 31 * 60_000), 'partially_cancelled'],
      ['cancelled', 'unknown', new Date(Date.now() - 31 * 60_000), 'cancelled'],
    ];
    for (const [emailOrderStatus, emailPaymentStatus, orderDate, expected] of cases) {
      const order = await models.Order.create({
        orderNumber: `W${++sequence}`,
        products: [{ name: '合成测试商品', quantity: 1 }],
        emailOrderStatus,
        emailPaymentStatus,
        orderDate,
      });
      expect(getDisplayOrderStatus(order)).toBe(expected);
      const [rows] = await models.sequelize.query(
        `SELECT ${DISPLAY_ORDER_STATUS_SQL} AS status FROM orders AS "Order" WHERE id = :id`,
        { replacements: { id: order.id } }
      );
      expect(rows[0].status).toBe(expected);
    }
    for (const status of ['payment_timeout', 'partially_cancelled', 'expired', 'cancelled']) {
      const { where } = buildListFilters({ displayOrderStatuses: JSON.stringify([status]) });
      const result = await models.Order.findAndCountAll({ where, limit: 1 });
      expect(result.count).toBe(1);
      expect(getDisplayOrderStatus(result.rows[0])).toBe(status);
    }
  });

  test('终态 Migration 支持空库 down/up 且拒绝丢失已应用终态', async () => {
    const migration = require('../migrations/20260928000001-add-mail-terminal-order-statuses');
    const Sequelize = require('sequelize');
    const queryInterface = models.sequelize.getQueryInterface();
    await migration.down(queryInterface, Sequelize);
    await expect(
      models.Order.create({
        orderNumber: `W${++sequence}`,
        products: [{ name: '合成测试商品', quantity: 1 }],
        emailOrderStatus: 'expired',
      })
    ).rejects.toMatchObject({ original: { constraint: 'orders_email_order_status_valid' } });
    await migration.up(queryInterface, Sequelize);
    const order = await models.Order.create({
      orderNumber: `W${++sequence}`,
      products: [{ name: '合成测试商品', quantity: 1 }],
      emailOrderStatus: 'expired',
    });
    await expect(migration.down(queryInterface, Sequelize)).rejects.toThrow('不得丢失已有终态');
    await order.reload();
    expect(order.emailOrderStatus).toBe('expired');
    await order.update({ emailOrderStatus: 'partially_cancelled' });
    await expect(migration.down(queryInterface, Sequelize)).rejects.toThrow('不得丢失已有终态');
    await order.update({ emailOrderStatus: 'cancelled' });
    await expect(migration.down(queryInterface, Sequelize)).rejects.toThrow('不得丢失已有终态');
  });
});
