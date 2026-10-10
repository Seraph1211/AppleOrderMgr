const enabled = process.env.RUN_RETURN_INDEPENDENT_QA === 'true';

(enabled ? describe : describe.skip)('邮件退货独立 PostgreSQL 验收', () => {
  let models;
  let service;
  let lifecycle;
  let sequence = 7100000000;
  const productName = 'iPhone 18 Pro Max 1TB 冰川蓝色';
  const identity = { mailboxIdentityHash: 'e'.repeat(64), uidValidity: '101' };
  const config = {
    identity: identity.mailboxIdentityHash,
    senderDomains: ['apple.com'],
    lifecycle: { parseEnabled: true, applyEnabled: true, paymentTaskApplyEnabled: true },
  };

  function mime(orderNumber, requestNumber, quantities = [1], extra = {}) {
    return Buffer.from(
      [
        'From: Apple <order_acknowledgment@orders.apple.com>',
        'To: synthetic@example.invalid',
        `Message-ID: <${++sequence}@example.invalid>`,
        'Subject: 我们已经收到您的退货申请。',
        `Date: ${extra.date || 'Sat, 10 Oct 2026 05:55:45 +0000'}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '我们已收到您的退货申请。',
        `订单号：${orderNumber}`,
        ...(requestNumber ? ['退货号', requestNumber] : []),
        '要退回的商品',
        ...quantities.flatMap(quantity => [
          extra.name || productName,
          'RMB 16,499.00',
          `数量 ${quantity}`,
        ]),
        '总计',
        'RMB 32,998.00',
        ...(requestNumber ? ['退货号：', requestNumber] : []),
        ...(extra.tail || []),
      ].join('\r\n')
    );
  }

  async function order(values = {}) {
    return await models.Order.create({
      orderNumber: `W${++sequence}`,
      products: [{ name: productName, quantity: 2 }],
      emailOrderStatus: 'picked_up',
      emailPaymentStatus: 'paid',
      pickedUpAt: new Date('2026-09-30T00:00:00Z'),
      emailPickupDate: '2026-09-30',
      emailPickupInfo: { storeName: 'Apple 合成门店' },
      notes: '独立测试保护原备注',
      ...values,
    });
  }

  async function receive(record, request, quantities, extra) {
    const rawBuffer = mime(record.orderNumber, request, quantities, extra);
    await service.receiveOrderMail(
      { rawBuffer, emailUid: ++sequence, receivedAt: new Date() },
      identity,
      config
    );
    return models.OrderMailMessage.findOne({
      where: { orderNumber: record.orderNumber },
      order: [['createdAt', 'DESC']],
    });
  }

  async function processOne(record) {
    expect(await lifecycle.processNextLifecycleJob({ config })).toBe(true);
    await record.reload();
  }

  function protectedFields(record) {
    const copy = record.toJSON();
    for (const key of [
      'emailOrderStatus',
      'emailStatusVersion',
      'emailStatusNeedsReview',
      'emailStatusReviewReasons',
      'emailStatusEvidenceAt',
      'emailLifecycleUpdatedAt',
      'updatedAt',
    ])
      delete copy[key];
    return copy;
  }

  beforeAll(() => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_mail_lifecycle_test_2026101002' ||
      process.env.DATABASE_URL
    ) {
      throw new Error('独立退货验收仅允许指定专用测试库');
    }
    models = require('../src/models');
    service = require('../src/services/orderMailService');
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

  test('真实模板结构一封两行各1台为全退，归档自动入队且不改付款/取货/官网等字段', async () => {
    const record = await order();
    const task = await models.PaymentTask.create({
      orderId: record.id,
      processingStatus: 'processing',
      processingNotes: '不得完成',
    });
    const before = protectedFields(record);
    const taskBefore = task.toJSON();
    await receive(record, 'RS100000001', [1, 1]);
    expect(await models.OrderMailProcessingJob.count()).toBe(1);
    await processOne(record);
    expect(record.emailOrderStatus).toBe('return_requested');
    expect(record.emailStatusNeedsReview).toBe(false);
    expect(protectedFields(record)).toEqual(before);
    await task.reload();
    expect(task.toJSON()).toEqual(taskBefore);
    expect(await models.PaymentTaskEvent.count()).toBe(0);
  });

  test('不同退货号跨日各1台逐步累计；早发晚到仍全退', async () => {
    const record = await order();
    await receive(record, 'RS100000002', [1]);
    await processOne(record);
    expect(record.emailOrderStatus).toBe('partially_return_requested');
    await receive(record, 'RS100000003', [1], { date: 'Fri, 09 Oct 2026 05:55:45 +0000' });
    await processOne(record);
    expect(record.emailOrderStatus).toBe('return_requested');
    expect(record.emailStatusNeedsReview).toBe(false);
  });

  test('不同Message-ID同退货号通知及同封重放都不重复累计', async () => {
    const record = await order();
    const message = await receive(record, 'RS100000004', [1]);
    await processOne(record);
    await receive(record, 'RS100000004', [1]);
    await processOne(record);
    await models.OrderMailProcessingJob.update(
      { status: 'pending', notBefore: new Date() },
      { where: { messageId: message.id } }
    );
    await processOne(record);
    expect(record.emailOrderStatus).toBe('partially_return_requested');
    expect(record.emailStatusNeedsReview).toBe(false);
  });

  test('两个Worker并发领取不同申请不丢失累计', async () => {
    const record = await order();
    await receive(record, 'RS100000005', [1]);
    await receive(record, 'RS100000006', [1]);
    expect(
      await Promise.all([
        lifecycle.processNextLifecycleJob({ config }),
        lifecycle.processNextLifecycleJob({ config }),
      ])
    ).toEqual([true, true]);
    await record.reload();
    expect(record.emailOrderStatus).toBe('return_requested');
    expect(await models.OrderMailProcessingJob.count({ where: { status: 'applied' } })).toBe(2);
  });

  test.each([
    ['缺少退货号', null, [1], {}, 'RETURN_NUMBER_AMBIGUOUS'],
    ['非法数量', 'RS100000008', ['?'], {}, 'RETURN_QUANTITY_INVALID'],
    ['超过整单数量', 'RS100000009', [3], {}, 'RETURN_PRODUCT_SCOPE_MISMATCH'],
    [
      '不同商品',
      'RS100000010',
      [1],
      { name: 'iPhone 18 Pro Max 512GB 银色' },
      'RETURN_PRODUCT_SCOPE_MISMATCH',
    ],
  ])('%s待核对，保留原状态', async (_label, request, quantities, extra, reason) => {
    const record = await order();
    await receive(record, request, quantities, extra);
    await processOne(record);
    expect(record.emailOrderStatus).toBe('picked_up');
    expect(record.emailStatusNeedsReview).toBe(true);
    expect(record.emailStatusReviewReasons).toContain(reason);
  });

  test('同退货号1变2产生冲突，不提升已确认部分退货', async () => {
    const record = await order();
    await receive(record, 'RS100000011', [1]);
    await processOne(record);
    await receive(record, 'RS100000011', [2]);
    await processOne(record);
    expect(record.emailOrderStatus).toBe('partially_return_requested');
    expect(record.emailStatusReviewReasons).toContain('RETURN_REQUEST_CONFLICT');
  });

  test('新退货状态的 SQL 分页筛选、邮件原状态筛选和展示一致', async () => {
    const { buildListFilters } = require('../src/controllers/orderController');
    const { getDisplayOrderStatus } = require('../src/utils/orderDisplayStatus');
    for (const status of ['partially_return_requested', 'return_requested']) {
      await order({ emailOrderStatus: status });
    }
    for (const status of ['partially_return_requested', 'return_requested']) {
      const { where } = buildListFilters({
        displayOrderStatuses: JSON.stringify([status]),
        emailOrderStatuses: JSON.stringify([status]),
      });
      const result = await models.Order.findAndCountAll({ where, limit: 1 });
      expect(result.count).toBe(1);
      expect(getDisplayOrderStatus(result.rows[0])).toBe(status);
    }
    const { where } = buildListFilters({
      displayOrderStatuses: JSON.stringify(['partially_return_requested', 'return_requested']),
    });
    expect((await models.Order.findAndCountAll({ where, limit: 1 })).count).toBe(2);
  });

  test('正式 Migration 空库 down/up、全部旧新值与非法值拒绝、已应用新值拒绝 down', async () => {
    const migration = require('../migrations/20261010000001-add-mail-return-statuses');
    const Sequelize = require('sequelize');
    const queryInterface = models.sequelize.getQueryInterface();
    try {
      await migration.down(queryInterface, Sequelize);
      const record = await order();
      await expect(
        models.sequelize.query(
          "UPDATE orders SET email_order_status = 'return_requested' WHERE id = :id",
          { replacements: { id: record.id } }
        )
      ).rejects.toThrow();
      await migration.up(queryInterface, Sequelize);
      for (const status of [
        'unknown',
        'confirmed',
        'processing',
        'ready_for_pickup',
        'picked_up',
        'partially_cancelled',
        'cancelled',
        'expired',
        'partially_return_requested',
        'return_requested',
      ]) {
        await record.update({ emailOrderStatus: status });
        await record.reload();
        expect(record.emailOrderStatus).toBe(status);
      }
      await expect(
        models.sequelize.query(
          "UPDATE orders SET email_order_status = 'invalid_status' WHERE id = :id",
          { replacements: { id: record.id } }
        )
      ).rejects.toThrow();
      await expect(migration.down(queryInterface, Sequelize)).rejects.toThrow('不得丢失');
      await record.reload();
      expect(record.emailOrderStatus).toBe('return_requested');
    } finally {
      await migration.up(queryInterface, Sequelize);
    }
  });

  test.each(['cancelled', 'expired', 'partially_cancelled'])(
    '与%s终态矛盾保持旧状态并显式待核对',
    async status => {
      const record = await order({ emailOrderStatus: status });
      await receive(record, 'RS100000012', [2]);
      await processOne(record);
      expect(record.emailOrderStatus).toBe(status);
      expect(record.emailStatusReviewReasons).toContain('RETURN_TERMINAL_CONFLICT');
    }
  );
});
