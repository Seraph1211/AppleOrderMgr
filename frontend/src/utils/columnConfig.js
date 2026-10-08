/**
 * 合并默认列与本地保存配置，保留已保存的可见性和顺序。
 * 新增列放在已保存的普通列之后，固定列始终保持在末尾。
 * @param {Array<Object>} defaultColumns - 当前页面默认列定义
 * @param {Array<Object>} savedColumns - localStorage 中保存的列配置
 * @returns {Array<Object>} 可直接渲染的列配置
 */
export function mergeColumnConfig(defaultColumns, savedColumns) {
  if (!Array.isArray(savedColumns) || savedColumns.length === 0) {
    return defaultColumns.map(column => ({
      ...column,
      visible: column.defaultVisible,
    }));
  }

  const defaultsByKey = new Map(defaultColumns.map(column => [column.key, column]));
  const savedByKey = new Map();
  savedColumns.forEach((column, index) => {
    if (!column || typeof column.key !== 'string' || savedByKey.has(column.key)) return;
    savedByKey.set(column.key, { ...column, savedIndex: index });
  });

  const savedKeys = [...savedByKey.values()]
    .filter(column => defaultsByKey.has(column.key))
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.order) ? left.order : left.savedIndex;
      const rightOrder = Number.isFinite(right.order) ? right.order : right.savedIndex;
      return leftOrder - rightOrder || left.savedIndex - right.savedIndex;
    })
    .map(column => column.key);
  const newKeys = defaultColumns
    .filter(column => !savedByKey.has(column.key))
    .map(column => column.key);
  const orderedKeys = [...savedKeys, ...newKeys];

  return orderedKeys
    .map(key => {
      const column = defaultsByKey.get(key);
      const saved = savedByKey.get(key);
      return {
        ...column,
        visible: typeof saved?.visible === 'boolean' ? saved.visible : column.defaultVisible,
      };
    })
    .sort((left, right) => Number(Boolean(left.pinned)) - Number(Boolean(right.pinned)));
}

/** 首次恢复官网状态列，其他用户配置保持原样；后续保存不再强制位置。 */
export function restoreOfficialStatusColumn(columns) {
  const status = columns.find(column => column.key === 'officialOrderStatus');
  if (!status) return columns;
  const result = columns.filter(column => column.key !== status.key);
  const index = result.findIndex(column => column.key === 'orderNumber');
  result.splice(index + 1, 0, { ...status, visible: true });
  return result;
}

/** 迁移实际取货日期到取货信息之后，保留已保存可见性及其他列的相对顺序。 */
export function restoreActualPickupDateColumn(columns) {
  const column = columns.find(item => item.key === 'actualPickupDate');
  if (!column) return columns;
  const result = columns.filter(item => item.key !== column.key);
  const index = result.findIndex(item => item.key === 'emailPickupInfo');
  if (index < 0) return columns;
  result.splice(index + 1, 0, column);
  return result;
}
