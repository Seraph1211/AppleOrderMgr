import { formatProductCapacity, getProductDisplayName } from './productNaming.js';

/** 格式化容量展示；内部 GB 数值、筛选值和提交协议保持不变。 */
export function formatStorageCapacity(value) {
  return formatProductCapacity(value);
}

/** 映射完整商品名称或独立容量；未知及冲突内容保留，不替换非商品文本。 */
export function formatProductStorageText(value) {
  const text = String(value ?? '');
  const capacity = formatProductCapacity(text);
  return capacity !== text ? capacity : getProductDisplayName(text);
}
