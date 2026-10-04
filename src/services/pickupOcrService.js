const { Readable } = require('stream');
const Ocr = require('@alicloud/ocr-api20210707');
const { Config } = require('@alicloud/openapi-client');
const { RuntimeOptions } = require('@alicloud/tea-util');
const { sequelize } = require('../models');
const ApiError = require('../utils/ApiError');
const { extractSerialCandidates } = require('./pickupOcrRules');

/** 检查真实图片签名，不接受 URL 或伪装为图片的任意文件。 */
function validateImage(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 10 * 1024 * 1024)
    throw ApiError.badRequest('请选择 10 MB 以内的图片');
  const jpeg = buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp =
    buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!(
    (jpeg && file.mimetype === 'image/jpeg') ||
    (png && file.mimetype === 'image/png') ||
    (webp && file.mimetype === 'image/webp')
  ))
    throw ApiError.badRequest('仅支持有效 JPG、PNG、WebP 图片');
}

/** 原子预占一次；失败不退款，防止未知结果重复扣费。 */
async function reserveQuota() {
  try {
    const limit = Number(process.env.PICKUP_OCR_MONTHLY_LIMIT || 1000);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new ApiError(503, 'OCR_NOT_CONFIGURED', 'OCR 月度额度配置无效');
    const [rows] = await sequelize.query(
      `INSERT INTO ocr_monthly_usage (month, used)
      VALUES (to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM'), 1)
      ON CONFLICT (month) DO UPDATE SET used = ocr_monthly_usage.used + 1
      WHERE ocr_monthly_usage.used < :limit RETURNING used`,
      { replacements: { limit } }
    );
    if (!rows.length)
      throw new ApiError(
        429,
        'OCR_MONTHLY_LIMIT',
        '本月 OCR 次数已达上限，请使用条码扫描或手动填写'
      );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'OCR_QUOTA_UNAVAILABLE', 'OCR 额度校验暂不可用');
  }
}

/** 仅解析文字与序列号候选，不向前端暴露供应商原始响应。 */
function parseResponse(body) {
  try {
    if (!body || (body.code && !['200', 'Success', 'OK'].includes(String(body.code))))
      throw new Error('invalid result');
    const data = JSON.parse(body.data);
    if (typeof data.content !== 'string') throw new Error('invalid content');
    // 行结构能避免全页 content 将不同字段拼成同一行。
    const words = Array.isArray(data.prism_wordsInfo)
      ? data.prism_wordsInfo
        .map(item => item.word)
        .filter(value => typeof value === 'string')
        .join('\n')
      : '';
    const candidates = [
      ...new Set([...extractSerialCandidates(words), ...extractSerialCandidates(data.content)]),
    ].slice(0, 20);
    return {
      candidates,
      requestId: typeof body.requestId === 'string' ? body.requestId : '',
      provider: 'aliyun',
    };
  } catch (_error) {
    throw new ApiError(502, 'OCR_FAILED', '云端识别结果异常，请重新拍摄标签后重试');
  }
}

/** 使用独立服务端凭据调用全文识别高精版一次，禁止自动重试。 */
async function recognize(file, parser = parseResponse) {
  try {
    validateImage(file);
    if (
      process.env.PICKUP_OCR_ENABLED !== 'true' ||
      !process.env.PICKUP_OCR_ACCESS_KEY_ID ||
      !process.env.PICKUP_OCR_ACCESS_KEY_SECRET
    )
      throw new ApiError(503, 'OCR_NOT_CONFIGURED', '图片识别服务尚未配置，请使用条码扫描');
    const client = new Ocr.default(
      new Config({
        accessKeyId: process.env.PICKUP_OCR_ACCESS_KEY_ID,
        accessKeySecret: process.env.PICKUP_OCR_ACCESS_KEY_SECRET,
        endpoint: 'ocr-api.cn-hangzhou.aliyuncs.com',
        protocol: 'HTTPS',
      })
    );
    await reserveQuota();
    const result = await client.recognizeAdvancedWithOptions(
      new Ocr.RecognizeAdvancedRequest({
        body: Readable.from(file.buffer),
        needRotate: true,
        row: true,
      }),
      new RuntimeOptions({
        autoretry: false,
        maxAttempts: 1,
        connectTimeout: 5000,
        readTimeout: 30000,
      })
    );
    return parser(result.body);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // SDK 错误可能含请求、响应及鉴权参数；不向日志或中间件传递原错误。
    throw new ApiError(502, 'OCR_FAILED', '阿里云识别失败或超时；未自动重试，请核对后重拍');
  }
}
module.exports = { validateImage, reserveQuota, parseResponse, recognize };
