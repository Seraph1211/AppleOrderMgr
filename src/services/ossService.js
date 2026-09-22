const OSS = require('ali-oss');
const crypto = require('crypto');
const ApiError = require('../utils/ApiError');

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

function config() {
  const required = ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) throw new ApiError(503, 'OSS_NOT_CONFIGURED', 'OSS 尚未配置', { missing });
  return {
    region: process.env.OSS_REGION,
    bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    secure: true,
  };
}

function client() {
  return new OSS(config());
}

function validateFile({ originalName, contentType, sizeBytes }) {
  const name = String(originalName || '')
    .trim()
    .replace(/[\r\n/\\]/g, '_')
    .slice(0, 255);
  const type = String(contentType || '').toLowerCase();
  const size = Number(sizeBytes);
  if (!name) throw ApiError.badRequest('文件名不能为空');
  if (!ALLOWED_TYPES.has(type)) throw ApiError.badRequest('仅支持 JPG、PNG、WebP 或 PDF');
  if (!Number.isInteger(size) || size <= 0 || size > MAX_EVIDENCE_BYTES)
    throw ApiError.badRequest('单个凭证必须小于等于 10MB');
  return { originalName: name, contentType: type, sizeBytes: size };
}

/** 生成私有 OSS 对象的短期直传地址。 */
function createUpload(orderId, kind, metadata) {
  const file = validateFile(metadata);
  if (!['pickup', 'settlement'].includes(kind)) throw ApiError.badRequest('凭证类型无效');
  const extension = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  }[file.contentType];
  const objectKey = `pickup-evidence/${orderId}/${kind}/${crypto.randomUUID()}.${extension}`;
  const uploadUrl = client().signatureUrl(objectKey, {
    method: 'PUT',
    expires: 300,
    'Content-Type': file.contentType,
  });
  return { ...file, objectKey, uploadUrl, expiresInSeconds: 300 };
}

/** 核验浏览器直传对象确实存在且大小一致。 */
async function confirmUpload(objectKey, expectedSize) {
  const result = await client().head(objectKey);
  const actual = Number(result.res?.headers?.['content-length']);
  if (!Number.isFinite(actual) || actual !== Number(expectedSize))
    throw ApiError.conflict('OSS 文件大小与登记信息不一致');
}

function createReadUrl(objectKey) {
  return client().signatureUrl(objectKey, { method: 'GET', expires: 300 });
}

module.exports = { createUpload, confirmUpload, createReadUrl, validateFile };
