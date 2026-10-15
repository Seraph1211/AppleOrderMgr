/**
 * 展示商品容量；仅格式化容量字段，不修改内部 GB 数值或请求值。
 * @param {number|string} value 以 GB 为单位的容量数值
 * @returns {string} 1024 整倍数以 TB 展示，其他容量以 GB 展示
 */
export function formatStorageCapacity(value) {
  return value >= 1024 && value % 1024 === 0 ? `${value / 1024}TB` : `${value}GB`;
}

/**
 * 仅规范化商品展示文字中的明确容量标记，保留型号、SN 及原始业务文本。
 * @param {string} value 商品名称、型号或带单位的容量展示文本
 * @returns {string} 将独立的 1024/2048 GB 标记显示为 1TB/2TB 的新字符串
 */
export function formatProductStorageText(value) {
  return String(value ?? '').replace(
    /(^|[^a-z0-9_.+-])(1024|2048)\s*GB(?=$|[^a-z0-9_])/gi,
    (_match, prefix, capacity) => `${prefix}${Number(capacity) / 1024}TB`
  );
}
