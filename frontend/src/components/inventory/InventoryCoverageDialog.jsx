import { timeText } from './inventoryPresentation';
import { useEffect, useState } from 'react';
import { inventoryApi } from '../../api/inventoryApi';
import {
  Pager,
  Table,
  Status,
  InventoryDialog,
  CompactRecord,
  RecordFields,
} from './InventoryCommon';
/** 原生对话框提供焦点约束，手机短屏可滚动查看固定轮次覆盖。 */
export default function InventoryCoverageDialog({ id, onClose }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    const load = async () => {
      try {
        const result = await inventoryApi.get(`rounds/${encodeURIComponent(id)}`, { page });
        if (active) setData(result.data);
      } catch (failure) {
        if (active) setError(failure.message);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [id, page, retry]);
  return (
    <InventoryDialog
      title="固定轮次覆盖矩阵"
      onClose={onClose}
      className="inventory-coverage-dialog"
    >
      <div className="inventory-dialog-scroll p-4 space-y-4">
        {error && (
          <div role="alert" className="text-sm text-red-700">
            {error}
            <button className="ml-3 underline" onClick={() => setRetry(retry + 1)}>
              重试
            </button>
          </div>
        )}
        {!data && !error && <p role="status">加载中…</p>}
        {data && (
          <>
            <p className="text-sm text-gray-600">
              计划 {timeText(data.plannedAt)} · 完成 {data.completed} / {data.expected} · 失败{' '}
              {data.failed}
              {data.plannedCount > 1 ? ` · 含 ${data.plannedCount} 个错过的计划轮次` : ''}
            </p>
            {!data.detailAvailable ? (
              <p className="bg-amber-50 p-3 text-sm text-amber-800">
                逐组合明细已超保留期，只保留轮次汇总。
              </p>
            ) : (
              <>
                <Table
                  headers={['商品', '门店', '覆盖', '库存', '采集时间']}
                  mobileChildren={data.items.map(row => (
                    <CompactRecord
                      key={row.id}
                      title={row.model}
                      subtitle={`${row.capacity} · ${row.color} / ${row.city} ${row.storeName}`}
                      status={<Status value={row.stockStatus} />}
                    >
                      <RecordFields
                        fields={[
                          ['覆盖', <Status key="coverage" value={row.status} />],
                          ['采集时间', timeText(row.observedAt)],
                        ]}
                      />
                    </CompactRecord>
                  ))}
                  empty={!data.items.length}
                >
                  {data.items.map(row => (
                    <tr key={row.id}>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {row.model}
                        <p className="text-xs text-gray-500">
                          {row.capacity} · {row.color}
                        </p>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {row.city} · {row.storeName}
                      </td>
                      <td className="px-3 py-3">
                        <Status value={row.status} />
                      </td>
                      <td className="px-3 py-3">
                        <Status value={row.stockStatus} />
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap text-xs">
                        {timeText(row.observedAt)}
                      </td>
                    </tr>
                  ))}
                </Table>
                <Pager data={data} onChange={setPage} />
              </>
            )}
            <details>
              <summary className="text-primary text-sm min-h-[44px] cursor-pointer">
                查询任务与失败原因
              </summary>
              <Table
                headers={['地区邮编', 'SKU 数', '状态', '实际尝试', '原因']}
                empty={!data.tasks.length}
              >
                {data.tasks.map((task, index) => (
                  <tr key={index}>
                    <td className="px-3 py-3">{task.location}</td>
                    <td className="px-3 py-3">{task.skus.length}</td>
                    <td className="px-3 py-3">
                      <Status value={task.status} />
                    </td>
                    <td className="px-3 py-3">{task.attempts}</td>
                    <td className="px-3 py-3">{task.error || '—'}</td>
                  </tr>
                ))}
              </Table>
            </details>
          </>
        )}
      </div>
    </InventoryDialog>
  );
}
