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

/** 校验私有凭证文件名、MIME与10MiB边界。 */
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
  try {
    const result = await client().head(objectKey);
    const actual = Number(result.res?.headers?.['content-length']);
    if (!Number.isFinite(actual) || actual !== Number(expectedSize))
      throw ApiError.conflict('OSS 文件大小与登记信息不一致');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'OSS_UPLOAD_UNVERIFIED', '无法核验凭证，请确认上传成功后重试');
  }
}

/** 为已授权的旧取货凭证生成短期只读地址。 */
function createReadUrl(objectKey) {
  return client().signatureUrl(objectKey, { method: 'GET', expires: 300 });
}

const STOCK_KINDS = new Set([
  'unit_photo',
  'sale_document',
  'collection_proof',
  'receipt_proof',
  'expense_proof',
]);
const STOCK_OBJECT_PATTERN =
  /^pickup-evidence\/stock\/[a-f0-9-]{36}\/(?:unit_photo|sale_document|collection_proof|receipt_proof|expense_proof)\/[a-f0-9-]{36}\.(?:jpg|png|webp|pdf)$/;

function validateStockObjectKey(objectKey) {
  if (typeof objectKey !== 'string' || !STOCK_OBJECT_PATTERN.test(objectKey))
    throw ApiError.badRequest('库存凭证路径无效');
}

/** 在现有私有凭证目录下创建库存对象键；不接受用户指定路径。 */
function createStockUpload(attachmentId, kind, metadata) {
  if (!/^[a-f0-9-]{36}$/.test(String(attachmentId)) || !STOCK_KINDS.has(kind))
    throw ApiError.badRequest('库存凭证类型或标识无效');
  const file = validateFile(metadata);
  const extension = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  }[file.contentType];
  const objectKey = `pickup-evidence/stock/${attachmentId}/${kind}/${crypto.randomUUID()}.${extension}`;
  return { ...file, objectKey, ...createStockUploadUrl(objectKey, file) };
}

/** 短期直传强制禁止覆盖，避免确认后持旧上传 URL 改写证据。 */
function createStockUploadUrl(objectKey, metadata) {
  validateStockObjectKey(objectKey);
  const file = validateFile(metadata);
  const uploadHeaders = {
    'Content-Type': file.contentType,
    'x-oss-forbid-overwrite': 'true',
  };
  const uploadUrl = client().signatureUrl(objectKey, {
    method: 'PUT',
    expires: 300,
    ...uploadHeaders,
  });
  return { uploadUrl, uploadHeaders, expiresInSeconds: 300 };
}

/** 在库存事务外核验 OSS 的实际大小和 MIME；供应商错误不透传。 */
async function confirmStockUpload(objectKey, metadata) {
  try {
    validateStockObjectKey(objectKey);
    const file = validateFile(metadata);
    const result = await client().head(objectKey);
    const headers = result.res?.headers || {};
    const actualSize = Number(headers['content-length']);
    const actualType = String(headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (actualSize !== file.sizeBytes || actualType !== file.contentType)
      throw new ApiError(409, 'ATTACHMENT_MISMATCH', '凭证实际大小或 MIME 与登记信息不一致');
    return { objectKey, sizeBytes: actualSize, contentType: actualType };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'OSS_UPLOAD_UNVERIFIED', '无法核验凭证，请确认上传成功后重试');
  }
}

/** 库存凭证的只读签名；调用方必须先核实全部关联目标。 */
function createStockReadUrl(objectKey) {
  validateStockObjectKey(objectKey);
  return createReadUrl(objectKey);
}

module.exports = {
  createUpload,
  confirmUpload,
  createReadUrl,
  validateFile,
  createStockUpload,
  createStockUploadUrl,
  confirmStockUpload,
  createStockReadUrl,
};
