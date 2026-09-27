jest.mock('../src/models', () => ({ sequelize: { query: jest.fn() } }));
const mockRecognize = jest.fn();
jest.mock('@alicloud/ocr-api20210707', () => ({
  default: jest.fn().mockImplementation(() => ({ recognizeAdvancedWithOptions: mockRecognize })),
  RecognizeAdvancedRequest: jest.fn().mockImplementation(value => value),
}));
const { sequelize } = require('../src/models');
const service = require('../src/services/pickupOcrService');
const { extractSerialCandidates } = require('../src/services/pickupOcrRules');
const jpeg = { mimetype: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0x01]) };
const env = { ...process.env };
afterAll(() => {
  process.env = env;
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.PICKUP_OCR_ENABLED = 'true';
  process.env.PICKUP_OCR_ACCESS_KEY_ID = 'synthetic';
  process.env.PICKUP_OCR_ACCESS_KEY_SECRET = 'synthetic-secret';
  process.env.PICKUP_OCR_MONTHLY_LIMIT = '1000';
  sequelize.query.mockResolvedValue([[{ used: 1 }]]);
});
test('真实 S 保留，IMEI 和 UPC 不作序列号', () => {
  expect(extractSerialCandidates('Serial No. S234567890\nIMEI 123456789012345')).toEqual([
    'S234567890',
  ]);
  expect(extractSerialCandidates('UPC 195951411859')).toEqual([]);
});
test('多个盒子需要显式选择，供应商正文不返回', () => {
  const result = service.parseResponse({
    data: JSON.stringify({ content: 'Serial No. TEST000001\nSerial No. TEST000002' }),
    requestId: 'synthetic-request',
  });
  expect(result).toEqual({
    candidates: ['TEST000001', 'TEST000002'],
    requestId: 'synthetic-request',
    provider: 'aliyun',
  });
});
test.each([{}, { code: 'InvalidParameter', data: '{}' }, { data: 'not-json' }, { data: '{}' }])(
  'HTTP 成功但结果异常仍拒绝 %p',
  body => {
    expect(() => service.parseResponse(body)).toThrow('云端识别结果异常');
  }
);
test('空候选正常返回，不编造号码', () => {
  expect(service.parseResponse({ data: '{"content":"IMEI 123456789012345"}' }).candidates).toEqual(
    []
  );
});
test('有效图片签名与声明类型必须一致', () => {
  expect(() => service.validateImage(jpeg)).not.toThrow();
  expect(() => service.validateImage({ ...jpeg, mimetype: 'image/png' })).toThrow();
  expect(() =>
    service.validateImage({ mimetype: 'image/jpeg', buffer: Buffer.from('<script>') })
  ).toThrow();
  expect(() => service.validateImage()).toThrow();
});
test('额度不足时不调用供应商', async () => {
  sequelize.query.mockResolvedValue([[]]);
  await expect(service.recognize(jpeg)).rejects.toMatchObject({ code: 'OCR_MONTHLY_LIMIT' });
  expect(mockRecognize).not.toHaveBeenCalled();
});
test('配置缺失和图片无效不扣次', async () => {
  delete process.env.PICKUP_OCR_ACCESS_KEY_SECRET;
  await expect(service.recognize(jpeg)).rejects.toMatchObject({ code: 'OCR_NOT_CONFIGURED' });
  await expect(service.recognize({ ...jpeg, buffer: Buffer.from('bad') })).rejects.toMatchObject({
    statusCode: 400,
  });
  expect(sequelize.query).not.toHaveBeenCalled();
});
test('供应商错误完全脱敏、不重试、不返还已预占次数', async () => {
  mockRecognize.mockRejectedValue(new Error('synthetic-secret raw image'));
  await expect(service.recognize(jpeg)).rejects.toMatchObject({ code: 'OCR_FAILED' });
  expect(mockRecognize).toHaveBeenCalledTimes(1);
  expect(sequelize.query).toHaveBeenCalledTimes(1);
  expect(mockRecognize.mock.calls[0][1]).toMatchObject({ autoretry: false, maxAttempts: 1 });
});
test('使用流上传，不传公开 URL', async () => {
  mockRecognize.mockResolvedValue({ body: { data: '{"content":"Serial No. TEST000001"}' } });
  expect((await service.recognize(jpeg)).candidates).toEqual(['TEST000001']);
  expect(mockRecognize.mock.calls[0][0].url).toBeUndefined();
  expect(mockRecognize.mock.calls[0][0].body.readable).toBe(true);
});
test('非法预算和数据库故障均禁止云调用', async () => {
  process.env.PICKUP_OCR_MONTHLY_LIMIT = '1001';
  await expect(service.recognize(jpeg)).rejects.toMatchObject({ code: 'OCR_NOT_CONFIGURED' });
  process.env.PICKUP_OCR_MONTHLY_LIMIT = '1000';
  sequelize.query.mockRejectedValue(new Error('database secret'));
  await expect(service.recognize(jpeg)).rejects.toMatchObject({ code: 'OCR_QUOTA_UNAVAILABLE' });
  expect(mockRecognize).not.toHaveBeenCalled();
});
