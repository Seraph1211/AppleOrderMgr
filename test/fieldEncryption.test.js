const {
  isEncrypted,
  encrypt,
  decrypt,
  blindIndex,
  encryptJson,
  decryptJson,
} = require('../src/utils/fieldEncryption');

describe('敏感字段加密', () => {
  const originalKey = process.env.FIELD_ENCRYPTION_KEY;
  const originalVersion = process.env.FIELD_ENCRYPTION_KEY_VERSION;
  const originalKeys = process.env.FIELD_ENCRYPTION_KEYS_JSON;
  const originalBlindIndexKey = process.env.FIELD_BLIND_INDEX_KEY;

  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.FIELD_ENCRYPTION_KEY_VERSION = 'v1';
    delete process.env.FIELD_ENCRYPTION_KEYS_JSON;
    delete process.env.FIELD_BLIND_INDEX_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = originalKey;
    if (originalVersion === undefined) delete process.env.FIELD_ENCRYPTION_KEY_VERSION;
    else process.env.FIELD_ENCRYPTION_KEY_VERSION = originalVersion;
    if (originalKeys === undefined) delete process.env.FIELD_ENCRYPTION_KEYS_JSON;
    else process.env.FIELD_ENCRYPTION_KEYS_JSON = originalKeys;
    if (originalBlindIndexKey === undefined) delete process.env.FIELD_BLIND_INDEX_KEY;
    else process.env.FIELD_BLIND_INDEX_KEY = originalBlindIndexKey;
  });

  test('应该使用随机 IV 加密并可正确解密', () => {
    const first = encrypt('secret-value');
    const second = encrypt('secret-value');
    expect(isEncrypted(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(decrypt(first)).toBe('secret-value');
    expect(decrypt(second)).toBe('secret-value');
  });

  test('应该为相同身份证生成稳定盲索引', () => {
    expect(blindIndex(' 110101199001011234 ')).toBe(blindIndex('110101199001011234'));
  });

  test('应该加密和解密 JSON', () => {
    const source = { question1: '问题', answer1: '答案' };
    const encrypted = encryptJson(source);
    expect(encrypted).not.toEqual(source);
    expect(decryptJson(encrypted)).toEqual(source);
  });

  test('缺少密钥时应该拒绝写入', () => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    expect(() => encrypt('secret')).toThrow('缺少 FIELD_ENCRYPTION_KEY');
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });

  test('应该使用密钥环解密旧版本密文', () => {
    process.env.FIELD_ENCRYPTION_KEY_VERSION = 'v0';
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString('base64');
    const oldCiphertext = encrypt('历史密文');

    process.env.FIELD_ENCRYPTION_KEY_VERSION = 'v1';
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.FIELD_ENCRYPTION_KEYS_JSON = JSON.stringify({
      v0: Buffer.alloc(32, 6).toString('base64'),
    });

    expect(decrypt(oldCiphertext)).toBe('历史密文');
  });

  test('独立盲索引密钥应该不受加密密钥变化影响', () => {
    process.env.FIELD_BLIND_INDEX_KEY = Buffer.alloc(32, 5).toString('base64');
    const first = blindIndex('500101199001010000');
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
    expect(blindIndex('500101199001010000')).toBe(first);
  });
});
