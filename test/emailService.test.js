jest.mock('node-imap', () => jest.fn());
jest.mock('../src/models', () => ({ EmailLog: {} }));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/utils/config', () => ({
  config: {
    app: { env: 'production' },
    imap: {
      allowedSenders: ['orders@example.com'],
      markSeen: true,
    },
  },
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

const { isOrderEmail } = require('../src/services/emailService');

describe('订单邮件身份过滤', () => {
  test('发件人和主题同时符合时才接受', () => {
    expect(
      isOrderEmail({
        subject: 'NULL 预订成功',
        fromAddresses: ['orders@example.com'],
      })
    ).toBe(true);
  });

  test('仅伪造订单主题不得通过', () => {
    expect(
      isOrderEmail({
        subject: 'NULL 预订成功',
        fromAddresses: ['attacker@example.net'],
      })
    ).toBe(false);
  });
});
