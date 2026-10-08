/**
 * 仅在用户操作时修改权限；加载、回显、保存不做自动归一化。
 * @param {string[]} selected 当前权限
 * @param {Object[]} catalog 服务端目录
 * @param {string[]} codes 操作的权限
 * @param {boolean} checked 是否授予
 * @returns {string[]} 修改后的完整权限集合
 */
export function changePermissionSelection(selected, catalog, codes, checked) {
  const next = new Set(selected);
  const byCode = new Map(catalog.map(item => [item.code, item]));
  if (checked) {
    const visited = new Set();
    const add = code => {
      const item = byCode.get(code);
      if (!item || item.adminReserved || visited.has(code)) return;
      visited.add(code);
      next.add(code);
      (item.dependencies || []).forEach(add);
    };
    codes.forEach(add);
  } else {
    const removed = new Set(codes);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of catalog) {
        if (!removed.has(item.code) && item.dependencies.some(code => removed.has(code))) {
          removed.add(item.code);
          changed = true;
        }
      }
    }
    removed.forEach(code => next.delete(code));
  }
  return [...next];
}

/** @returns {'all'|'partial'|'none'} 组合状态；不补齐旧账号部分授权。 */
export function getPermissionSelectionState(selected, codes) {
  const count = codes.filter(code => selected.includes(code)).length;
  return count === codes.length ? 'all' : count ? 'partial' : 'none';
}
