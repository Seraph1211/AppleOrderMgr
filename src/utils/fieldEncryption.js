/**
 * 敏感字段 AES-256-GCM 加密与盲索引工具。
 * @module utils/fieldEncryption
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_PREFIX = 'enc';
const IV_BYTES = 12;

function decodeKey(configured, variableName) {
  if (!configured) {
    throw new Error(`缺少 ${variableName}，拒绝处理敏感字段`);
  }

  let key;
  if (/^[a-f0-9]{64}$/i.test(configured)) {
    key = Buffer.from(configured, 'hex');
  } else {
    key = Buffer.from(configured, 'base64');
  }

  if (key.length !== 32) {
    throw new Error(`${variableName} 必须是 32 字节密钥的 hex 或 base64 编码`);
  }
  return key;
}

function getVersionedKeys() {
  const configured = process.env.FIELD_ENCRYPTION_KEYS_JSON;
  if (!configured) {
    return {};
  }
  try {
    const parsed = JSON.parse(configured);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('必须是 JSON 对象');
    }
    return parsed;
  } catch (error) {
    throw new Error(`FIELD_ENCRYPTION_KEYS_JSON 格式无效: ${error.message}`);
  }
}

function getKeyMaterial(version = process.env.FIELD_ENCRYPTION_KEY_VERSION || 'v1') {
  const currentVersion = process.env.FIELD_ENCRYPTION_KEY_VERSION || 'v1';
  if (version === currentVersion) {
    return decodeKey(process.env.FIELD_ENCRYPTION_KEY, 'FIELD_ENCRYPTION_KEY');
  }

  const versionedKeys = getVersionedKeys();
  return decodeKey(versionedKeys[version], `FIELD_ENCRYPTION_KEYS_JSON[${version}]`);
}

/**
 * 校验敏感字段密钥配置。
 * @returns {void}
 */
function validateEncryptionConfiguration() {
  getKeyMaterial();
  getVersionedKeys();
}

/**
 * 判断值是否为本工具生成的密文。
 * @param {*} value - 待判断值
 * @returns {boolean} 是否为密文
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${ENVELOPE_PREFIX}:`);
}

/**
 * 加密字符串；空值原样返回。
 * @param {*} value - 待加密值
 * @returns {*} 密文信封
 */
function encrypt(value) {
  if (value === null || value === undefined || value === '') {
    return value;
  }
  if (isEncrypted(value)) {
    return value;
  }

  const version = process.env.FIELD_ENCRYPTION_KEY_VERSION || 'v1';
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKeyMaterial(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_PREFIX,
    version,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * 解密字符串；兼容迁移前的明文值。
 * @param {*} value - 密文或历史明文
 * @returns {*} 明文
 */
function decrypt(value) {
  if (!isEncrypted(value)) {
    return value;
  }

  const parts = value.split(':');
  if (parts.length !== 5) {
    throw new Error('敏感字段密文格式无效');
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKeyMaterial(parts[1]),
    Buffer.from(parts[2], 'base64url')
  );
  decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[4], 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * 为精确匹配生成不可逆盲索引。
 * @param {*} value - 规范化前的值
 * @returns {string|null} HMAC-SHA256
 */
function blindIndex(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const key = process.env.FIELD_BLIND_INDEX_KEY
    ? decodeKey(process.env.FIELD_BLIND_INDEX_KEY, 'FIELD_BLIND_INDEX_KEY')
    : getKeyMaterial();
  return crypto.createHmac('sha256', key).update(String(value).trim().toUpperCase()).digest('hex');
}

/**
 * 加密 JSON 值。
 * @param {*} value - JSON 值
 * @returns {Object|null} JSONB 密文包装
 */
function encryptJson(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value.__encrypted) {
    return value;
  }
  return { __encrypted: encrypt(JSON.stringify(value)) };
}

/**
 * 解密 JSON 值，兼容历史明文 JSON。
 * @param {*} value - JSONB 值
 * @returns {*} 解密结果
 */
function decryptJson(value) {
  if (!value || !value.__encrypted) {
    return value;
  }
  return JSON.parse(decrypt(value.__encrypted));
}

module.exports = {
  isEncrypted,
  encrypt,
  decrypt,
  blindIndex,
  encryptJson,
  decryptJson,
  validateEncryptionConfiguration,
};
