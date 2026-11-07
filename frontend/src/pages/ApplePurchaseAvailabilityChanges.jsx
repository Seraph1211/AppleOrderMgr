import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDate, formatTime } from './applePurchaseAvailabilityFilters';

const CHANGE_LABELS = {
  baseline_created: '建立基线',
  configuration_updated: '配置更新',
  monitor_started: '启动监控',
  monitor_stopped: '停止监控',
  task_demand_updated: '任务需求更新',
};
const FIELD_LABELS = { stores: '监控门店', products: '监控料号', tasks: '任务需求' };
const STATE_LABELS = { running: '运行中', stopped: '已停止', paused: '已暂停' };

function describe(change) {
  if (change.kind === 'state') {
    return `监控状态 ${STATE_LABELS[change.before] ?? '—'} → ${STATE_LABELS[change.after]}`;
  }
  const difference = [
    change.added ? `新增 ${change.added}` : '',
    change.removed ? `移除 ${change.removed}` : '',
  ].filter(Boolean);
  return `${FIELD_LABELS[change.kind]} ${change.before} → ${change.after}（${difference.join('、')}）`;
}

/** 在有货页展示检测任务的公开变更摘要。 */
export default function ApplePurchaseAvailabilityChanges({
  data,
  loading,
  error,
  hasPrevious,
  onPrevious,
  onNext,
  onRefresh,
}) {
  const items = data?.items ?? [];
  return (
    <>
      <div className="apav-results-head">
        <p>按同步记录倒序 · 变更时间为北京时间</p>
      </div>
      <table className="apav-table apav-changes-table">
        <thead>
          <tr>
            <th scope="col" className="apav-time">
              变更时间
            </th>
            <th scope="col">类型／来源</th>
            <th scope="col">变更摘要</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.sequence}>
              <td className="apav-time">
                <time dateTime={item.changedAt}>
                  <strong>{formatTime(item.changedAt)}</strong>
                  <small>{formatDate(item.changedAt)}</small>
                </time>
              </td>
              <td>
                <strong>{CHANGE_LABELS[item.changeType] || '监控变更'}</strong>
                <small>{item.terminal}</small>
              </td>
              <td>
                <div>
                  修订 {item.previousRevision ?? '—'} → {item.revision ?? '—'}
                </div>
                {item.changes.length > 0 && (
                  <ul className="apav-change-summary">
                    {item.changes.map(change => (
                      <li key={change.kind}>{describe(change)}</li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && !data && (
        <p className="apav-empty" role="status">
          正在加载检测任务配置变更…
        </p>
      )}
      {error && (
        <p className="apav-empty" role="alert">
          {error.message}{' '}
          <button type="button" className="btn btn-secondary" onClick={onRefresh}>
            重试
          </button>
        </p>
      )}
      {!loading && data && !items.length && <p className="apav-empty">暂无检测任务配置变更。</p>}
      <footer className="apav-pagination">
        <p>{items.length ? `本页 ${items.length} 条` : '—'}</p>
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onPrevious}
            disabled={loading || !hasPrevious}
          >
            <ChevronLeft size={15} aria-hidden="true" />
            上一页
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onNext}
            disabled={loading || !data?.nextCursor}
          >
            下一页
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      </footer>
    </>
  );
}
