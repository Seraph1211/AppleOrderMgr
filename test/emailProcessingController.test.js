/* eslint-disable camelcase */
const mockRecord = {
  id: 42,
  status: 'manual_review',
  version: 3,
  manualDraft: { orderNumber: 'W1234567890' },
  parsedData: null,
  reload: jest.fn().mockResolvedValue(undefined),
  toJSON: jest.fn(() => ({
    id: 42,
    status: 'manual_review',
    version: 3,
    emailSubject: '完整邮件主题',
    emailFrom: '完整发件人 <sender@example.com>',
    rawContent: Buffer.from('完整原始 MIME').toString('base64'),
    manualDraft: {
      applePassword: '允许查看的密码',
      recipient: { idCard: '110101199001011234' },
      orderNumber: 'W1234567890',
    },
    parsedData: null,
    finalData: null,
    attemptHistory: [],
    auditHistory: [{ action: 'view_full_detail', userId: 7 }],
    resolver: { username: 'admin' },
  })),
};

const mockFindByPk = jest.fn().mockResolvedValue(mockRecord);
const mockFindAll = jest.fn().mockResolvedValue([mockRecord]);
const mockFindOrder = jest.fn().mockResolvedValue(null);
const mockRecordAuditAction = jest.fn().mockResolvedValue(mockRecord);
const mockReparsePreview = jest.fn().mockResolvedValue({ orderNumber: 'W1234567890' });

jest.mock('../src/models', () => ({
  EmailLog: { findByPk: mockFindByPk, findAll: mockFindAll },
  Order: { findOne: mockFindOrder },
  User: {},
}));
jest.mock('../src/services/emailProcessingService', () => ({
  recordAuditAction: mockRecordAuditAction,
  reparsePreview: mockReparsePreview,
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const controller = require('../src/controllers/emailProcessingController');

function createResponse() {
  return { json: jest.fn(value => value) };
}

describe('管理员邮件处理 API 契约', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByPk.mockResolvedValue(mockRecord);
    mockFindAll.mockResolvedValue([mockRecord]);
    mockFindOrder.mockResolvedValue(null);
    mockRecord.reload.mockResolvedValue(undefined);
  });

  test('详情返回管理员获准的完整 MIME、密码和身份证并记录查看审计', async () => {
    const req = { params: { id: '42' }, user: { id: 7 } };
    const res = createResponse();

    await controller.getRecord(req, res);

    expect(mockRecordAuditAction).toHaveBeenCalledWith(42, 'view_full_detail', 7, {
      result: 'succeeded',
    });
    const payload = res.json.mock.calls[0][0].data;
    expect(payload.raw_mime).toBe('完整原始 MIME');
    expect(payload.manual_draft.applePassword).toBe('允许查看的密码');
    expect(payload.manual_draft.recipient.idCard).toBe('110101199001011234');
    expect(payload.audit_history).toEqual([{ action: 'view_full_detail', userId: 7 }]);
  });

  test('批量重新解析为每个请求 ID 返回独立结果，包括不存在记录', async () => {
    const req = { body: { ids: [42, 404] }, user: { id: 7 } };
    const res = createResponse();

    await controller.batchReparse(req, res);

    expect(res.json.mock.calls[0][0].data.results).toEqual([
      expect.objectContaining({ id: 42, success: true }),
      { id: 404, success: false, error_code: 'NOT_FOUND' },
    ]);
    expect(mockRecordAuditAction).toHaveBeenCalledWith(42, 'batch_reparse_preview', 7, {
      result: 'succeeded',
    });
  });
});
