const { fault, hash, permittedUrl } = require('./officialOrderSupport');

const MAX_REQUEST_EVIDENCE_BYTES = 262144;
const MAX_GUEST_REQUEST_EVIDENCE = 8;
const GUEST_PATH_PARTS = Object.freeze({ length: 6, order: 4, token: 5 });

function requestBody(request) {
  const text = typeof request.postData === 'string' ? Buffer.from(request.postData) : null;
  if (text && text.length > MAX_REQUEST_EVIDENCE_BYTES) throw fault('REQUEST_EVIDENCE_TOO_LARGE');
  const entries = request.postDataEntries;
  if (entries !== undefined && !Array.isArray(entries)) return { body: null, complete: false };
  if (!Array.isArray(entries)) {
    return {
      body: text,
      complete:
        !!text ||
        request.hasPostData === false ||
        (request.method === 'GET' && request.hasPostData !== true),
    };
  }
  const chunks = [];
  let bytes = 0;
  for (const entry of entries) {
    if (typeof entry?.bytes !== 'string') return { body: null, complete: false };
    if (entry.bytes.length > MAX_REQUEST_EVIDENCE_BYTES) throw fault('REQUEST_EVIDENCE_TOO_LARGE');
    const chunk = Buffer.from(entry.bytes, 'base64');
    if (chunk.toString('base64') !== entry.bytes) return { body: null, complete: false };
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_EVIDENCE_BYTES) throw fault('REQUEST_EVIDENCE_TOO_LARGE');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  return {
    body,
    complete: (entries.length > 0 || request.hasPostData === false) && (!text || text.equals(body)),
  };
}

/**
 * 为当前订单的只读访客动作构造私密请求证据；返回值含敏感内容，必须加密保存。
 * @param {object} request 浏览器原始请求，不修改或重新发出。
 * @param {string} expectedOrderNumber 已验证的目标订单号。
 * @returns {object|null} 私密证据和可用于日志的脱敏摘要；其他动作返回 null。
 */
function buildGuestRequestEvidence(request, expectedOrderNumber) {
  if (!request || !/^W\d{10}$/.test(expectedOrderNumber || '')) return null;
  let url;
  try {
    url = permittedUrl(request.url);
  } catch (_error) {
    return null;
  }
  const parts = url.pathname.split('/');
  if (
    !/^(?:secure\d*\.)?www\.apple\.com\.cn$/.test(url.hostname) ||
    url.hash ||
    parts.length !== GUEST_PATH_PARTS.length ||
    parts.slice(1, GUEST_PATH_PARTS.order).join('/') !== 'shop/orderx/guestx' ||
    parts[GUEST_PATH_PARTS.order] !== expectedOrderNumber ||
    !/^[A-Za-z0-9_%=-]+$/.test(parts[GUEST_PATH_PARTS.token]) ||
    url.searchParams.getAll('_a').length !== 1 ||
    url.searchParams.get('_a') !== 'fetchOrder' ||
    url.searchParams.getAll('_m').length !== 1 ||
    url.searchParams.get('_m') !== 'guestOrderSpinner' ||
    !['GET', 'POST'].includes(request.method)
  )
    return null;

  const hasTextBody = typeof request.postData === 'string';
  const { body, complete: bodyComplete } = requestBody(request);
  const headersComplete =
    !!request.headers &&
    typeof request.headers === 'object' &&
    !Array.isArray(request.headers) &&
    Object.values(request.headers).every(value => typeof value === 'string');
  const evidence = {
    version: 1,
    phase: 'before_dispatch',
    url: request.url,
    method: request.method,
    headers: headersComplete ? request.headers : null,
    headersComplete,
    hasPostData: request.hasPostData ?? null,
    postData: hasTextBody ? request.postData : null,
    postDataEntriesPresent: Array.isArray(request.postDataEntries),
    bodyBase64: body ? body.toString('base64') : null,
    bodyComplete,
  };
  const encoded = JSON.stringify(evidence);
  if (Buffer.byteLength(encoded) > MAX_REQUEST_EVIDENCE_BYTES)
    throw fault('REQUEST_EVIDENCE_TOO_LARGE');
  return {
    evidence,
    summary: {
      method: request.method,
      urlHash: hash(request.url),
      headerCount: headersComplete ? Object.keys(request.headers).length : null,
      headersComplete,
      postDataBytes: hasTextBody ? Buffer.byteLength(request.postData) : null,
      bodyBytes: body ? body.length : null,
      bodyComplete,
    },
  };
}

module.exports = { buildGuestRequestEvidence, MAX_GUEST_REQUEST_EVIDENCE };
