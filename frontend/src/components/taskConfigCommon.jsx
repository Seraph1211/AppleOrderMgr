import { useMemo, useState } from 'react';
import ResponsiveSelect from './responsiveSelect';

/** 任务配置状态与实际采集运行状态独立。 */
export function TaskConfigStatus({ status }) {
  const labels = { active: '已生效', invalidated: '待更新', missing: '未导入' };
  return (
    <span className={`badge ${status === 'active' ? 'badge-info' : 'badge-gray'}`}>
      {labels[status] || '未知'}
    </span>
  );
}

/** 一个统一的行表，窄屏在表内横向滚动。 */
export function TaskConfigTable({ headers, children, empty, emptyText = '暂无配置数据' }) {
  return (
    <div className="task-config-table-frame" tabIndex={0} aria-label="任务配置数据表">
      <table className="task-config-table">
        <thead>
          <tr>
            {headers.map(header => (
              <th key={header.label || header} className={header.numeric ? 'task-num' : undefined}>
                {header.label || header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {empty ? (
            <tr>
              <td colSpan={headers.length} className="task-empty">
                {emptyText}
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}

/** 显示服务器计算的城市规格分母或版本差异，支持逐字段筛选。 */
export function TaskConfigScopeTable({ rows = [], diff = false }) {
  const [filters, setFilters] = useState({ city: '', model: '', color: '', capacity: '' });
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () =>
      rows.filter(row =>
        Object.entries(filters).every(([key, value]) => !value || row[key] === value)
      ),
    [rows, filters]
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 30));
  const currentPage = Math.min(page, pageCount);
  const headers = [
    '城市',
    '机型 / 颜色 / 容量',
    ...(diff
      ? [
          { label: '原任务数', numeric: true },
          { label: '新任务数', numeric: true },
          { label: '变化', numeric: true },
        ]
      : [{ label: '任务数', numeric: true }]),
  ];
  return (
    <div className="space-y-3">
      <div className="task-config-filters">
        {Object.entries({ city: '城市', model: '机型', color: '颜色', capacity: '容量' }).map(
          ([key, label]) => (
            <label key={key} className="task-config-field">
              {label}
              <ResponsiveSelect
                className="input"
                aria-label={`筛选${label}`}
                value={filters[key]}
                onChange={event => {
                  setFilters(current => ({ ...current, [key]: event.target.value }));
                  setPage(1);
                }}
              >
                <option value="">全部{label}</option>
                {[...new Set(rows.map(row => row[key]))].sort().map(value => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </ResponsiveSelect>
            </label>
          )
        )}
      </div>
      <p className="text-sm text-gray-600">
        共 {filtered.length} 个城市与规格组合；各城市与规格计数不能相加作为实例任务总数。
      </p>
      <TaskConfigTable
        headers={headers}
        empty={!filtered.length}
        emptyText="没有符合筛选条件的城市与规格"
      >
        {filtered.slice((currentPage - 1) * 30, currentPage * 30).map(row => (
          <tr key={JSON.stringify([row.city, row.model, row.color, row.capacity])}>
            <td>{row.city}</td>
            <td>
              <span>{row.model}</span>
              <span className="task-cell-sub">
                {row.color} · {row.capacity}
              </span>
            </td>
            {diff ? (
              <>
                <td className="task-num">{row.previousCount.toLocaleString()}</td>
                <td className="task-num font-semibold">{row.nextCount.toLocaleString()}</td>
                <td className={`task-num ${row.delta ? 'text-primary' : 'text-gray-600'}`}>
                  {row.delta > 0 ? '+' : ''}
                  {row.delta}
                </td>
              </>
            ) : (
              <td className="task-num font-semibold">{row.taskCount.toLocaleString()}</td>
            )}
          </tr>
        ))}
      </TaskConfigTable>
      {pageCount > 1 && (
        <div className="task-config-paging">
          <span>
            第 {currentPage} / {pageCount} 页
          </span>
          <button
            className="btn btn-secondary"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </button>
          <button
            className="btn btn-secondary"
            disabled={currentPage >= pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
