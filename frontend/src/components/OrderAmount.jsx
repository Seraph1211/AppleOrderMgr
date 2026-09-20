/** 按平台价格映射计算的金额，缺失与零值分别显示。 */
export default function OrderAmount({ amount, compact = false }) {
  const known =
    amount !== null && amount !== undefined && amount !== '' && Number.isFinite(Number(amount));
  return (
    <span className={`block ${compact ? 'mt-1 text-xs' : 'text-sm'}`}>
      <span className="font-medium text-gray-900">
        {known
          ? `¥${Number(amount).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : '待确认'}
      </span>
      <span className="ml-2 text-xs text-gray-500">按官方售价计算</span>
    </span>
  );
}
