import { groupDisplayProducts } from '../utils/productDisplay';

/** 保留完整商品与合计数量，以已生效的商品条件高亮命中项。 */
export default function ProductSummary({ products, selectedKeys = [] }) {
  const groups = groupDisplayProducts(products);
  if (!groups.length) return '-';
  return (
    <div className="max-w-xs space-y-1 whitespace-normal break-words">
      {groups.map((product, index) => (
        <div key={index}>
          <span
            className={
              product.filterKeys?.some(key => selectedKeys.includes(key))
                ? 'rounded bg-primary-light font-medium text-primary'
                : ''
            }
          >
            {product.name} ×{product.quantity ?? '待核实'}
          </span>
          {product.filterNeedsReview && (
            <span className="ml-1 text-xs text-amber-700">商品信息待核对</span>
          )}
        </div>
      ))}
    </div>
  );
}
