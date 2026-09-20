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
        : `我们正在处理你的订单 ${orderNumber}`;
    const lead = type === 'ready' ? '你的订单商品已可取货。' : '你的订单正在处理中。';
    const rows = products.flatMap(product => [
      product.name,
      type === 'ready' ? '取货日期： 星期日, 9月 20日, 2026' : '取货日期:',
      type === 'ready' ? '到店时间： 08:00 PM - 08:15 PM' : '签到时间: 16:00 - 16:15',
      `数量 ${product.quantity}`,
    ]);
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
        '取货零售店:',
        'Apple',
        '测试门店',
        '测试市测试路 1 号',
        '400000',
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
      username: `mail_review_${sequence}`,
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
      username: `mail_batch_${sequence}`,
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
});
