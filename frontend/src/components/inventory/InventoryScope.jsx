import { timeText, STATUS } from './inventoryPresentation';

const STATE_TEXT = {
  normal: '采集运行正常',
  disabled: '采集已关闭',
  empty: '尚未配置完整监控范围',
  offline: '等待采集 Worker，暂无近期心跳',
  degraded: '采集异常，当前结果可能已过期',
  recovering: '正在恢复探测',
  cooldown: '采集保护冷却中',
  manual_required: '采集已暂停，等待管理员处理',
};

/** 只读监控范围，配置启用与实际采集状态分别展示。 */
export default function InventoryScope({ scope }) {
  if (!scope) return <p className="text-sm text-gray-500">正在加载监控范围…</p>;
  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-4 space-y-3"
      aria-label="已启用监控范围"
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h2 className="font-semibold text-gray-900">已启用的监控范围</h2>
        <span
          className={`text-sm ${scope.state === 'normal' ? 'text-green-700' : 'text-amber-800'}`}
        >
          {STATE_TEXT[scope.state] || STATUS[scope.state] || '状态待确认'}
        </span>
      </div>
      <p className="text-sm text-gray-600">
        {scope.products.length} 个商品配置 × {scope.stores.length} 家门店，共 {scope.combinations}{' '}
        个组合
      </p>
      <p className="text-xs text-gray-500">
        最近成功采集：{timeText(scope.lastSuccessAt)} · 以下为全局配置，个人筛选不改变此范围
      </p>
      <details className="border-t border-gray-100">
        <summary className="min-h-11 flex items-center cursor-pointer text-sm text-primary">
          查看已启用商品（{scope.products.length}）
        </summary>
        <ul
          className="divide-y divide-gray-100 max-h-72 overflow-y-auto"
          aria-label="已启用商品明细"
        >
          {scope.products.map(row => (
            <li key={row.sku} className="py-2 text-sm">
              <span className="font-medium">
                {row.model} · {row.capacity} · {row.color}
              </span>
              <span className="block text-xs text-gray-500 break-all">{row.sku}</span>
            </li>
          ))}
          {!scope.products.length && (
            <li className="py-3 text-sm text-gray-500">暂无已启用且支持的商品</li>
          )}
        </ul>
      </details>
      <details className="border-t border-gray-100">
        <summary className="min-h-11 flex items-center cursor-pointer text-sm text-primary">
          查看已启用门店（{scope.stores.length}）
        </summary>
        <ul
          className="divide-y divide-gray-100 max-h-72 overflow-y-auto"
          aria-label="已启用门店明细"
        >
          {scope.stores.map(row => (
            <li key={row.storeCode} className="py-2 text-sm">
              {row.city} · Apple {row.storeName}
              <span className="ml-2 text-xs text-gray-500">{row.storeCode}</span>
            </li>
          ))}
          {!scope.stores.length && <li className="py-3 text-sm text-gray-500">暂无已启用门店</li>}
        </ul>
      </details>
    </section>
  );
}
