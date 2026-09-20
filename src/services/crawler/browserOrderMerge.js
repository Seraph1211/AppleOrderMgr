const { mergeOfficialOrder } = require('./officialOrderData');

const BROWSER_FIELDS = [
  'sourceSnapshot',
  'status',
  'officialRawStatus',
  'officialStatusObservedAt',
  'officialStatusNeedsReview',
  'officialAllItemsTerminal',
  'officialStatusDescription',
  'products',
  'officialProducts',
];
const PRODUCT_FIELDS = ['name', 'model', 'quantity', 'status', 'statusDescription'];

function isStatusProductIssue(issue) {
  return issue.field === 'status' || /^products(?:\.|$)/.test(issue.field || '');
}

/** 复用商品匹配规则，仅合并浏览器获准更新的状态、商品及其校验元数据。 */
function mergeBrowserOrder(order, data, observedAt = new Date()) {
  const merged = mergeOfficialOrder(order, data, observedAt);
  const update = Object.fromEntries(
    BROWSER_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(merged, key)).map(key => [
      key,
      merged[key],
    ])
  );
  for (const key of ['products', 'officialProducts']) {
    if (update[key]) {
      update[key] = update[key].map(product =>
        Object.fromEntries(
          Object.entries(product).filter(([field]) => PRODUCT_FIELDS.includes(field))
        )
      );
    }
  }
  update.validationIssues = [
    ...(order.validationIssues || []).filter(issue => !isStatusProductIssue(issue)),
    ...merged.validationIssues.filter(isStatusProductIssue),
  ];
  update.validationStatus = update.validationIssues.length ? 'abnormal' : 'valid';
  update.anomalyDetectedAt = update.validationIssues.length
    ? order.anomalyDetectedAt || observedAt
    : null;
  update.officialFieldDiagnostics = { ...order.officialFieldDiagnostics };
  if (data.officialFieldDiagnostics?.statusDescription) {
    update.officialFieldDiagnostics.statusDescription =
      data.officialFieldDiagnostics.statusDescription;
  }
  return update;
}

module.exports = { mergeBrowserOrder };
