import { timeText } from './inventoryPresentation';
import { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Table } from './InventoryCommon';
/** 统一筛选的分布、热力图和榜单，缺口单独标记。 */
export default function InventoryAnalysisView({ data, onDrill }) {
  const [heatPage, setHeatPage] = useState(0);
  if (!data) return null;
  return (
    <div className="space-y-5">
      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-sm text-gray-700">
        <p>{data.notice}</p>
        <p className="mt-1">
          完整轮次 {data.coverage.complete} / 计划轮次 {data.coverage.planned} · 完整率{' '}
          {data.coverage.ratio === null ? '暂无计划' : `${(data.coverage.ratio * 100).toFixed(1)}%`}
        </p>
      </div>
      <section className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="font-medium mb-3">北京时间小时分布</h3>
        <div className="h-56 w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={[...data.hours].sort((a, b) => +a.key - +b.key)}>
              <XAxis dataKey="key" unit="时" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar
                isAnimationActive={false}
                dataKey="count"
                name="次数"
                fill="#1E3A8A"
                onClick={row => data.detailAvailable && onDrill('hours', row.key)}
                cursor={data.detailAvailable ? 'pointer' : 'default'}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap justify-between gap-2 mb-3">
          <h3 className="font-medium">时间热力图 · {data.bucketMinutes} 分钟</h3>
          <span className="text-xs text-gray-500">灰色：无数据或覆盖缺口 · 蓝色：有观测</span>
        </div>
        <div className="grid grid-cols-4 sm:grid-cols-8 lg:grid-cols-12 gap-2">
          {data.heatmap.slice(heatPage * 120, (heatPage + 1) * 120).map(row => (
            <button
              key={row.key}
              className={`rounded border p-2 min-h-[60px] text-xs ${row.gap ? 'bg-gray-100 border-dashed border-gray-300 text-gray-500' : row.count ? 'bg-blue-100 border-blue-200 text-primary' : 'bg-white border-gray-200 text-gray-600'}`}
              disabled={!data.detailAvailable}
              title={`${timeText(+row.key)}；${row.complete}/${row.planned} 轮完整`}
              onClick={() => onDrill('heatmap', row.key)}
            >
              <span className="block">
                {new Date(+row.key).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </span>
              <strong className="block mt-1">
                {row.count === null ? '缺口' : `${row.count} 次${row.gap ? ' / 缺口' : ''}`}
              </strong>
            </button>
          ))}
        </div>
        {data.heatmap.length > 120 && (
          <div className="flex gap-2 mt-3">
            <button
              className="btn inline-flex items-center justify-center gap-2 btn-secondary"
              disabled={!heatPage}
              onClick={() => setHeatPage(heatPage - 1)}
            >
              上一组
            </button>
            <button
              className="btn inline-flex items-center justify-center gap-2 btn-secondary"
              disabled={(heatPage + 1) * 120 >= data.heatmap.length}
              onClick={() => setHeatPage(heatPage + 1)}
            >
              下一组
            </button>
          </div>
        )}
      </section>
      {Object.entries({ configurations: '配置分布', cities: '城市榜单', stores: '门店榜单' }).map(
        ([key, label]) => (
          <section key={key}>
            <h3 className="font-medium mb-3">{label}</h3>
            <Table headers={[label, '次数', '明细']} empty={!data[key].length} label={label}>
              {data[key].map(row => (
                <tr key={row.key}>
                  <td className="px-3 py-3">{row.key}</td>
                  <td className="px-3 py-3 font-medium text-primary">{row.count}</td>
                  <td className="px-3 py-3">
                    <button
                      className="text-primary min-h-[44px] whitespace-nowrap disabled:text-gray-400"
                      disabled={!data.detailAvailable}
                      onClick={() => onDrill(key, row.key)}
                    >
                      {data.detailAvailable ? '查看记录' : '明细已清理'}
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          </section>
        )
      )}
    </div>
  );
}
