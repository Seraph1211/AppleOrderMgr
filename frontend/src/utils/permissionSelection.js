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

/**
 * 保存初始已停用授权；面板不能新增或误撤销隐藏权限，也不补授其旧依赖。
 * @param {string[]} selected - 当前可见权限选择
 * @param {string[]} initial - 用户打开面板时的原授权
 * @param {Object[]} catalog - 包含 retired 标记的完整权限目录
 * @returns {string[]} 保留原已停用授权后的完整集合
 */
export function preserveRetiredPermissions(selected, initial, catalog) {
  const retired = new Set(catalog.filter(item => item.retired).map(item => item.code));
  return [
    ...new Set([
      ...selected.filter(code => !retired.has(code)),
      ...initial.filter(code => retired.has(code)),
    ]),
  ];
}
