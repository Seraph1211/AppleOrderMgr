const enabled = process.env.RUN_EMAIL_DB_INTEGRATION === 'true';
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('邮件扫描进度隔离 PostgreSQL 验证', () => {
  const {
    sequelize,
    Sequelize,
    EmailMailboxCursor,
    EmailWorkerState,
    EmailLog,
  } = require('../src/models');
  const progress = require('../src/services/emailScanProgress');
  const processing = require('../src/services/emailProcessingService');
  const migration = require('../migrations/20260909000001-add-email-scan-progress');
  const identity = { mailboxIdentityHash: 'b'.repeat(64), uidValidity: '123' };

  beforeAll(async () => {
    if (!/^test_email_scan_/.test(process.env.DB_NAME || ''))
      throw new Error('必须使用专用扫描测试库');
    await sequelize.authenticate();
    await EmailLog.destroy({ where: { emailUid: 'scan-recovery-1' }, force: true });
  });
  afterAll(async () => {
    await sequelize.close();
  });

  test('正式迁移 down/up 可往返，历史邮件表不受影响', async () => {
    const before = await EmailLog.count();
    await migration.down(sequelize.getQueryInterface());
    await migration.up(sequelize.getQueryInterface(), Sequelize);
    expect(await EmailLog.count()).toBe(before);
    expect(await EmailMailboxCursor.count()).toBe(0);
  });

  test('首次起点持久化且重载不滑动，并发首次加载唯一', async () => {
    const [first, repeated] = await Promise.all([
      progress.loadCursor(identity),
      progress.loadCursor(identity),
    ]);
    expect(first.lastUid).toBeNull();
    expect(repeated.bootstrapSince).toEqual(first.bootstrapSince);
    expect(await EmailMailboxCursor.count()).toBe(1);
  });

  test('并发进度不回退，邮箱代际独立，非法 UID 被拒绝', async () => {
    await Promise.all([
      progress.advanceCursor(identity, 100),
      progress.advanceCursor(identity, 50),
    ]);
    expect((await progress.loadCursor(identity)).lastUid).toBe(100);
    expect((await progress.loadCursor({ ...identity, uidValidity: '124' })).lastUid).toBeNull();
    await expect(progress.advanceCursor(identity, 0)).rejects.toThrow();
    await expect(progress.advanceCursor(identity, 4294967296)).rejects.toThrow();
    await expect(
      EmailMailboxCursor.update({ lastUid: -1 }, { where: identity, validate: false })
    ).rejects.toThrow();
  });

  test('健康心跳不冒充成功扫描，失败和过期状态均不可显示正常', async () => {
    await processing.updateWorkerState({ isConnected: true });
    expect((await processing.getMetrics()).worker.isScanHealthy).toBe(false);
    const succeededAt = new Date();
    await processing.updateWorkerState({
      lastScanStartedAt: succeededAt,
      lastScanSucceededAt: succeededAt,
      lastScanDurationMs: 42,
      lastScanErrorCode: null,
    });
    expect((await processing.getMetrics()).worker.isScanHealthy).toBe(true);
    await processing.updateWorkerState({ lastScanErrorCode: 'IMAP_TEMPORARY' });
    expect((await processing.getMetrics()).worker.isScanHealthy).toBe(false);
    await processing.updateWorkerState({
      lastScanSucceededAt: new Date(Date.now() - 91000),
      lastScanErrorCode: null,
    });
    expect((await processing.getMetrics()).worker.isScanHealthy).toBe(false);
    expect((await EmailWorkerState.findByPk(1)).lastScanDurationMs).toBe(42);
  });

  test('原文已保存但未开始解析的记录不会永久滞留', async () => {
    const received = await processing.receiveEmail({
      mailboxIdentity: { host: 'synthetic.invalid', user: 'scan@example.com', mailbox: 'INBOX' },
      uidValidity: '777',
      emailUid: 'scan-recovery-1',
      rawBuffer: Buffer.from('Subject: plain message\r\n\r\nplain'),
    });
    expect(received.created).toBe(true);
    received.record.receivedAt = new Date(Date.now() - 61000);
    await received.record.save();
    await processing.processDueRetries();
    await received.record.reload();
    expect(received.record.status).toBe('ignored');
    expect(received.record.errorCode).toBe('SUBJECT_NOT_ALLOWED');
    expect(received.record.rawContent).toBeNull();
  });
});
