import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatTimestamp } from './applePurchaseAvailabilityFilters';

const CHANGE_LABELS = {
  baseline_created: '建立基线',
  configuration_updated: '配置更新',
  monitor_started: '启动监控',
  monitor_stopped: '停止监控',
  task_demand_updated: '任务需求更新',
};
const STATE_LABELS = { running: '运行中', stopped: '已停止', paused: '已暂停' };

function ConfigurationDetail({ item }) {
  const config = item.configuration;
  if (!config) return <p className="apav-muted">该记录未同步配置快照。</p>;
  const cities = new Map();
  for (const store of config.stores) {
    const city = store.city || '未标注城市';
    if (!cities.has(city)) cities.set(city, []);
    cities.get(city).push(store.name);
  }
  return (
    <>
      <h3>变更后的配置</h3>
      <p className="apav-muted">
        {STATE_LABELS[config.state] || '状态未记录'} · 修订 {item.revision ?? '—'} · {item.terminal}
      </p>
      <h4>监控机型与规格 · {config.products.length} 项</h4>
      {config.products.length ? (
        <ul className="apav-config-specs">
          {config.products.map((product, index) => (
            <li key={index}>{product.specification || product.name}</li>
          ))}
        </ul>
      ) : (
        <p className="apav-muted">该记录未列出监控机型。</p>
      )}
      <h4>监控门店 · {config.stores.length} 家</h4>
      {cities.size ? (
        <dl className="apav-config-stores">
          {[...cities].map(([city, stores]) => (
            <div key={city}>
              <dt>{city}</dt>
              <dd>{stores.join('、')}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="apav-muted">该记录未列出监控门店。</p>
      )}
    </>
  );
}

/** 展示公开的检测任务历史以及所选记录对应的配置快照。 */
export default function ApplePurchaseAvailabilityChanges({
  data,
  loading,
  error,
  hasPrevious,
  onPrevious,
  onNext,
  onRefresh,
  hasNew,
}) {
  const [selected, setSelected] = useState(null);
  const items = data?.items ?? [];
  const current = items.find(item => item.sequence === selected) ?? items[0];
  return (
    <>
      <div className="apav-results-head">
        <p>选择一条历史记录，查看当时的监控范围。时间为北京时间。</p>
        {hasNew && (
          <button type="button" className="btn btn-secondary" onClick={onRefresh}>
            有新配置，刷新
          </button>
        )}
      </div>
      {current && (
        <div className="apav-config-layout">
          <ul className="apav-config-history" aria-label="任务历史">
            {items.map(item => (
              <li key={item.sequence}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-pressed={item.sequence === current.sequence}
                  onClick={() => setSelected(item.sequence)}
                >
                  <strong>{CHANGE_LABELS[item.changeType] || '监控变更'}</strong>
                  <time dateTime={item.changedAt}>{formatTimestamp(item.changedAt)}</time>
                </button>
              </li>
            ))}
          </ul>
          <section className="apav-config-detail" aria-label="变更后的配置">
            <ConfigurationDetail item={current} />
          </section>
        </div>
      )}
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
