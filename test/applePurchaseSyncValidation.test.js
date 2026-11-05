const {
  MAX_BODY_BYTES,
  parseBatchBody,
  validateBatch,
} = require('../src/services/applePurchaseSyncValidation');
const { makeBatch } = require('./fixtures/applePurchaseSyncV1');

test('冻结 v1 合成混合批次通过且不转换 bigint 字符串', () => {
  const batch = makeBatch();
  expect(validateBatch(batch)).toBe(batch);
  expect(batch.observations[0].sourceSequence).toBe('7449');
});

test.each([
  ['顶层未知字段', batch => Object.assign(batch, { typo: true }), 'unknown_field'],
  ['观察未知字段', batch => Object.assign(batch.observations[0], { typo: true }), 'unknown_field'],
  ['错误版本', batch => Object.assign(batch, { contractVersion: '2' }), 'unsupported_version'],
  ['非法 UTC', batch => Object.assign(batch, { sentAt: '2026-11-05T08:09:12Z' }), 'invalid_utc'],
  [
    '时间毫秒不一致',
    batch => Object.assign(batch.observations[0], { responseReceivedAtMs: 1 }),
    'timestamp_mismatch',
  ],
  [
    '不安全整数',
    batch => Object.assign(batch.monitorChanges[0], { changedAtMs: 2 ** 54 }),
    'unsafe',
  ],
  [
    '非法枚举',
    batch => Object.assign(batch.observations[0], { availability: 'unavailable' }),
    'invalid',
  ],
  [
    '敏感 JSON 键',
    batch => Object.assign(batch.monitorChanges[0], { after: { token: 'x' } }),
    'sensitive',
  ],
])('%s 被严格拒绝', (_label, mutate, reason) => {
  const batch = makeBatch();
  mutate(batch);
  expect(() => validateBatch(batch)).toThrow(
    expect.objectContaining({ details: expect.any(Array) })
  );
  try {
    validateBatch(batch);
  } catch (error) {
    expect(JSON.stringify(error.details)).toContain(reason);
  }
});

test('500 项边界通过，501 项返回 TOO_MANY_EVENTS', () => {
  const batch = makeBatch();
  batch.monitorChanges = [];
  batch.observations = Array.from({ length: 500 }, (_, index) => ({
    ...batch.observations[0],
    observationId: `synthetic-${index}`,
  }));
  expect(validateBatch(batch).observations).toHaveLength(500);
  batch.observations.push({ ...batch.observations[0], observationId: 'synthetic-501' });
  expect(() => validateBatch(batch)).toThrow(expect.objectContaining({ code: 'TOO_MANY_EVENTS' }));
});

test('1 MiB 原始正文边界由专用解析器执行', () => {
  expect(() => parseBatchBody(Buffer.alloc(MAX_BODY_BYTES, 0x20))).toThrow(
    expect.objectContaining({ code: 'VALIDATION_ERROR' })
  );
  expect(() => parseBatchBody(Buffer.alloc(MAX_BODY_BYTES + 1, 0x20))).toThrow(
    expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' })
  );
  expect(() => parseBatchBody(Buffer.from('{'))).toThrow(
    expect.objectContaining({ code: 'VALIDATION_ERROR' })
  );
});
