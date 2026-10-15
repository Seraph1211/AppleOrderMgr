import { resolveProductName } from '../utils/productNaming';

/** 名称映射与待核对提示仅用于展示，不改写编辑草稿或来源字段。 */
export default function ProductName({ product }) {
  const result = resolveProductName(product);
  return (
    <span className="whitespace-normal break-words">
      {result.name || '—'}
      {(result.needsReview || product?.filterNeedsReview || product?.nameNeedsReview) && (
        <span className="ml-1 text-xs text-amber-700">商品信息待核对</span>
      )}
    </span>
  );
}
