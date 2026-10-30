const { decrypt, fault, hash } = require('./officialOrderSupport');

const EVIDENCE_VERSION_V2 = 2;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function parseObject(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw fault('HTTP_EVIDENCE_INPUT_INVALID');
    }
    return value;
  } catch (error) {
    if (error.code) throw error;
    throw fault('HTTP_EVIDENCE_INPUT_INVALID');
  }
}

function bodyFile(index, sha256) {
  return `body-${index}-${sha256.slice(0, 16)}.enc`;
}

function validateCommon({ runId, index, observedAt, request, response, body, file }) {
  const observed = Date.parse(observedAt);
  const requestObserved = Date.parse(request?.observedAt);
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(index) ||
    index < 1 ||
    !Buffer.isBuffer(body) ||
    body.length > MAX_BODY_BYTES ||
    !Number.isFinite(observed) ||
    !Number.isFinite(requestObserved) ||
    requestObserved > observed ||
    typeof response?.url !== 'string' ||
    response.url !== request.url ||
    !Number.isSafeInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    file !== bodyFile(index, hash(body))
  ) {
    throw fault('HTTP_EVIDENCE_BINDING_INVALID');
  }
}

/**
 * 创建不重复保存正文的官网 HTTP v2 响应元信息。
 * @param {object} options 已核验的传输响应、请求原字节及运行绑定。
 * @returns {object} 应整体 AES-GCM 加密后写入 response-N.enc 的元信息。
 */
function createHttpResponseEvidenceV2({
  response,
  requestBytes,
  runId,
  index,
  observedAt,
  bodyFile: file,
  body,
}) {
  if (!Buffer.isBuffer(requestBytes) || !Buffer.isBuffer(body) || !response) {
    throw fault('HTTP_EVIDENCE_INPUT_INVALID');
  }
  const request = parseObject(requestBytes);
  const encoded = response.bodyBase64;
  if (
    typeof encoded !== 'string' ||
    Buffer.from(encoded, 'base64').toString('base64') !== encoded ||
    !Buffer.from(encoded, 'base64').equals(body)
  ) {
    throw fault('HTTP_EVIDENCE_BODY_INVALID');
  }
  validateCommon({ runId, index, observedAt, request, response, body, file });
  const metadata = { ...response };
  for (const name of [
    'bodyBase64',
    'evidenceVersion',
    'request',
    'body',
    'observedAt',
    'runId',
    'index',
  ]) {
    delete metadata[name];
  }
  return {
    ...metadata,
    evidenceVersion: EVIDENCE_VERSION_V2,
    runId,
    index,
    observedAt,
    request: {
      file: `request-${index}.enc`,
      sha256: hash(requestBytes),
    },
    body: {
      encoding: 'identity',
      file,
      sha256: hash(body),
      length: body.length,
    },
  };
}

function readV1({ value, request, requestPlaintext, runId, index, readBody, expectedBodyFile }) {
  if (value.evidenceVersion !== undefined && value.evidenceVersion !== 1) {
    throw fault('HTTP_EVIDENCE_FORMAT_UNKNOWN');
  }
  if (typeof value.bodyBase64 !== 'string') throw fault('HTTP_EVIDENCE_BODY_INVALID');
  const body = Buffer.from(value.bodyBase64, 'base64');
  if (body.toString('base64') !== value.bodyBase64 || body.length > MAX_BODY_BYTES) {
    throw fault('HTTP_EVIDENCE_BODY_INVALID');
  }
  const file = bodyFile(index, hash(body));
  if (expectedBodyFile && expectedBodyFile !== file) {
    throw fault('HTTP_EVIDENCE_BINDING_INVALID');
  }
  const stored = readBody(file);
  if (!Buffer.isBuffer(stored) || !stored.equals(body)) throw fault('HTTP_EVIDENCE_BODY_INVALID');
  const observedAt = request.observedAt;
  validateCommon({ runId, index, observedAt, request, response: value, body, file });
  return {
    version: 1,
    request,
    response: value,
    body,
    bodyFile: file,
    requestPlaintext,
  };
}

function readV2({ value, request, requestPlaintext, runId, index, readBody, expectedBodyFile }) {
  if (
    value.evidenceVersion !== EVIDENCE_VERSION_V2 ||
    value.runId !== runId ||
    value.index !== index ||
    value.bodyBase64 !== undefined ||
    value.request?.file !== `request-${index}.enc` ||
    value.request?.sha256 !== hash(requestPlaintext) ||
    value.body?.encoding !== 'identity' ||
    !SHA256.test(value.body?.sha256 || '') ||
    !Number.isSafeInteger(value.body?.length) ||
    value.body.length < 0 ||
    value.body.length > MAX_BODY_BYTES ||
    value.body.file !== bodyFile(index, value.body.sha256) ||
    (expectedBodyFile && expectedBodyFile !== value.body.file)
  ) {
    throw fault('HTTP_EVIDENCE_BINDING_INVALID');
  }
  const body = readBody(value.body.file);
  if (
    !Buffer.isBuffer(body) ||
    body.length !== value.body.length ||
    hash(body) !== value.body.sha256
  ) {
    throw fault('HTTP_EVIDENCE_BODY_INVALID');
  }
  validateCommon({
    runId,
    index,
    observedAt: value.observedAt,
    request,
    response: value,
    body,
    file: value.body.file,
  });
  const rest = { ...value };
  for (const name of ['evidenceVersion', 'runId', 'index', 'request', 'body']) delete rest[name];
  return {
    version: value.evidenceVersion,
    request,
    response: rest,
    body,
    bodyFile: value.body.file,
    requestPlaintext,
  };
}

/**
 * 解密并统一核验官网 HTTP v1/v2 请求、响应和单份正文。
 * @param {object} options 密文、运行绑定和受限正文读取回调。
 * @returns {object} 统一的请求、响应、正文及原始明文字节。
 */
function readHttpResponseEvidence({
  responseBytes,
  requestBytes,
  key,
  runId,
  index,
  readBody,
  expectedBodyFile,
}) {
  if (
    !Buffer.isBuffer(responseBytes) ||
    !Buffer.isBuffer(requestBytes) ||
    !Buffer.isBuffer(key) ||
    typeof readBody !== 'function'
  ) {
    throw fault('HTTP_EVIDENCE_INPUT_INVALID');
  }
  const responsePlaintext = decrypt(responseBytes, key);
  const requestPlaintext = decrypt(requestBytes, key);
  const value = parseObject(responsePlaintext);
  const request = parseObject(requestPlaintext);
  const input = {
    value,
    request,
    requestPlaintext,
    runId,
    index,
    readBody,
    expectedBodyFile,
  };
  const evidence = value.evidenceVersion === EVIDENCE_VERSION_V2 ? readV2(input) : readV1(input);
  return { ...evidence, responsePlaintext };
}

module.exports = {
  EVIDENCE_VERSION_V2,
  MAX_BODY_BYTES,
  createHttpResponseEvidenceV2,
  readHttpResponseEvidence,
};
