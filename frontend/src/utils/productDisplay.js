/**
 * 合并同名同型号商品的展示数量，不修改原始明细或推算未知数量。
 * @param {Array} products - 订单商品明细
 * @returns {Array<{name: string, quantity: number|null}>} 保留首次出现顺序的展示项
 */
export function groupDisplayProducts(products) {
  const groups = new Map();
  for (const product of Array.isArray(products) ? products : []) {
    const name = String(product?.name || product?.model || '').trim();
    if (!name) continue;
    const model = String(product?.model || '').trim();
    const rawQuantity = product?.quantity;
    const parsed =
      typeof rawQuantity === 'string' && rawQuantity.trim() ? Number(rawQuantity) : rawQuantity;
    const quantity = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    const key = JSON.stringify([name, model]);
    const existing = groups.get(key);
    if (!existing) groups.set(key, { name, quantity });
    else {
      const sum =
        existing.quantity === null || quantity === null ? null : existing.quantity + quantity;
      existing.quantity = Number.isSafeInteger(sum) ? sum : null;
    }
  }
  return [...groups.values()];
}

/**
 * 返回订单列表共用商品文案。
 * @param {Array} products - 原始商品明细
 * @returns {string} 完整商品及合计数量
 */
export function formatProductSummary(products) {
  return (
    groupDisplayProducts(products)
      .map(product => `${product.name} ×${product.quantity ?? '待核实'}`)
      .join('、') || '-'
  );
}
