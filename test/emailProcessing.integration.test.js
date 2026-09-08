const { Op } = require('sequelize');

const enabled = process.env.RUN_EMAIL_DB_INTEGRATION === 'true';
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('邮件处理隔离 PostgreSQL 集成', () => {
  const models = require('../src/models');
  const emailProcessingService = require('../src/services/emailProcessingService');
  const { EMAIL_ERROR_CODES } = require('../src/services/emailErrors');
  const { saveOrderFromEmail } = require('../src/services/orderService');
  const { buildHtmlBody, buildMime } = require('./fixtures/emailMessages');
  const { sequelize, EmailLog, EmailWorkerState, Order, OrderRefreshSchedule, OrderRefreshJob } =
    models;
  const orderNumbers = ['W9700000001', 'W9700000002', 'W9700000003', 'W9700000004'];

  async function cleanSyntheticRows() {
    await EmailLog.destroy({ where: { emailUid: { [Op.like]: 'it-email-%' } }, force: true });
    await Order.destroy({ where: { orderNumber: { [Op.in]: orderNumbers } }, force: true });
    await EmailWorkerState.destroy({ where: { id: 1 }, force: true });
  }

  function validOrderData(orderNumber) {
    return {
      appleId: 'integration@example.com',
      applePassword: 'integration-only-password',
      orderNumber,
      orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/integration`,
      orderDate: new Date('2026-09-07T02:00:00.000Z'),
      products: [{ model: 'TEST/CH', name: '集成测试商品', quantity: 1, image: null }],
      recipient: {
        name: '测试员',
        idLast4: '123X',
        idCard: '110101199001011234',
        tag: '集成测试',
      },
      paymentMethod: '测试付款',
      orderStatus: 'pending',
      emailSubject: '集成测试邮件',
      emailFrom: 'integration@example.com',
      emailDate: new Date('2026-09-07T02:00:00.000Z'),
      rawContent: Buffer.from('integration mime').toString('base64'),
    };
  }

  function createProcessableLog(emailUid, orderNumber) {
    return EmailLog.create({
      emailUid,
      mailboxIdentityHash: 'a'.repeat(64),
      uidValidity: '970',
      status: 'manual_review',
      rawContent: Buffer.from('integration mime').toString('base64'),
      orderNumber,
      receivedAt: new Date(),
      retentionExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
      imapAckStatus: 'pending',
    });
  }

  beforeAll(async () => {
    await sequelize.authenticate();
    await cleanSyntheticRows();
  });

  afterAll(async () => {
    await cleanSyntheticRows();
    await sequelize.close();
  });

  test('复合 IMAP 身份幂等且 UIDVALIDITY 变化产生新记录', async () => {
    const input = {
      mailboxIdentity: { host: 'imap.example.com', user: 'it@example.com', mailbox: 'INBOX' },
      uidValidity: '100',
      emailUid: 'it-email-uid-1',
      rawBuffer: Buffer.from('same mime'),
    };
    const first = await emailProcessingService.receiveEmail(input);
    const repeated = await emailProcessingService.receiveEmail(input);
    const newUidValidity = await emailProcessingService.receiveEmail({
      ...input,
      uidValidity: '101',
    });

    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.record.id).toBe(first.record.id);
    expect(newUidValidity.created).toBe(true);
    expect(newUidValidity.record.id).not.toBe(first.record.id);
  });

  test('同 Message-ID 或 MIME 的再次投递保留为 superseded', async () => {
    const mailboxIdentity = {
      host: 'imap.example.com',
      user: 'it-duplicate@example.com',
      mailbox: 'INBOX',
    };
    const first = (
      await emailProcessingService.receiveEmail({
        mailboxIdentity,
        uidValidity: '200',
        emailUid: 'it-email-duplicate-1',
        rawBuffer: Buffer.from('duplicate mime'),
      })
    ).record;
    await emailProcessingService.registerMetadata(first, {
      subject: '订单',
      from: 'sender@example.com',
      date: new Date(),
      messageId: '<integration-duplicate@example.com>',
    });
    first.status = 'manual_review';
    await first.save();

    const second = (
      await emailProcessingService.receiveEmail({
        mailboxIdentity,
        uidValidity: '200',
        emailUid: 'it-email-duplicate-2',
        rawBuffer: Buffer.from('duplicate mime'),
      })
    ).record;
    const duplicate = await emailProcessingService.registerMetadata(second, {
      subject: '订单',
      from: 'sender@example.com',
      date: new Date(),
      messageId: '<integration-duplicate@example.com>',
    });

    expect(duplicate.id).toBe(first.id);
    expect(second.status).toBe('superseded');
    expect(second.errorCode).toBe('DUPLICATE_EVENT');
  });

  test('多 Worker 并发只领取一次到期重试', async () => {
    const record = await createProcessableLog('it-email-retry-1', null);
    record.status = 'retry_wait';
    record.nextRetryAt = new Date(Date.now() - 1_000);
    await record.save();

    const [firstClaim, secondClaim] = await Promise.all([
      emailProcessingService.claimDueRetries(1),
      emailProcessingService.claimDueRetries(1),
    ]);
    const claimedIds = [...firstClaim, ...secondClaim].map(item => item.id);

    expect(claimedIds).toEqual([record.id]);
  });

  test('Worker 中断状态恢复到持久化重试并保留审计', async () => {
    const record = await createProcessableLog('it-email-interrupted-1', null);
    record.status = 'processing';
    record.lastAttemptAt = new Date(Date.now() - 10 * 60_000);
    await record.save();

    expect(await emailProcessingService.recoverInterruptedRecords()).toBe(1);
    await record.reload();
    expect(record.status).toBe('retry_wait');
    expect(record.errorCode).toBe('WORKER_INTERRUPTED');
    expect(record.attemptHistory.at(-1).event).toBe('attempt_interrupted');
  });

  test('临时错误持久化重试而永久错误直接转人工', async () => {
    const temporary = await createProcessableLog('it-email-temporary-1', null);
    temporary.status = 'received';
    await temporary.save();
    const connectionError = Object.assign(new Error('synthetic'), {
      name: 'SequelizeConnectionError',
    });
    await emailProcessingService.markFailure(temporary, connectionError);
    await temporary.reload();
    expect(temporary.status).toBe('retry_wait');
    expect(temporary.nextRetryAt).toBeInstanceOf(Date);

    const permanent = await createProcessableLog('it-email-permanent-1', null);
    const result = await emailProcessingService.processPersistedRecord(permanent, {
      rawBuffer: Buffer.from('From: sender@example.com\r\nSubject: NULL\r\n\r\n未知正文'),
    });
    expect(result.status).toBe('manual_review');
    expect(result.record.errorCode).toBe('APPLE_ID_INVALID');
  });

  test('自动非订单只保留最小元数据', async () => {
    const record = await createProcessableLog('it-email-ignored-1', null);
    record.emailSubject = '普通邮件完整主题';
    record.emailFrom = 'person@example.com';
    record.messageId = '<ignored@example.com>';
    record.authenticationResults = 'dkim=pass';
    record.mimeSha256 = 'b'.repeat(64);
    await record.save();

    await emailProcessingService.rejectSourceEmail(record, EMAIL_ERROR_CODES.SUBJECT_NOT_ALLOWED);
    await record.reload();
    expect(record.status).toBe('ignored');
    expect(record.errorCode).toBe('SUBJECT_NOT_ALLOWED');
    expect(record.resolutionReason).toBe('subject_not_allowed');
    expect(record.rawContent).toBeNull();
    expect(record.emailSubject).toBeNull();
    expect(record.emailFrom).toBeNull();
    expect(record.messageId).toBeNull();
    expect(record.authenticationResults).toBeNull();
  });

  test('主题匹配但发件人未授权时保留加密原文供人工恢复', async () => {
    const record = await createProcessableLog('it-email-sender-rejected-1', null);
    record.status = 'received';
    record.processed = false;
    record.emailSubject = 'NULL预订助手提交预订成功通知';
    record.emailFrom = 'dynamic@untrusted.example';
    await record.save();

    await emailProcessingService.rejectSourceEmail(record, EMAIL_ERROR_CODES.SENDER_NOT_ALLOWED);
    await record.reload();

    expect(record.status).toBe('manual_review');
    expect(record.errorCode).toBe('SENDER_NOT_ALLOWED');
    expect(record.errorMessage).toBe('发件人不在允许范围');
    expect(record.rawContent).not.toBeNull();
    expect(record.emailSubject).toBe('NULL预订助手提交预订成功通知');
    expect(record.emailFrom).toBe('dynamic@untrusted.example');
  });

  test('人工草稿支持完整敏感字段、乐观锁、入库和操作审计', async () => {
    const record = await createProcessableLog('it-email-manual-1', orderNumbers[2]);
    const draft = validOrderData(orderNumbers[2]);
    const saved = await emailProcessingService.saveManualDraft(record, draft, record.version);
    expect(saved.manualDraft.applePassword).toBe('integration-only-password');
    expect(saved.manualDraft.recipient.idCard).toBe('110101199001011234');
    await expect(
      emailProcessingService.saveManualDraft(record, draft, record.version)
    ).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });

    await emailProcessingService.recordAuditAction(record.id, 'save_manual_draft', 7, {
      result: 'succeeded',
    });
    const order = await emailProcessingService.ingestManualDraft(
      record,
      draft,
      saved.version,
      null
    );
    await record.reload();
    expect(order.orderNumber).toBe(orderNumbers[2]);
    expect(record.status).toBe('succeeded');
    expect(record.auditHistory).toEqual([
      expect.objectContaining({ action: 'save_manual_draft', userId: 7 }),
    ]);

    const duplicate = await createProcessableLog('it-email-existing-1', orderNumbers[2]);
    await emailProcessingService.resolveRecord(
      duplicate,
      {
        resolutionType: 'existing_order',
        reason: '集成测试关联已有订单',
        orderNumber: orderNumbers[2],
        version: duplicate.version,
      },
      null
    );
    await duplicate.reload();
    expect(duplicate.status).toBe('superseded');
    expect(duplicate.orderId).toBe(order.id);
  });

  test('当前解析器预览不建单，自动处理成功后创建订单', async () => {
    const rawMime = buildMime({
      body: buildHtmlBody({
        appleId: 'automatic@example.com',
        orderNumber: orderNumbers[3],
        products: 'AUTO/CH-自动入库商品 x 1',
        recipient: '自动员',
        tag: '自动测试',
      }),
    });
    const previewRecord = await createProcessableLog('it-email-preview-1', null);
    previewRecord.rawContent = Buffer.from(rawMime).toString('base64');
    await previewRecord.save();
    const preview = await emailProcessingService.reparsePreview(previewRecord);
    expect(preview.orderNumber).toBe(orderNumbers[3]);
    expect(await Order.count({ where: { orderNumber: orderNumbers[3] } })).toBe(0);

    const automatic = (
      await emailProcessingService.receiveEmail({
        mailboxIdentity: {
          host: 'imap.example.com',
          user: 'it-automatic@example.com',
          mailbox: 'INBOX',
        },
        uidValidity: '400',
        emailUid: 'it-email-automatic-1',
        rawBuffer: Buffer.from(rawMime),
      })
    ).record;
    const result = await emailProcessingService.processPersistedRecord(automatic);
    expect(result.status).toBe('succeeded');
    expect(result.order.orderNumber).toBe(orderNumbers[3]);
  });

  test('180 天清理只移除内容并保留状态和操作审计', async () => {
    const record = await createProcessableLog('it-email-retention-1', null);
    record.parsedData = { orderNumber: 'W9700000099' };
    record.manualDraft = { applePassword: 'synthetic' };
    record.finalData = { recipient: { idCard: '110101199001011234' } };
    record.auditHistory = [{ action: 'view_full_detail', userId: 7 }];
    record.retentionExpiresAt = new Date(Date.now() - 1_000);
    await record.save();

    expect(await emailProcessingService.purgeExpiredContent()).toBeGreaterThanOrEqual(1);
    await record.reload();
    expect(record.rawContent).toBeNull();
    expect(record.parsedData).toBeNull();
    expect(record.manualDraft).toBeNull();
    expect(record.finalData).toBeNull();
    expect(record.auditHistory).toEqual([{ action: 'view_full_detail', userId: 7 }]);
  });

  test('Worker 指标并发累计失败且成功后归零', async () => {
    await Promise.all([
      emailProcessingService.updateWorkerState({ errorCode: 'IMAP_TEMPORARY' }),
      emailProcessingService.updateWorkerState({ errorCode: 'DATABASE_TEMPORARY' }),
    ]);
    let state = await EmailWorkerState.findByPk(1);
    expect(state.consecutiveFailures).toBe(2);

    await emailProcessingService.updateWorkerState({ isConnected: true, succeeded: true });
    state = await EmailWorkerState.findByPk(1);
    expect(state.consecutiveFailures).toBe(0);
    const metrics = await emailProcessingService.getMetrics();
    expect(metrics.worker.isConnected).toBe(true);
    expect(metrics.worker.isRunning).toBe(true);
  });

  test('相同订单并发处理只创建一单和一个首次刷新任务', async () => {
    const firstLog = await createProcessableLog('it-email-order-1', orderNumbers[0]);
    const secondLog = await createProcessableLog('it-email-order-2', orderNumbers[0]);
    const orderData = validOrderData(orderNumbers[0]);

    const [firstOrder, secondOrder] = await Promise.all([
      saveOrderFromEmail(orderData, firstLog.emailUid, { emailLogId: firstLog.id }),
      saveOrderFromEmail(orderData, secondLog.emailUid, { emailLogId: secondLog.id }),
    ]);

    expect(firstOrder.id).toBe(secondOrder.id);
    expect(await Order.count({ where: { orderNumber: orderNumbers[0] } })).toBe(1);
    expect(await OrderRefreshSchedule.count({ where: { orderId: firstOrder.id } })).toBe(1);
    expect(await OrderRefreshJob.count({ where: { orderId: firstOrder.id } })).toBe(1);
    const statuses = await EmailLog.findAll({
      where: { id: [firstLog.id, secondLog.id] },
      attributes: ['status'],
      raw: true,
    });
    expect(statuses.map(item => item.status).sort()).toEqual(['succeeded', 'superseded']);
  });

  test('首次刷新任务写入失败时订单和邮件状态全部回滚', async () => {
    const emailLog = await createProcessableLog('it-email-rollback-1', orderNumbers[1]);
    const createJob = jest
      .spyOn(OrderRefreshJob, 'create')
      .mockRejectedValueOnce(new Error('boom'));

    await expect(
      saveOrderFromEmail(validOrderData(orderNumbers[1]), emailLog.emailUid, {
        emailLogId: emailLog.id,
      })
    ).rejects.toThrow('boom');
    createJob.mockRestore();

    expect(await Order.count({ where: { orderNumber: orderNumbers[1] } })).toBe(0);
    await emailLog.reload();
    expect(emailLog.status).toBe('manual_review');
    expect(emailLog.orderId).toBeNull();
  });
});
