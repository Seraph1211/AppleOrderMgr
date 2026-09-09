const fs = require('fs');
const axios = require('axios');

const ENDPOINT = 'https://zidv2.market.alicloudapi.com/idcheck/Post';

/** 只从服务器环境或指定文件加载已有凭据。 @returns {string} AppCode */
function getAppCode() {
  try {
    const value =
      process.env.IDENTITY_APPCODE ||
      (process.env.IDENTITY_APPCODE_FILE
        ? fs.readFileSync(process.env.IDENTITY_APPCODE_FILE, 'utf8')
        : '');
    return /^[a-zA-Z0-9]{16,128}$/.test(value.trim()) ? value.trim() : '';
  } catch (_error) {
    return '';
  }
}

/** 返回无凭据的服务就绪状态。 @returns {Object} 状态 */
function getStatus() {
  return {
    configured: Boolean(getAppCode()),
    enabled: process.env.IDENTITY_VERIFICATION_ENABLED === 'true',
    maxRows: 1000,
    maxFileBytes: 10 * 1024 * 1024,
    requestsPerSecond: 2,
  };
}

/** 供应商结果严格映射，丢弃任意原始错误内容。 @returns {Object} 核验结果 */
function mapResponse(response) {
  const code = String(response.headers?.['x-ca-error-code'] || '');
  const errorText = String(response.headers?.['x-ca-error-message'] || '');
  if (response.status === 403 || response.status === 401) {
    const quota = /quota|exhaust|balance/i.test(code + errorText);
    return {
      status: 'error',
      fatal: true,
      message: quota ? '套餐额度不足，已暂停队列' : '接口鉴权失败或服务不可用，已暂停队列',
    };
  }
  if (response.status === 429)
    return { status: 'error', fatal: true, message: '供应商限流，已暂停队列，稍后手动继续' };
  if (response.status !== 200)
    return { status: 'unknown', message: '供应商未返回正常结果，请核对调用记录后再处理' };
  const body = response.data;
  if (!body || ![0, '0'].includes(body.error_code) || typeof body.result?.isok !== 'boolean')
    return { status: 'unknown', message: '供应商返回异常或无法判断，未自动重试' };
  const info = body.result.IdCardInfor || {};
  const resultData = {};
  for (const [key, value] of Object.entries({
    sn: body.sn,
    sex: info.sex,
    birthday: info.birthday,
    area: info.area,
    province: info.province,
    city: info.city,
    district: info.district,
  })) {
    if (typeof value === 'string') resultData[key] = value.slice(0, 200);
  }
  return {
    status: body.result.isok ? 'matched' : 'mismatched',
    message: body.result.isok ? '姓名与身份证号一致' : '姓名与身份证号不一致',
    resultData,
  };
}

/** 调用已购服务一次，不自动重试，不经订单代理，拒绝重定向。 @returns {Promise<Object>} 结果 */
async function verifyIdentity(name, idCardNumber) {
  try {
    const appCode = getAppCode();
    if (!appCode) return { status: 'error', fatal: true, message: '身份核验服务尚未配置' };
    const response = await axios.post(
      ENDPOINT,
      new URLSearchParams({
        realName: name.trim(),
        cardNo: idCardNumber.trim().toUpperCase(),
      }).toString(),
      {
        headers: {
          Authorization: `APPCODE ${appCode}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        timeout: 8000,
        maxRedirects: 0,
        proxy: false,
        maxContentLength: 65536,
        validateStatus: () => true,
      }
    );
    return mapResponse(response);
  } catch (_error) {
    return { status: 'unknown', message: '请求超时或连接中断，结果未知；为避免重复扣次未自动重试' };
  }
}

module.exports = { getStatus, verifyIdentity, mapResponse };
