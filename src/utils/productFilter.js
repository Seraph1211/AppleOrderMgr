const { createHash } = require('node:crypto');

const text = value =>
  typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
const hash = value => createHash('sha256').update(value).digest('hex');

/** 仅识别完整零件编号形态，不把系列名或通用型号当作 SKU。 */
function normalizeSku(value) {
  const model = text(value).toUpperCase();
  return /^[A-Z0-9]{5,12}\/[A-Z0-9]{1,3}$/.test(model) ? model : '';
}

/** 归一化空白、容量单位及容量在名称中的位置，保留颜色和系列区别。 */
function normalizeProductName(value) {
  let name = text(value).toLowerCase();
  const capacities = [];
  name = name.replace(/\b(\d+(?:\.\d+)?)\s*(gb|tb|g|t)\b/gi, (_all, number, unit) => {
    capacities.push(`${number}${unit[0].toLowerCase()}b`);
    return ' ';
  });
  return [name.replace(/\s+/g, ' ').trim(), ...capacities].filter(Boolean).join(' ');
}

function compatible(left, right) {
  const leftSku = normalizeSku(left.model);
  const rightSku = normalizeSku(right.model);
  if (leftSku && rightSku && leftSku !== rightSku) return false;
  return (
    normalizeProductName(left.name || left.label) ===
    normalizeProductName(right.name || right.label)
  );
}

/**
 * 为当前商品构造持久化筛选索引；来源／旧项必须唯一且无冲突才继承。
 * @param {Array} products 当前有效商品
 * @param {Array} previous 已持久化的旧索引
 * @param {Array} source 来源快照商品
 * @returns {Array} 不含敏感信息的索引
 */
function buildProductFilterItems(products, previous = [], source = []) {
  const current = Array.isArray(products) ? products : [];
  const references = [
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(source) ? source : []),
  ];
  return current.map((product, productIndex) => {
    const label = text(product?.name || product?.model) || '商品名称待核实';
    const canonical = normalizeProductName(label);
    const ownModel = normalizeSku(product?.model);
    const sameName = references.filter(reference =>
      compatible({ ...product, name: label }, reference)
    );
    const models = [...new Set(sameName.map(item => normalizeSku(item.model)).filter(Boolean))];
    // 多商品名称相同但型号不同，不把缺失型号的项分配给任一 SKU。
    const currentModels = current
      .filter(item => normalizeProductName(item?.name) === canonical)
      .map(item => normalizeSku(item?.model))
      .filter(Boolean);
    const uniqueModels = [...new Set([...models, ...currentModels])];
    const model = ownModel || (uniqueModels.length === 1 ? uniqueModels[0] : '');
    const previousConflict =
      references.some(item => item.key?.startsWith('review:') && compatible(product, item)) ||
      false;
    const conflicts =
      previousConflict ||
      (ownModel &&
        references.some(
          reference => normalizeSku(reference.model) === ownModel && !compatible(product, reference)
        ) &&
        !sameName.some(reference => normalizeSku(reference.model) === ownModel));
    const key = conflicts
      ? `review:${hash(`${model}:${canonical}`)}`
      : model
        ? `sku:${model}:${hash(canonical)}`
        : `name:${hash(canonical)}`;
    const inheritable = sameName.filter(item => {
      if (conflicts) return false;
      return (
        normalizeSku(item.model) === model ||
        (!normalizeSku(item.model) && uniqueModels.length <= 1)
      );
    });
    // 不自动继承其他已明确型号的旧键；真实身份修正不继续命中原商品。
    const oldKeys = inheritable.flatMap(item => item.keys || []);
    const aliases = [
      ...new Set(
        [label, ...inheritable.flatMap(item => item.aliases || [item.name || item.label])]
          .map(text)
          .filter(Boolean)
      ),
    ];
    return {
      productIndex,
      key,
      keys: [...new Set([key, ...oldKeys])].filter(value => typeof value === 'string'),
      label,
      aliases,
      model: model || null,
      needsReview:
        !model ||
        Boolean(conflicts) ||
        references.some(
          reference =>
            normalizeProductName(reference.name || reference.label) === canonical &&
            normalizeSku(reference.model) &&
            ownModel &&
            normalizeSku(reference.model) !== ownModel
        ),
    };
  });
}

/** 按当前权限范围聚合候选，一个订单／任务在同一候选内只计一次。 */
function collectProductOptions(rows) {
  const options = new Map();
  const keyCounts = new Map();
  for (const row of rows) {
    const items = row.productFilterItems?.length
      ? row.productFilterItems
      : buildProductFilterItems(row.products, [], row.sourceSnapshot?.products);
    const rowKeys = new Set(items.flatMap(item => item.keys));
    for (const key of rowKeys) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    const seen = new Set();
    for (const item of items) {
      let option = options.get(item.key);
      if (!option) {
        option = {
          value: item.key,
          label: item.label,
          aliases: [],
          count: 0,
          needsReview: false,
          model: item.model,
          keys: [],
        };
        options.set(item.key, option);
      }
      option.keys = [...new Set([...option.keys, ...item.keys])];
      option.aliases = [...new Set([...option.aliases, ...item.aliases])];
      // 同 SKU 的显示名称固定选字典序首项，查询顺序变化不造成标签跳动。
      option.label = [option.label, item.label].sort((a, b) => a.localeCompare(b, 'zh-CN'))[0];
      option.needsReview ||= item.needsReview;
      if (!seen.has(item.key)) option.count++;
      seen.add(item.key);
    }
  }
  const identitiesByModel = new Map();
  for (const option of options.values()) {
    if (option.model) {
      const identities = identitiesByModel.get(option.model) || new Set();
      identities.add(option.value);
      identitiesByModel.set(option.model, identities);
    }
  }
  for (const option of options.values()) {
    if (option.model && identitiesByModel.get(option.model).size > 1) option.needsReview = true;
  }
  return [...options.values()]
    .map(({ model, ...option }) => ({
      ...option,
      keyCounts: Object.fromEntries(option.keys.map(key => [key, keyCounts.get(key) || 0])),
      label: `${option.label}${model ? ` · ${model}` : ' · 型号待核实'}${option.needsReview && model ? ' · 信息待核对' : ''}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

module.exports = {
  normalizeSku,
  normalizeProductName,
  buildProductFilterItems,
  collectProductOptions,
};
