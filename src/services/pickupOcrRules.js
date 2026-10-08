/** 验证印刷序列号；文字 OCR 不适用条码 S 前缀剥离，也不猜测 O/0 等字符。 */
function normalizeOcrSerial(value) {
  const serial = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(serial) && /[A-Z]/.test(serial) ? serial : null;
}

/** 优先提取 Serial No. 后的号码；未识别字段名时只提供含数字的候选供人工核对。 */
function extractSerialCandidates(text) {
  if (typeof text !== 'string') return [];
  const normalized = text
    .toUpperCase()
    .replace(/\b(?:CMIIT\s*ID|IMEI\s*2?|EID|UPC)\b[^\n]*?(?=SERIAL|S\/N|\n|$)/g, ' ');
  const labeled = [];
  const labels = /(?:SERIAL\s*(?:NO\.?|NUMBER)?|S\/N)\s*[:.：]?\s*([A-Z0-9 \t]+)/g;
  for (const match of normalized.matchAll(labels)) {
    const words = match[1].trim().split(/\s+/);
    const direct = normalizeOcrSerial(words[0]);
    const joined = normalizeOcrSerial(words.join(''));
    if (direct || joined) labeled.push(direct || joined);
  }
  const fallback = (normalized.match(/\b[A-Z0-9]{10,12}\b/g) || [])
    .filter(value => /[0-9]/.test(value))
    .map(normalizeOcrSerial)
    .filter(Boolean);
  return [...new Set(labeled.length ? labeled : fallback)].slice(0, 20);
}

module.exports = { normalizeOcrSerial, extractSerialCandidates };
