const STATE_LABELS = {
  registered: '未入库',
  in_stock: '在库',
  sold: '已售',
  returned: '已退货',
};
const STATE_COLORS = {
  registered: '#d97706',
  in_stock: '#1e3a8a',
  sold: '#15803d',
  returned: '#64748b',
};

/** 每个分类均显示名称、数量及占比，长列表可滚动而不丢弃尾部类别。 */
function DistributionChart({ title, rows, total }) {
  const ordered = [...rows].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const max = Math.max(1, ...ordered.map(row => row.count));
  return (
    <figure className="stock-distribution rounded-lg border border-gray-200 bg-white p-4">
      <figcaption className="mb-3 font-medium text-gray-900">{title}</figcaption>
      <ul className="stock-distribution-list space-y-3" aria-label={title}>
        {ordered.map(row => (
          <li key={row.key} className="min-w-0">
            <div className="mb-1 flex min-w-0 items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 break-words text-gray-700">{row.label}</span>
              <span className="shrink-0 tabular-nums text-gray-700">
                {row.count} 台{' '}
                <span className="text-xs text-gray-500">
                  ({((row.count / total) * 100).toFixed(1)}%)
                </span>
              </span>
            </div>
            <svg width="100%" height="12" aria-hidden="true" className="block rounded">
              <rect width="100%" height="12" rx="3" fill="#eff6ff" />
              <rect
                width={`${(row.count / max) * 100}%`}
                height="12"
                rx="3"
                fill={row.color || '#1e3a8a'}
              />
            </svg>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** 三个图表只使用同一次全量统计响应，与下方表格共享筛选口径。 */
export default function StockStatisticsCharts({ data }) {
  if (!data.total) {
    return (
      <p role="status" className="rounded-lg bg-gray-50 p-6 text-center text-gray-500">
        当前筛选暂无设备，请调整状态或仓库。
      </p>
    );
  }
  return (
    <div className="stock-statistics-charts grid min-w-0 gap-4 md:grid-cols-2">
      <div className="min-w-0 md:col-span-2">
        <DistributionChart
          title="机型数量分布"
          rows={data.models.map(row => ({
            key: row.modelName,
            label: row.modelName,
            count: row.count,
          }))}
          total={data.total}
        />
      </div>
      <DistributionChart
        title="设备状态分布"
        rows={(data.states || []).map(row => ({
          key: row.state,
          label: STATE_LABELS[row.state] || row.state,
          count: row.count,
          color: STATE_COLORS[row.state],
        }))}
        total={data.total}
      />
      <DistributionChart
        title="仓库数量分布"
        rows={(data.warehouses || []).map(row => ({
          key: row.warehouseId || 'unassigned',
          label: row.warehouseName,
          count: row.count,
        }))}
        total={data.total}
      />
    </div>
  );
}
