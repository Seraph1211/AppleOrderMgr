const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_BYTES = 32;
const FILE_NONCE_BYTES = 8;
const LINK_SEGMENTS = Object.freeze({ length: 5, order: 3, contact: 4 });
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_MASK = 0o077;
const MAX_INPUT_BYTES = 1048576;
const MAX_SESSION_AGE_MS = 21600000;
const ORDER_NUMBER = /^W\d{10}$/;
const APPLE_HOST =
  /^(?:[a-z0-9-]+\.)*(?:apple\.com\.cn|apple\.com|cdn-apple\.com|aaplimg\.com|mzstatic\.com)$/;

/** 生成稳定、不包含外部输入的错误。 */
function fault(code) {
  return Object.assign(new Error(code), { code });
}

/** 为许可及证据计算摘要，不将 URL 或账号写入普通日志。 */
function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 小幅限流等待；不是逐订单固定延迟。 */
function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** 清除路径中的订单号、联系人和访客访问令牌；从不保存 query。 */
function safePath(value) {
  return String(value)
    .split('?')[0]
    .replace(/W\d{10}/g, '[ORDER]')
    .replace(/[^/]*(?:@|%40)[^/]*/gi, '[EMAIL]')
    .replace(/\/[A-Za-z0-9_%=-]{40,}(?=\/|$)/g, '/[TOKEN]');
}

/** 每个导航、重定向和子请求都必须通过 HTTPS 官方域名白名单。 */
function permittedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw fault('DESTINATION_DENIED');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !APPLE_HOST.test(url.hostname)
  ) {
    throw fault('DESTINATION_DENIED');
  }
  return url;
}

/** 只允许已知订单详情入口，拒绝其他订单或其他商店动作。 */
function detailUrl(value, host, orderNumber) {
  const url = permittedUrl(new URL(value, `https://${host}`).href);
  if (
    url.hostname !== host ||
    !/^\/shop\/order\/detail\//.test(url.pathname) ||
    !url.pathname.endsWith(`/${orderNumber}`)
  ) {
    throw fault('DETAIL_DESTINATION_INVALID');
  }
  return url.href;
}

/** 读取服务器私有输入，拒绝符号链接和其他用户可读文件。 */
function readPrivate(file, json = true) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & SECRET_MASK) {
    throw fault('PRIVATE_FILE_PERMISSIONS');
  }
  if (stat.size > MAX_INPUT_BYTES) throw fault('INPUT_TOO_LARGE');
  const bytes = fs.readFileSync(file);
  return json ? JSON.parse(bytes.toString('utf8')) : bytes;
}

/** 验证系统、原始链接及登录账号身份，不从联系邮箱推断账号。 */
function validateSample(sample) {
  if (
    !sample ||
    !Number.isSafeInteger(sample.id) ||
    sample.id <= 0 ||
    !ORDER_NUMBER.test(sample.orderNumber) ||
    typeof sample.email !== 'string' ||
    !/^[^\s@]+@[^\s@]+$/.test(sample.email) ||
    typeof sample.password !== 'string' ||
    !sample.password ||
    sample.password.length > MAX_INPUT_BYTES
  ) {
    throw fault('INPUT_INVALID');
  }
  const url = permittedUrl(sample.url);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (
    url.hostname !== 'www.apple.com.cn' ||
    parts.length !== LINK_SEGMENTS.length ||
    !['xc/cn/vieworder', 'shop/order/list'].includes(
      parts.slice(0, LINK_SEGMENTS.order).join('/')
    ) ||
    parts[LINK_SEGMENTS.order] !== sample.orderNumber ||
    !/^[^\s@]+@[^\s@]+$/.test(parts[LINK_SEGMENTS.contact]) ||
    url.search ||
    url.hash
  ) {
    throw fault('LINK_IDENTITY_MISMATCH');
  }
  const accountHash = hash(sample.email.toLowerCase());
  if (sample.accountHash && sample.accountHash !== accountHash) throw fault('ACCOUNT_MISMATCH');
  if (sample.snapshotPasswordMatches === false) throw fault('CREDENTIAL_SNAPSHOT_MISMATCH');
  return { ...sample, accountHash, orderHash: hash(sample.orderNumber) };
}

/** AES-GCM 密文封装，密钥只保留在服务器受限目录。 */
function encrypt(value, key) {
  if (key.length !== KEY_BYTES) throw fault('KEY_INVALID');
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), payload]);
}

/** 解密并校验完整性；认证失败不能作为空会话继续。 */
function decrypt(bytes, key) {
  try {
    if (key.length !== KEY_BYTES || bytes.length <= IV_BYTES + TAG_BYTES)
      throw fault('KEY_INVALID');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES));
    cipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([cipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), cipher.final()]);
  } catch (_error) {
    throw fault('ENCRYPTED_STATE_INVALID');
  }
}

/** 原子保存私有文件；失败不会破坏上一份正确观测或会话。 */
function writePrivate(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomBytes(FILE_NONCE_BYTES).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** 校验服务器会话所属账号、时效及 Cookie 域；不接受电脑导入的无身份会话。 */
function validateSession(state, accountHash, now = Date.now()) {
  if (!state || state.accountHash !== accountHash) throw fault('SESSION_IDENTITY_MISMATCH');
  const createdAt = Date.parse(state.createdAt);
  if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt > MAX_SESSION_AGE_MS) {
    throw fault('SESSION_EXPIRED');
  }
  if (!Array.isArray(state.cookies)) throw fault('SESSION_INVALID');
  for (const cookie of state.cookies) {
    permittedUrl(`https://${String(cookie.domain).replace(/^\./, '')}`);
  }
  return state.cookies;
}

/** 页面切换取消旧请求是正常生命周期；其余 CDP 错误仍需失败退出。 */
function isCanceledInterception(error) {
  return (
    error.method === 'Fetch.continueRequest' &&
    /Invalid (?:InterceptionId|RequestId)|Session with given id not found/i.test(error.detail || '')
  );
}

module.exports = {
  fault,
  hash,
  delay,
  safePath,
  permittedUrl,
  detailUrl,
  readPrivate,
  validateSample,
  encrypt,
  decrypt,
  writePrivate,
  validateSession,
  isCanceledInterception,
};
