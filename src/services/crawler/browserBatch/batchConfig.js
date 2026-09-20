const fs = require('fs');
const path = require('path');

/** 创建不会携带 URL、令牌或浏览器原始错误的批量任务错误。 */
function batchError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** 只读取当前用户的私密普通文件，拒绝软链接和过宽的文件权限。 */
function readPrivateFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 1024 * 1024) {
      throw batchError('PRIVATE_FILE_REQUIRED');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** 校验隔离批次配置；不从浏览器提取登录凭证，不自动获取付费代理。 */
function validateBatchConfig(input) {
  const allowed = new Set([
    'apiBaseUrl',
    'tokenFile',
    'orderIds',
    'proxies',
    'concurrency',
    'checkpointFile',
    'executablePath',
    'headless',
  ]);
  if (!input || Object.keys(input).some(key => !allowed.has(key))) {
    throw batchError('INVALID_CONFIG');
  }
  let api;
  try {
    api = new URL(input.apiBaseUrl);
  } catch (_error) {
    throw batchError('INVALID_API_URL');
  }
  if (
    !['https:', 'http:'].includes(api.protocol) ||
    api.username ||
    api.password ||
    api.search ||
    api.hash ||
    !['/', '/api', '/api/'].includes(api.pathname) ||
    (api.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname))
  )
    throw batchError('INVALID_API_URL');
  const concurrency = input.concurrency ?? 10;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw batchError('INVALID_CONCURRENCY');
  }
  const ids = input.orderIds;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 1000 ||
    ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw batchError('INVALID_ORDER_IDS');
  }
  if (!Array.isArray(input.proxies) || input.proxies.length < concurrency) {
    throw batchError('INSUFFICIENT_PROXIES');
  }
  const proxies = input.proxies.map(value => {
    try {
      const proxy = new URL(value.includes('://') ? value : `socks5://${value}`);
      if (
        proxy.protocol !== 'socks5:' ||
        !proxy.hostname ||
        !proxy.port ||
        proxy.username ||
        proxy.password ||
        proxy.search ||
        proxy.hash ||
        !['', '/'].includes(proxy.pathname)
      )
        throw batchError('INVALID_PROXY');
      return `socks5://${proxy.host}`;
    } catch (_error) {
      throw batchError('INVALID_PROXY');
    }
  });
  if (new Set(proxies).size !== proxies.length) throw batchError('DUPLICATE_PROXY');
  for (const key of ['tokenFile', 'checkpointFile']) {
    if (typeof input[key] !== 'string' || !path.isAbsolute(input[key])) {
      throw batchError('ABSOLUTE_PATH_REQUIRED');
    }
  }
  if (input.tokenFile === input.checkpointFile) throw batchError('INVALID_CONFIG');
  if (
    input.executablePath !== undefined &&
    (typeof input.executablePath !== 'string' || !path.isAbsolute(input.executablePath))
  ) {
    throw batchError('ABSOLUTE_PATH_REQUIRED');
  }
  if (input.headless !== undefined && typeof input.headless !== 'boolean') {
    throw batchError('INVALID_CONFIG');
  }
  return {
    ...input,
    apiBaseUrl: `${api.origin}/api`,
    concurrency,
    proxies,
    orderIds: [...ids],
    headless: input.headless ?? false,
  };
}

module.exports = { batchError, readPrivateFile, validateBatchConfig };
