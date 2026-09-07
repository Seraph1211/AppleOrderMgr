const mockLockedRecord = {
  id: 10,
  retryCount: 0,
  version: 0,
  attemptHistory: [],
  save: jest.fn().mockResolvedValue(undefined),
};

const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };

jest.mock('../src/models', () => ({
  sequelize: {
    transaction: jest.fn(callback => callback(mockTransaction)),
    fn: jest.fn(),
    col: jest.fn(),
  },
  EmailLog: {
    findByPk: jest.fn(() => Promise.resolve(mockLockedRecord)),
  },
  EmailWorkerState: {},
  Order: {},
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/services/orderService', () => ({ saveOrderFromEmail: jest.fn() }));

const service = require('../src/services/emailProcessingService');

describe('邮件持久化重试策略', () => {
  beforeEach(() => {
    mockLockedRecord.retryCount = 0;
    mockLockedRecord.version = 0;
    mockLockedRecord.attemptHistory = [];
    mockLockedRecord.save.mockClear();
  });

  test('邮箱身份哈希稳定且不包含原始账号', () => {
    const first = service.createMailboxIdentityHash({
      host: 'imap.example.com',
      user: 'USER@example.com',
      mailbox: 'INBOX',
    });
    const second = service.createMailboxIdentityHash({
      host: 'IMAP.EXAMPLE.COM',
      user: 'user@example.com',
      mailbox: 'inbox',
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('user@example.com');
  });

  test('临时错误初次失败后一分钟进入持久化重试', async () => {
    const error = Object.assign(new Error('connection'), { name: 'SequelizeConnectionError' });
    const result = await service.markFailure(mockLockedRecord, error);
    expect(result.status).toBe('retry_wait');
    expect(result.retryCount).toBe(0);
    expect(result.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.errorMessage).toBe('数据库暂时不可用');
  });

  test('每分钟最多重试三次，第三次失败进入待人工处理', async () => {
    const error = Object.assign(new Error('connection'), { name: 'SequelizeConnectionError' });
    await service.markFailure(mockLockedRecord, error, { isRetry: true });
    expect(mockLockedRecord.retryCount).toBe(1);
    expect(mockLockedRecord.status).toBe('retry_wait');
    await service.markFailure(mockLockedRecord, error, { isRetry: true });
    expect(mockLockedRecord.retryCount).toBe(2);
    expect(mockLockedRecord.status).toBe('retry_wait');
    await service.markFailure(mockLockedRecord, error, { isRetry: true });
    expect(mockLockedRecord.retryCount).toBe(3);
    expect(mockLockedRecord.status).toBe('manual_review');
    expect(mockLockedRecord.nextRetryAt).toBeNull();
  });

  test('永久解析错误直接进入待人工处理', async () => {
    const error = new (require('../src/services/emailErrors').EmailProcessingError)(
      'PRODUCT_INVALID',
      '至少一个商品无效'
    );
    const result = await service.markFailure(mockLockedRecord, error);
    expect(result.status).toBe('manual_review');
    expect(result.nextRetryAt).toBeNull();
  });
});
