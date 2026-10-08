const { CATALOG } = require('./stockFixedCatalog');
const { normalizeOcrSerial, extractSerialCandidates } = require('./pickupOcrRules');

const COLORS = [
  ['黑色', /\bblack\b|黑色/i],
  ['银色', /\bsilver\b|银色/i],
  ['冰川蓝色', /\bglacier(?:\s+blue)?\b|冰川蓝色?/i],
  ['勃艮第酒红色', /\bburgundy\b|勃艮第酒红色?/i],
];
const serialLabel = /(?:serial\s*(?:no\.?|number)?|s\/n)\s*[:.：]?\s*([a-z0-9]+)/gi;
function parseBlock(text, barcodes = []) {
  const reasons = [];
  const skuOccurrences = text.toUpperCase().match(/\b[A-Z0-9]{5}[A-Z]{1,3}\/A\b/g) || [];
  const skus = [...new Set(skuOccurrences)];
  if (skuOccurrences.length > 1 || [...text.matchAll(serialLabel)].length > 1)
    reasons.push('疑似多个盒标，请分图或逐台人工对应');
  const capacities = [
    ...new Set(
      [...text.matchAll(/\b(256|512|1024|2048)\s*G(?:B)?\b|\b([12])\s*T(?:B)?\b/gi)].map(match =>
        match[1] ? Number(match[1]) : Number(match[2]) * 1024
      )
    ),
  ];
  const colors = COLORS.filter(([, re]) => re.test(text)).map(([name]) => name);
  const models = [
    ...new Set(
      (text.match(/iphone\s*\d+\s*(?:pro\s*max|pro|air)?/gi) || []).map(value =>
        value.replace(/\s/g, '').toLowerCase()
      )
    ),
  ];
  const bySku = skus.length === 1 ? CATALOG.find(item => item.skuCode === skus[0]) : null;
  if (skus.length && !bySku) reasons.push('未知或多个料号，请核对');
  if (models.length > 1 || capacities.length > 1 || colors.length > 1)
    reasons.push('描述含多种规格，请核对对应关系');
  if (
    bySku &&
    ((models.length && models.some(model => model !== 'iphone18promax')) ||
      capacities.some(capacity => capacity !== bySku.storageGb) ||
      colors.some(color => color !== bySku.colorName))
  )
    reasons.push('料号与文字规格冲突');
  const byText =
    !skus.length &&
    models.length === 1 &&
    models[0] === 'iphone18promax' &&
    capacities.length === 1 &&
    colors.length === 1
      ? CATALOG.find(item => item.storageGb === capacities[0] && item.colorName === colors[0])
      : null;
  const spec = reasons.length ? null : bySku || byText;
  if (!spec && !reasons.length) reasons.push('规格不完整或不支持，请手工选择');
  const labeled = [
    ...new Set(
      [...text.matchAll(serialLabel)].map(match => normalizeOcrSerial(match[1])).filter(Boolean)
    ),
  ];
  const printed = labeled.length ? labeled : extractSerialCandidates(text);
  const decoded = [
    ...new Set(
      barcodes
        .map(value => {
          const raw = String(value).trim().toUpperCase();
          return normalizeOcrSerial(
            /^S(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(raw) ? raw.slice(1) : raw
          );
        })
        .filter(Boolean)
    ),
  ];
  const serials = [...new Set([...printed, ...decoded])];
  if (!labeled.length && printed.length) reasons.push('未识别 Serial 标签，请核对 SN');
  if (
    printed.length &&
    decoded.length &&
    (printed.length !== decoded.length || printed.some(value => !decoded.includes(value)))
  )
    reasons.push('SN 文字与条码不一致');
  if (serials.length > 1) reasons.push('同一盒标出现多个 SN，需逐台人工对应');
  if (!serials.length) reasons.push('未识别可信 SN，请手工填写');
  return {
    serialNumber: serials.length === 1 ? serials[0] : '',
    serialCandidates: serials,
    skuCode: skus.length === 1 ? skus[0] : null,
    modelName: spec?.modelName || null,
    storageGb: spec?.storageGb || null,
    colorName: spec?.colorName || null,
    matchBasis: spec ? (bySku ? 'sku' : 'description') : null,
    reviewReasons: reasons,
    sources: {
      serial: labeled.length ? 'serial_label' : decoded.length ? 'barcode' : 'unlabeled',
      specification: spec ? (bySku ? 'catalog_sku' : 'description') : null,
      barcodeChecked: Boolean(decoded.length),
    },
  };
}
/** 合并同图 OCR 拆段；当前多盒空间关系无法可靠证明时始终要求人工对应。 */
function parseBoxData(data, barcodes = []) {
  const words = (Array.isArray(data.prism_wordsInfo) ? data.prism_wordsInfo : []).filter(
    item => typeof item.word === 'string'
  );
  const text = words.length ? words.map(item => item.word).join('\n') : data.content || '';
  // 不以行顺序或粗略 y 轴分组；条码永远参与同图冲突检查。
  return [parseBlock(text, barcodes)];
}
module.exports = { parseBoxData };
