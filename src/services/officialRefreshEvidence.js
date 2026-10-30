const { readPrivate, decrypt, hash, fault } = require('./officialOrderSupport');
const { parseOfficialOrderDetail } = require('./officialOrderParser');
const { validateReadUrl } = require('./officialOrderHttpCollector');
const { readHttpResponseEvidence } = require('./officialHttpEvidence');

/** 从 AES-GCM 原响应重解析手动 HTTP 结果，不信任结果文件中的商品与日期。 */
function verifyRefreshEvidence(root, result) {
  const source = result?.source;
  const match = /^body-([1-9]\d*)-([a-f0-9]{16})\.enc$/.exec(source?.file || '');
  if (
    !match ||
    !Number.isSafeInteger(source?.runId) ||
    source.runId < 1 ||
    !/^[a-f0-9]{64}$/.test(source.sha256 || '') ||
    !source.sha256.startsWith(match[2])
  ) {
    throw fault('INVALID_OFFICIAL_RESULT');
  }
  const directory = `${root}/evidence/run-${source.runId}`;
  const key = readPrivate(`${root}/private/evidence.key`, false);
  const evidence = readHttpResponseEvidence({
    responseBytes: readPrivate(`${directory}/response-${match[1]}.enc`, false),
    requestBytes: readPrivate(`${directory}/request-${match[1]}.enc`, false),
    key,
    runId: source.runId,
    index: Number(match[1]),
    expectedBodyFile: source.file,
    readBody: file => decrypt(readPrivate(`${directory}/${file}`, false), key),
  });
  const { body, response, request } = evidence;
  const url = validateReadUrl(request.url, request.method);
  const events = readPrivate(`${directory}/events.jsonl`, false)
    .toString('utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const event = events.filter(row => row.file === source.file && row.message === 'http_response');
  if (
    response.status !== 200 ||
    source.status !== 200 ||
    source.cached !== false ||
    response.url !== url.href ||
    url.hostname !== source.host ||
    hash(url.href) !== source.urlHash ||
    hash(body) !== source.sha256 ||
    evidence.bodyFile !== source.file ||
    (evidence.version === 2 && response.observedAt !== source.observedAt) ||
    event.length !== 1 ||
    event[0].sha256 !== source.sha256 ||
    event[0].observedAt !== source.observedAt
  ) {
    throw fault('INVALID_OFFICIAL_RESULT');
  }
  const detail = parseOfficialOrderDetail(body.toString('utf8'), result.orderNumber);
  if (!detail) throw fault('INVALID_OFFICIAL_RESULT');
  return { systemOrderId: result.systemOrderId, ...detail, source };
}

module.exports = { verifyRefreshEvidence };
