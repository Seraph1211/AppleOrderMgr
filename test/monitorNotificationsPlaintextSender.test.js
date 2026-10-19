const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const mockWebhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic_key';
const CLAIM_AND_FINISH_LOOKUPS = 2;
const mockEvent = {
  notificationEventId: 'event-row-1',
  alertId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  category: 'alert',
  severity: 'warning',
  deviceName: '合成服务器',
  instanceLabel: '合成实例',
  ruleName: '合成规则',
  hitCount: 1,
  firstSeenAt: '2026-10-19T03:00:00.000Z',
  at: '2026-10-19T04:00:00.000Z',
};
const mockSetting = {
  senderGeneration: 2,
  targetVersion: 1,
  policyVersion: 1,
  enabled: true,
  sendRecovery: true,
  pausedReason: null,
  webhookCipher: 'synthetic-ciphertext',
  policy: {},
  update: jest.fn(),
};
const mockRow = {
  id: 'delivery-1',
  channel: 'wecom',
  category: 'alert',
  severity: 'warning',
  status: 'pending',
  leaseToken: null,
  leaseUntil: null,
  dispatchStartedAt: null,
  targetVersion: 1,
  policyVersion: 1,
  recipientSnapshot: [],
  recipientResults: {},
  attempts: 0,
  priority: 1,
  version: 1,
  expiresAt: new Date('2026-10-20T00:00:00.000Z'),
  update: jest.fn(values => Promise.resolve(Object.assign(mockRow, values))),
};

jest.mock('../src/models', () => ({
  sequelize: {
    transaction: jest.fn(work => Promise.resolve(work(mockTransaction))),
    query: jest.fn(() => Promise.resolve([[], {}])),
  },
  MonitorNotificationSetting: { findByPk: jest.fn() },
  MonitorNotificationDelivery: {
    findOne: jest.fn(() => Promise.resolve(mockRow)),
    findAll: jest.fn(() => Promise.resolve([])),
    findByPk: jest.fn(() => Promise.resolve(mockRow)),
    create: jest.fn(),
  },
  MonitorNotificationEvent: {
    update: jest.fn(),
    findAll: jest.fn(() => Promise.resolve([{ payload: mockEvent }])),
    findOne: jest.fn(),
  },
  MonitorNotificationLink: {
    findOrCreate: jest.fn(() => Promise.resolve([{
      initialStatus: 'accepted',
      reminderSequence: 0,
      update: jest.fn(),
    }])),
  },
  NotificationWorkerState: { upsert: jest.fn() },
}));
jest.mock('../src/services/monitorNotificationService', () => ({
  DEFAULT_POLICY: {
    criticalReminderMinutes: [1],
    warningReminderMinutes: 1,
  },
  lockedChannel: jest.fn(() => Promise.resolve(mockSetting)),
  enqueueForChannel: jest.fn(),
}));
jest.mock('../src/services/monitorNotificationState', () => ({
  validEvents: jest.fn(() => Promise.resolve([mockEvent])),
}));
jest.mock('../src/services/wecomRobotBudget', () => ({
  reserve: jest.fn(() => Promise.resolve({ allowed: true })),
}));
jest.mock('../src/services/wecomTransport', () => ({
  sendText: jest.fn(() => Promise.resolve({ status: 'accepted' })),
  sendMarkdown: jest.fn(() => Promise.resolve({ status: 'accepted' })),
}));
jest.mock('../src/utils/fieldEncryption', () => ({ decrypt: jest.fn(() => mockWebhook) }));
jest.mock('../src/utils/config', () => ({ config: { smtp: {} } }));
jest.mock('../src/utils/logger', () => ({ debug: jest.fn(), error: jest.fn() }));
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const transport = require('../src/services/wecomTransport');
const sender = require('../src/services/monitorNotificationSender');
const { MonitorNotificationDelivery } = require('../src/models');

describe('监控通知 sender 默认纯文本传输', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockRow, {
      status: 'pending',
      leaseToken: null,
      leaseUntil: null,
      dispatchStartedAt: null,
      attempts: 0,
      version: 1,
      recipientResults: {},
      sentAt: null,
    });
    MonitorNotificationDelivery.findOne.mockResolvedValue(mockRow);
    MonitorNotificationDelivery.findByPk.mockResolvedValue(mockRow);
  });

  test('走完整 claim/authorize 闭包，默认调用 sendText 一次且不调用 Markdown 传输', async () => {
    await expect(
      sender.processOne(new Date('2026-10-19T04:01:00.000Z'), { channel: 'wecom' })
    ).resolves.toBe(true);

    expect(transport.sendText).toHaveBeenCalledTimes(1);
    expect(transport.sendText).toHaveBeenCalledWith(mockWebhook, expect.stringContaining('合成服务器'));
    expect(transport.sendMarkdown).not.toHaveBeenCalled();
    expect(MonitorNotificationDelivery.findOne).toHaveBeenCalledTimes(1);
    expect(MonitorNotificationDelivery.findByPk).toHaveBeenCalledTimes(CLAIM_AND_FINISH_LOOKUPS);
    expect(mockRow.status).toBe('accepted');
  });
});
