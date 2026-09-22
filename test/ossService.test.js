jest.mock('ali-oss', () =>
  jest.fn().mockImplementation(() => ({
    signatureUrl: jest.fn((key, options) => `https://oss.example/${key}?method=${options.method}`),
  }))
);

const ossService = require('../src/services/ossService');

describe('取货凭证 OSS 边界', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = {
      ...original,
      OSS_REGION: 'oss-cn-chengdu',
      OSS_BUCKET: 'synthetic-private-bucket',
      OSS_ACCESS_KEY_ID: 'synthetic-key',
      OSS_ACCESS_KEY_SECRET: 'synthetic-secret',
    };
  });
  afterAll(() => {
    process.env = original;
  });

  test('签发限定订单和凭证类型目录的短期 PUT 地址', () => {
    const result = ossService.createUpload(42, 'settlement', {
      originalName: '结款凭证.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
    });
    expect(result.objectKey).toMatch(/^pickup-evidence\/42\/settlement\/.+\.jpg$/);
    expect(result.uploadUrl).toContain('method=PUT');
    expect(result.expiresInSeconds).toBe(300);
  });

  test.each([
    ['text/plain', 10, '仅支持'],
    ['image/png', 10 * 1024 * 1024 + 1, '10MB'],
  ])('拒绝不允许的文件 %#', (contentType, sizeBytes, message) => {
    expect(() =>
      ossService.validateFile({ originalName: 'evidence', contentType, sizeBytes })
    ).toThrow(message);
  });
});
