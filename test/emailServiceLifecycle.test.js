jest.mock('../src/models', () => ({ EmailLog: { findAll: jest.fn().mockResolvedValue([]) } }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/utils/config', () => ({
  config: {
    imap: {
      host: 'synthetic.invalid',
      user: 'fixture',
      mailbox: 'INBOX',
      markSeen: true,
      allowedSenders: [],
      allowedSenderDomains: [],
    },
  },
}));
jest.mock('../src/services/emailScanner', () => ({ createEmailScanner: jest.fn() }));
jest.mock('../src/services/emailScanProgress', () => ({
  loadCursor: jest.fn(),
  advanceCursor: jest.fn(),
}));
jest.mock('../src/services/emailParser', () => ({
  parseMimeEmail: jest.fn(),
  extractEmailMetadataFromParsed: jest.fn(),
}));
jest.mock('../src/services/emailProcessingService', () => ({
  TERMINAL_STATUSES: new Set(['succeeded', 'superseded', 'manual_review', 'ignored']),
  createMailboxIdentityHash: jest.fn(() => 'a'.repeat(64)),
  receiveEmail: jest.fn(),
  updateWorkerState: jest.fn().mockResolvedValue({}),
  registerMetadata: jest.fn(),
  rejectSourceEmail: jest.fn(),
  processPersistedRecord: jest.fn(),
  markFailure: jest.fn(),
  processDueRetries: jest.fn().mockResolvedValue([]),
  purgeExpiredContent: jest.fn().mockResolvedValue(0),
}));
const { createEmailScanner } = require('../src/services/emailScanner');
const processing = require('../src/services/emailProcessingService');
const parser = require('../src/services/emailParser');
const service = require('../src/services/emailService');
const { config } = require('../src/utils/config');
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
let scanner;
let record;
let receive;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  config.imap.markSeen = true;
  scanner = {
    start: jest.fn(),
    stop: jest.fn().mockResolvedValue(),
    addSeenFlag: jest.fn().mockResolvedValue(),
    getStatus: () => ({ isConnected: true, uidValidity: '1' }),
  };
  createEmailScanner.mockReturnValue(scanner);
  record = {
    id: 1,
    emailUid: '11',
    uidValidity: '1',
    mailboxIdentityHash: 'a'.repeat(64),
    status: 'received',
    imapAckStatus: 'pending',
    imapAckRetryCount: 0,
    save: jest.fn().mockResolvedValue(),
    reload: jest.fn().mockResolvedValue(),
  };
  processing.receiveEmail.mockResolvedValue({ record, created: true });
  processing.registerMetadata.mockResolvedValue(false);
  processing.updateWorkerState.mockResolvedValue({});
  processing.processDueRetries.mockResolvedValue([]);
  processing.processPersistedRecord.mockImplementation(() => {
    record.status = 'succeeded';
    return Promise.resolve({ record });
  });
  processing.markFailure.mockImplementation(() => {
    record.status = 'manual_review';
    return Promise.resolve(record);
  });
  processing.rejectSourceEmail.mockImplementation(() => {
    record.status = 'ignored';
    return Promise.resolve(record);
  });
  parser.parseMimeEmail.mockResolvedValue({ parsed: {} });
  parser.extractEmailMetadataFromParsed.mockReturnValue({
    subject: 'NULL 预订成功',
    fromAddresses: [],
  });
  service.startEmailService();
  receive = createEmailScanner.mock.calls[0][0].receive;
});
afterEach(async () => {
  const stopped = service.stopEmailService();
  await flush();
  await jest.advanceTimersByTimeAsync(10000);
  await stopped;
  jest.useRealTimers();
});
const message = { rawBuffer: Buffer.from('synthetic mime'), emailUid: 11 };
const identity = { mailboxIdentityHash: 'a'.repeat(64), uidValidity: '1' };

test('仅原文可靠保存后报告接收，订单处理和已读确认继续完成', async () => {
  await expect(receive(message, identity)).resolves.toEqual({ created: true });
  await flush();
  expect(processing.receiveEmail).toHaveBeenCalledWith(
    expect.objectContaining({ emailUid: 11, uidValidity: '1', rawBuffer: message.rawBuffer })
  );
  expect(processing.processPersistedRecord).toHaveBeenCalledTimes(1);
  expect(scanner.addSeenFlag).toHaveBeenCalledWith(record);
  expect(record.imapAckStatus).toBe('succeeded');
  expect(processing.updateWorkerState).toHaveBeenCalledWith({ received: true });
});

test('持久化失败向扫描器抛错，不能误报已可靠接收', async () => {
  processing.receiveEmail.mockRejectedValue(new Error('synthetic database unavailable'));
  await expect(receive(message, identity)).rejects.toThrow();
  expect(parser.parseMimeEmail).not.toHaveBeenCalled();
});

test('重复终态不刷新最近收信、不再次解析或写已读标记', async () => {
  record.status = 'succeeded';
  record.imapAckStatus = 'succeeded';
  processing.receiveEmail.mockResolvedValue({ record, created: false });
  await receive(message, identity);
  await flush();
  expect(parser.parseMimeEmail).not.toHaveBeenCalled();
  expect(scanner.addSeenFlag).not.toHaveBeenCalled();
  expect(processing.updateWorkerState).not.toHaveBeenCalledWith({ received: true });
});

test('MIME 失败持久化人工状态，已读确认失败进入独立重试', async () => {
  parser.parseMimeEmail.mockRejectedValue(new Error('synthetic malformed MIME'));
  scanner.addSeenFlag.mockRejectedValue(new Error('synthetic disconnect'));
  await receive(message, identity);
  await flush();
  expect(processing.markFailure).toHaveBeenCalled();
  expect(record.imapAckStatus).toBe('retry_wait');
  expect(record.imapAckRetryCount).toBe(1);
  expect(record.imapAckNextRetryAt.getTime()).toBe(Date.now() + 60000);
});

test('来源拒绝不触发订单处理，关闭已读写入仍保留终态', async () => {
  config.imap.markSeen = false;
  parser.extractEmailMetadataFromParsed.mockReturnValue({ subject: '普通通知', fromAddresses: [] });
  await receive(message, identity);
  await flush();
  expect(processing.rejectSourceEmail).toHaveBeenCalledWith(record, 'SUBJECT_NOT_ALLOWED');
  expect(processing.processPersistedRecord).not.toHaveBeenCalled();
  expect(record.imapAckStatus).toBe('not_required');
  expect(scanner.addSeenFlag).not.toHaveBeenCalled();
});

test('长时间处理中的记录不会让停止无限等待', async () => {
  parser.parseMimeEmail.mockImplementation(() => new Promise(() => {}));
  await receive(message, identity);
  await flush();
  const stopped = service.stopEmailService();
  await jest.advanceTimersByTimeAsync(10000);
  await expect(stopped).resolves.toBeUndefined();
});
