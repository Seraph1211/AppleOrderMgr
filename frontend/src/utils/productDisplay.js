import { resolveProductName } from './productNaming.js';

/**
 * 按已确认身份合并名称变体的展示数量，不修改原始明细或推算未知数量。
 * @param {Array} products - 订单商品明细
 * @returns {Array<{name: string, quantity: number|null}>} 保留首次出现顺序的展示项
 */
export function groupDisplayProducts(products) {
  const groups = new Map();
  for (const [productIndex, product] of (Array.isArray(products) ? products : []).entries()) {
    const resolution = resolveProductName(product);
    const name = resolution.name.trim();
    if (!name) continue;
    const model = String(product?.model || '').trim();
    const rawQuantity = product?.quantity;
    const parsed =
      typeof rawQuantity === 'string' && rawQuantity.trim() ? Number(rawQuantity) : rawQuantity;
    const quantity = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    const key = resolution.matched
      ? JSON.stringify([
          resolution.identity,
          product?.productId || null,
          product?.product_id || null,
        ])
      : JSON.stringify([
          name,
          model,
          product?.sku || null,
          product?.skuCode || null,
          product?.partNumber || null,
          product?.product_sku || null,
          product?.productId || null,
          product?.product_id || null,
          product?.nameNeedsReview === true ? productIndex : null,
        ]);
    const existing = groups.get(key);
    if (!existing)
      groups.set(key, {
        name,
        ...(resolution.needsReview || product?.filterNeedsReview || product?.nameNeedsReview
          ? { filterNeedsReview: true }
          : {}),
        quantity,
        ...(product?.filterKeys
          ? {
              filterKeys: product.filterKeys,
              filterNeedsReview: Boolean(
                product.filterNeedsReview || product.nameNeedsReview || resolution.needsReview
              ),
            }
          : {}),
      });
    else {
      const sum =
        existing.quantity === null || quantity === null ? null : existing.quantity + quantity;
      if (product?.filterKeys)
        existing.filterKeys = [...new Set([...(existing.filterKeys || []), ...product.filterKeys])];
      if (product?.filterNeedsReview || product?.nameNeedsReview || resolution.needsReview)
        existing.filterNeedsReview = true;
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
