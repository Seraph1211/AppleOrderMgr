jest.mock('node-imap', () => jest.fn());
jest.mock('../src/models', () => ({ EmailLog: {} }));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
const mockConfig = {
  app: { env: 'production' },
  imap: {
    allowedSenders: ['orders@example.com'],
    allowedSenderDomains: [],
    markSeen: true,
  },
};
jest.mock('../src/utils/config', () => ({
  config: mockConfig,
}));
jest.mock('../src/services/emailParser', () => ({
  parseOrderEmail: jest.fn(),
  extractEmailMetadata: jest.fn(),
}));
jest.mock('../src/services/orderService', () => ({
  saveOrderFromEmail: jest.fn(),
}));
jest.mock('../src/services/emailProcessingService', () => ({
  TERMINAL_STATUSES: new Set(),
  createMailboxIdentityHash: jest.fn(),
}));

const { classifyOrderEmailSource, isOrderEmail } = require('../src/services/emailService');

describe('订单邮件来源策略', () => {
  beforeEach(() => {
    mockConfig.app.env = 'production';
    mockConfig.imap.allowedSenders = ['orders@example.com'];
    mockConfig.imap.allowedSenderDomains = [];
  });

  test('配置白名单时要求发件人和主题同时符合', () => {
    expect(
      isOrderEmail({
        subject: 'NULL 预订成功',
        fromAddresses: ['orders@example.com'],
      })
    ).toBe(true);
  });

  test('配置白名单时拒绝不匹配发件人', () => {
    expect(
      isOrderEmail({
        subject: 'NULL 预订成功',
        fromAddresses: ['attacker@example.net'],
      })
    ).toBe(false);
  });

  test('域名白名单精确接受动态发件地址', () => {
    mockConfig.imap.allowedSenders = [];
    mockConfig.imap.allowedSenderDomains = ['lanu.cn'];

    expect(
      isOrderEmail({
        subject: 'NULL预订助手提交预订成功通知',
        fromAddresses: ['dynamic-42@lanu.cn'],
      })
    ).toBe(true);
  });

  test('域名白名单拒绝子域名和相似后缀', () => {
    mockConfig.imap.allowedSenders = [];
    mockConfig.imap.allowedSenderDomains = ['lanu.cn'];

    expect(
      isOrderEmail({
        subject: 'NULL 预订成功',
        fromAddresses: ['sender@sub.lanu.cn'],
      })
    ).toBe(false);
    expect(
      isOrderEmail({
        subject: 'NULL 预订成功',
        fromAddresses: ['sender@evil-lanu.cn'],
      })
    ).toBe(false);
  });

  test('生产环境白名单为空时接受任意发件人的订单主题', () => {
    mockConfig.imap.allowedSenders = [];
    mockConfig.imap.allowedSenderDomains = [];

    expect(
      isOrderEmail({
        subject: 'NULL 预订成功',
        fromAddresses: ['anyone@example.net'],
      })
    ).toBe(true);
  });

  test('白名单为空也拒绝没有订单关键词的邮件', () => {
    mockConfig.imap.allowedSenders = [];
    mockConfig.imap.allowedSenderDomains = [];

    expect(
      isOrderEmail({
        subject: '普通通知',
        fromAddresses: ['anyone@example.net'],
      })
    ).toBe(false);
  });

  test('来源判定返回稳定的主题和发件人错误码', () => {
    mockConfig.imap.allowedSenderDomains = ['lanu.cn'];

    expect(
      classifyOrderEmailSource({ subject: '普通通知', fromAddresses: ['sender@lanu.cn'] })
    ).toEqual({ accepted: false, errorCode: 'SUBJECT_NOT_ALLOWED' });
    expect(
      classifyOrderEmailSource({ subject: 'NULL 预订成功', fromAddresses: ['sender@example.net'] })
    ).toEqual({ accepted: false, errorCode: 'SENDER_NOT_ALLOWED' });
  });
});
