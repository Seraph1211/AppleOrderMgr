const { readPrivate, decrypt, hash, fault } = require('./officialOrderSupport');
const { parseOfficialOrderDetail } = require('./officialOrderParser');
const { validateReadUrl } = require('./officialOrderHttpCollector');

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
  const body = decrypt(readPrivate(`${directory}/${source.file}`, false), key);
  const response = JSON.parse(
    decrypt(readPrivate(`${directory}/response-${match[1]}.enc`, false), key)
  );
  const request = JSON.parse(
    decrypt(readPrivate(`${directory}/request-${match[1]}.enc`, false), key)
  );
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
    body.toString('base64') !== response.bodyBase64 ||
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
