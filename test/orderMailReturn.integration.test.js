const crypto = require('crypto');
const enabled = process.env.RUN_ORDER_MAIL_LIFECYCLE_DB === 'true';
(enabled ? describe : describe.skip)('退货定向回放事务与字段保护', () => {
  let models;
  let lifecycle;
  let sequence = 5000000000;
  const name = 'iPhone 18 Pro Max 1TB 冰川蓝色';
  const config = {
    lifecycle: { parseEnabled: true, applyEnabled: true, paymentTaskApplyEnabled: true },
  };
  beforeAll(() => {
    if (!/^apple_order_mgr_mail_lifecycle_test_\d+$/.test(process.env.DB_NAME || ''))
      throw new Error('需要隔离库');
    models = require('../src/models');
    lifecycle = require('../src/services/orderMailLifecycleService');
    process.env.ORDER_MAIL_LIFECYCLE_APPLY_ENABLED = 'true';
    process.env.ORDER_MAIL_PAYMENT_TASK_APPLY_ENABLED = 'true';
  });
  beforeEach(async () => {
    await models.sequelize.query(
      'TRUNCATE order_mail_events, order_mail_processing_jobs, order_mail_messages, payment_task_events, payment_tasks, orders RESTART IDENTITY CASCADE'
    );
  });
  afterAll(async () => {
    await models?.sequelize.close();
  });
  async function setup() {
    const order = await models.Order.create({
      orderNumber: `W${++sequence}`,
      products: [{ name, quantity: 2 }],
      emailOrderStatus: 'picked_up',
      emailPaymentStatus: 'unknown',
      emailPickupDate: '2026-09-20',
    });
    const task = await models.PaymentTask.create({
      orderId: order.id,
      processingStatus: 'processing',
    });
    const messages = [];
    for (const request of ['TEST1234567', 'TEST1234568']) {
      const raw = Buffer.from(
        [
          'From: Apple <orders@orders.apple.com>',
          'To: archive@example.test',
          'Subject: 我们已经收到您的退货申请。',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          '我们已收到您的退货申请',
          `退货号：${request}`,
          order.orderNumber,
          '要退回的商品',
          name,
          '数量 1',
          '总计',
        ].join('\r\n')
      );
      const message = await models.OrderMailMessage.create({
        id: crypto.randomUUID(),
        mailboxIdentityHash: 'a'.repeat(64),
        uidValidity: '1',
        emailUid: String(++sequence),
        orderNumber: order.orderNumber,
        mimeSha256: crypto.createHash('sha256').update(raw).digest('hex'),
        metadata: { subject: 'synthetic' },
        rawContent: raw.toString('base64'),
        emailDate: new Date('2026-10-10T01:00:00Z'),
        expiresAt: new Date('2027-01-01'),
      });
      await lifecycle.enqueueLifecycleJob(message.id);
      messages.push(message);
    }
    return { order, task, messages };
  }
  test('预览不写事件，应用只改许可字段；重复回放不累加', async () => {
    const { order, task, messages } = await setup();
    const before = order.toJSON();
    const taskBefore = task.toJSON();
    const ids = messages.map(message => message.id);
    const preview = await lifecycle.replayReturnMailMessages({ messageIds: ids });
    expect(preview.results[0]).toMatchObject({
      beforeStatus: 'picked_up',
      afterStatus: 'return_requested',
      needsReview: false,
    });
    expect(await models.OrderMailEvent.count()).toBe(0);
    const applied = await lifecycle.replayReturnMailMessages({
      messageIds: ids,
      apply: true,
      expectedVersions: { [order.id]: 0 },
    });
    expect(applied.results[0].afterStatus).toBe('return_requested');
    await order.reload();
    await task.reload();
    const allowed = new Set([
      'emailOrderStatus',
      'emailStatusNeedsReview',
      'emailStatusReviewReasons',
      'emailStatusVersion',
      'emailStatusEvidenceAt',
      'emailLifecycleUpdatedAt',
      'updatedAt',
    ]);
    for (const key of Object.keys(before))
      if (!allowed.has(key)) expect(order.toJSON()[key]).toEqual(before[key]);
    expect(task.toJSON()).toEqual(taskBefore);
    expect(await models.PaymentTaskEvent.count()).toBe(0);
    await expect(
      lifecycle.replayReturnMailMessages({
        messageIds: ids,
        apply: true,
        expectedVersions: { [order.id]: 0 },
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    await lifecycle.replayReturnMailMessages({
      messageIds: ids,
      apply: true,
      expectedVersions: { [order.id]: 1 },
    });
    await order.reload();
    expect(order.emailOrderStatus).toBe('return_requested');
    expect(await models.OrderMailEvent.count()).toBe(4);
  });
  test('worker并发两封归并全部退货，不更新付款任务', async () => {
    const { order, task } = await setup();
    await Promise.all([
      lifecycle.processNextLifecycleJob({ config }),
      lifecycle.processNextLifecycleJob({ config }),
    ]);
    await order.reload();
    await task.reload();
    expect(order.emailOrderStatus).toBe('return_requested');
    expect(order.emailPaymentStatus).toBe('unknown');
    expect(task.processingStatus).toBe('processing');
  });
  test('迁移down拒绝丢失已应用退货状态，回滚up仍接受', async () => {
    const { order, messages } = await setup();
    await lifecycle.replayReturnMailMessages({
      messageIds: messages.map(message => message.id),
      apply: true,
      expectedVersions: { [order.id]: 0 },
    });
    const migration = require('../migrations/20261010000001-add-mail-return-statuses');
    await expect(
      migration.down(models.sequelize.getQueryInterface(), require('sequelize'))
    ).rejects.toThrow('不得丢失');
    await order.reload();
    expect(order.emailOrderStatus).toBe('return_requested');
  });
});
