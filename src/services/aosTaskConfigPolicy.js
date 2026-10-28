const { createHash } = require('crypto');
const stores = require('../config/proxyStores.json');
const { resolveProductName } = require('../utils/productNaming');
const ApiError = require('../utils/ApiError');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 10000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeKey = row => digest([row.city, row.model, row.color, row.capacity]);
const normalizeStore = value =>
  value
    .normalize('NFKC')
    .replace(/Apple\s*/gi, '')
    .replace(/\s/g, '');
const storeNames = new Map();
for (const store of stores) {
  for (const name of [store.code, store.name, `${store.city}${normalizeStore(store.name)}`]) {
    const key = normalizeStore(name);
    const values = storeNames.get(key) || [];
    if (!values.some(row => row.code === store.code)) values.push(store);
    storeNames.set(key, values);
  }
}

// 一行一个任务：支持 CSV 引号和双引号转义，不接受跨物理行字段。
function fieldsOf(line) {
  const values = [];
  let value = '';
  let quoted = false;
  let closed = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else value += char;
    } else if (char === ',') {
      values.push(value);
      value = '';
      closed = false;
    } else if (char === '"' && value === '' && !closed) quoted = true;
    else if (char === '"' || closed) return null;
    else value += char;
  }
  if (quoted) return null;
  values.push(value);
  return values;
}

/** 只从任务行生成城市与规格计数，不以账号、行内容或购买数量去重。 @param {Object[]} rows 脱敏任务行 @returns {Object[]} 汇总 */
function aggregate(rows) {
  const values = new Map();
  for (const row of rows) {
    for (const city of new Set(row.cities)) {
      const scope = { city, model: row.model, color: row.color, capacity: row.capacity };
      const key = scopeKey(scope);
      const entry = values.get(key) || { ...scope, taskCount: 0 };
      entry.taskCount += 1;
      values.set(key, entry);
    }
  }
  return [...values.values()].sort((a, b) =>
    [a.city, a.model, a.color, a.capacity]
      .join('|')
      .localeCompare([b.city, b.model, b.color, b.capacity].join('|'), 'zh-CN')
  );
}

/** 解析36字段文本；错误仅含行号及固定说明，原始秘密不进入返回值。 @param {string} text 配置原文 @returns {Object} 脱敏解析 */
function parse(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES)
    throw ApiError.badRequest('请提供不超过8MiB的配置文本');
  const rows = [];
  const errors = [];
  let blankLineCount = 0;
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_ROWS * 2) throw ApiError.badRequest('配置文本行数过多');
  const error = (rowNumber, field, code, message) => {
    if (errors.length < 100) errors.push({ rowNumber, field, code, message });
  };
  let taskLineCount = 0;
  for (const [index, line] of lines.entries()) {
    const rowNumber = index + 1;
    if (!line.trim()) {
      blankLineCount += 1;
      continue;
    }
    taskLineCount += 1;
    if (taskLineCount > MAX_ROWS) throw ApiError.badRequest('每个实例最多导入10000行任务');
    const fields = fieldsOf(line);
    if (!fields || fields.length !== 36) {
      error(rowNumber, 'row', 'FIELD_COUNT', '必须为完整的36字段任务行，且不能包含跨行字段');
      continue;
    }
    if (!fields[0].trim()) {
      error(rowNumber, 'row', 'TASK_IDENTITY_EMPTY', '任务配置首字段不能为空');
      continue;
    }
    if (!/^[1-9]\d*$/.test(fields[4].trim())) {
      error(rowNumber, 'quantity', 'QUANTITY_INVALID', '购买数量必须是正整数，任务计数仍为1');
      continue;
    }
    const selections = fields[2].split('|').map(value => value.trim());
    const selected = selections.map(value => storeNames.get(normalizeStore(value)));
    if (selected.some(value => value?.length !== 1)) {
      error(rowNumber, 'stores', 'STORE_UNKNOWN', '门店为空、无法识别或归属不唯一，请检查第3字段');
      continue;
    }
    const product = resolveProductName(fields[3]);
    if (!product.matched) {
      error(
        rowNumber,
        'product',
        'PRODUCT_UNKNOWN',
        '商品规格无法唯一识别，请检查第4字段的机型、颜色和容量'
      );
      continue;
    }
    rows.push({
      rowNumber,
      storeCodes: [...new Set(selected.map(value => value[0].code))].sort(),
      cities: [...new Set(selected.map(value => value[0].city))].sort(),
      model: product.modelName,
      color: product.color,
      capacity: product.capacity,
    });
  }
  if (!taskLineCount) error(0, 'row', 'EMPTY_CONFIG', '配置没有任务，空文件不会清空现有配置');
  const aggregates = aggregate(rows);
  return {
    valid: errors.length === 0,
    errors,
    rows,
    aggregates,
    taskCount: rows.length,
    cityCount: new Set(aggregates.map(row => row.city)).size,
    specCount: new Set(rows.map(row => digest([row.model, row.color, row.capacity]))).size,
    blankLineCount,
    contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

/** 生成全量城市规格差异，含归零的旧范围。 @param {Object[]} before 原汇总 @param {Object[]} after 新汇总 @returns {Object[]} 差异 */
function differences(before, after) {
  const entries = new Map(
    before.map(row => [scopeKey(row), { ...row, previousCount: row.taskCount, nextCount: 0 }])
  );
  for (const row of after) {
    const key = scopeKey(row);
    entries.set(key, {
      ...row,
      previousCount: entries.get(key)?.previousCount || 0,
      nextCount: row.taskCount,
    });
  }
  return [...entries.values()].map(({ taskCount: _count, ...row }) => ({
    ...row,
    delta: row.nextCount - row.previousCount,
  }));
}

module.exports = { MAX_BYTES, MAX_ROWS, parse, aggregate, differences, digest, scopeKey };
