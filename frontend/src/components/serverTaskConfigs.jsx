import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, History, RefreshCw, Upload } from 'lucide-react';
import {
  confirmTaskConfig,
  getTaskConfig,
  getTaskConfigVersion,
  invalidateTaskConfig,
  listTaskConfigs,
  listTaskConfigVersions,
  restoreTaskConfig,
} from '../api/taskConfigsApi';
import TaskConfigImport from './taskConfigImport';
import { TaskConfigScopeTable, TaskConfigStatus, TaskConfigTable } from './taskConfigCommon';
import {
  taskConfigEffectiveAt,
  taskConfigError,
  taskConfigTime,
  taskConfigNeedsReview,
} from '../utils/taskConfigDisplay';
import '../styles/taskConfigs.css';

function TaskRows({ rows = [] }) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / 50));
  const currentPage = Math.min(page, pageCount);
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        保留原始行号及重复行，仅展示统计需要的门店、城市和商品规格。每行均计为 1 个任务。
      </p>
      <TaskConfigTable
        headers={[{ label: '原始行号', numeric: true }, '商品规格', '城市', '门店代码']}
        empty={!rows.length}
      >
        {rows.slice((currentPage - 1) * 50, currentPage * 50).map(row => (
          <tr key={row.rowNumber}>
            <td className="task-num">{row.rowNumber}</td>
            <td>
              {row.model}
              <span className="task-cell-sub">
                {row.color} · {row.capacity}
              </span>
            </td>
            <td className="task-cell-wrap">{row.cities.join('、')}</td>
            <td className="task-cell-wrap text-gray-600">{row.storeCodes.join('、')}</td>
          </tr>
        ))}
      </TaskConfigTable>
      {pageCount > 1 && (
        <div className="task-config-paging">
          <span>
            共 {rows.length} 个任务 · 第 {currentPage} / {pageCount} 页
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

function ConfigDetail({ instanceId, onBack, onChanged }) {
  const [data, setData] = useState(null);
  const [versions, setVersions] = useState([]);
  const [versionLimit, setVersionLimit] = useState(50);
  const [historical, setHistorical] = useState(null);
  const [view, setView] = useState('scopes');
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState(null);
  const [effectiveAt, setEffectiveAt] = useState('');
  const loadSequence = useRef(0);
  const actionRef = useRef(null);
  useEffect(() => {
    if (action) {
      actionRef.current?.focus({ preventScroll: true });
      actionRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [action]);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError('');
    try {
      const [next, history] = await Promise.all([
        getTaskConfig(instanceId),
        listTaskConfigVersions(instanceId),
      ]);
      if (sequence !== loadSequence.current) return;
      setData(next);
      setVersions(history.items);
      setVersionLimit(history.limit);
      setAction(null);
    } catch (loadError) {
      if (sequence === loadSequence.current) setError(taskConfigError(loadError));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [instanceId]);
  useEffect(() => {
    load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  async function saved(result, message) {
    try {
      setData(result);
      setImporting(false);
      setHistorical(null);
      setAction(null);
      setNotice(message);
      setView('scopes');
      await load();
      await onChanged();
    } catch (saveError) {
      setError(taskConfigError(saveError));
    }
  }

  async function mutate(event) {
    event.preventDefault();
    if (!action || !data || busy) return;
    setBusy(true);
    setError('');
    try {
      const revision = data.instance.revision;
      const result =
        action.type === 'restore'
          ? await restoreTaskConfig(instanceId, {
              versionId: action.version.id,
              expectedRevision: revision,
              effectiveAt: taskConfigEffectiveAt(effectiveAt),
            })
          : action.type === 'invalidate'
            ? await invalidateTaskConfig(instanceId, revision)
            : await confirmTaskConfig(instanceId, revision);
      await saved(
        result,
        {
          restore: '历史配置已作为新版本启用。',
          invalidate: '已标记为待更新，停止使用该配置作为通知分母；正常放货提醒继续发送。',
          confirm: '已确认配置未变，任务数没有增加。',
        }[action.type]
      );
    } catch (actionError) {
      setError(taskConfigError(actionError));
      if (actionError?.response?.status === 409) setAction(null);
    } finally {
      setBusy(false);
    }
  }

  async function viewVersion(versionId) {
    setBusy(true);
    setError('');
    try {
      const result = await getTaskConfigVersion(instanceId, versionId);
      setHistorical(result.version);
      setView('scopes');
    } catch (versionError) {
      setError(taskConfigError(versionError));
    } finally {
      setBusy(false);
    }
  }

  if (importing && data)
    return (
      <TaskConfigImport
        instance={data.instance}
        onCancel={() => setImporting(false)}
        onSaved={saved}
      />
    );
  const instance = data?.instance;
  const version = historical || data?.currentVersion;
  const changeAction = (type, item) => {
    setAction({ type, version: item });
    setEffectiveAt('');
    setNotice('');
  };
  return (
    <section className="task-config-panel" aria-busy={loading || busy}>
      <div className="task-config-title-row">
        <div>
          <button className="task-back" disabled={busy} onClick={onBack}>
            <ArrowLeft className="w-4 h-4" />
            全部实例
          </button>
          <h2 className="text-xl font-semibold text-gray-900 mt-3">
            {instance ? `${instance.serverName} / ${instance.instanceName}` : '实例任务配置'}
          </h2>
          {instance && (
            <p className="text-sm text-gray-600 mt-1">
              手动配置快照 · 最近确认 {taskConfigTime(instance.lastConfirmedAt)}
            </p>
          )}
        </div>
        <div className="task-config-actions">
          <button className="btn btn-secondary" disabled={loading || busy} onClick={load}>
            <RefreshCw className="w-4 h-4" />
            刷新
          </button>
          {instance?.active && (
            <button
              className="btn btn-primary"
              disabled={loading || busy}
              onClick={() => {
                setImporting(true);
                setNotice('');
              }}
            >
              <Upload className="w-4 h-4" />
              更新配置
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="task-config-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="task-config-note">
          {notice}
        </p>
      )}
      {loading && !data && (
        <p role="status" className="task-empty">
          正在读取任务配置…
        </p>
      )}
      {instance && (
        <>
          <div className="task-config-meta">
            <TaskConfigStatus status={instance.status} />
            <span>
              {historical
                ? `查看历史版本 V${version.number}`
                : version
                  ? `当前版本 V${version.number}`
                  : '尚无生效版本'}
            </span>
            <span>生效于 {taskConfigTime(version?.effectiveAt)}</span>
            {!instance.active && <span>实例已停用，仅可查看历史</span>}
          </div>
          <p className="text-sm text-gray-600">
            分母按城市 ×
            机型、颜色、容量统计。实例中的任务变动后，请重新导入；此处不代表任务实时运行状态。
          </p>
          {taskConfigNeedsReview(instance) && (
            <p className="task-config-note">
              超过 24 小时未确认，建议复核实例配置。此提示不表示配置失效，也不会改变通知分母。
            </p>
          )}
          {instance.status === 'invalidated' && (
            <p className="task-config-note">
              该实例已标记为待更新。下方保留上次配置供核对，放货通知暂不使用它作为分母。
            </p>
          )}
          {historical && (
            <div className="task-config-note flex flex-wrap items-center justify-between gap-2">
              <span>正在查看历史配置，尚未重新启用。</span>
              <button className="task-back" onClick={() => setHistorical(null)}>
                返回当前配置
              </button>
            </div>
          )}
          <dl className="task-config-summary">
            {[
              ['实例任务总数', version?.taskCount],
              ['覆盖城市', version?.cityCount],
              ['商品规格', version?.specCount],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value == null ? '—' : value.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          {instance.active && data.currentVersion && !historical && (
            <div className="task-config-actions">
              <button
                className="btn btn-secondary"
                disabled={busy || loading || instance.status !== 'active'}
                onClick={() => changeAction('confirm')}
              >
                <Check className="w-4 h-4" />
                确认配置未变
              </button>
              <button
                className="btn btn-secondary"
                disabled={busy || loading || instance.status !== 'active'}
                onClick={() => changeAction('invalidate')}
              >
                标记为待更新
              </button>
            </div>
          )}
          {action && (
            <form
              ref={actionRef}
              tabIndex={-1}
              onSubmit={mutate}
              className="task-config-confirm space-y-3"
            >
              <h3 className="font-semibold text-gray-900">
                {action.type === 'restore'
                  ? `重新启用 V${action.version.number}`
                  : action.type === 'invalidate'
                    ? '标记配置为待更新'
                    : '确认实例配置未变'}
              </h3>
              <p className="text-sm text-gray-700">
                {action.type === 'restore'
                  ? `将 ${action.version.taskCount} 个任务作为新的配置版本生效，保留现有历史。请确认实例实际下单配置也已同步。`
                  : action.type === 'invalidate'
                    ? '标记后该实例的放货通知将省略任务比例，直到重新导入配置。正常放货提醒继续发送。'
                    : '请确认实例目前的城市、门店、商品规格及任务行数与当前版本一致。仅更新确认时间，不增加任务。'}
              </p>
              {action.type === 'restore' && (
                <label className="task-config-field max-w-sm">
                  实际生效时间（北京时间，可选）
                  <input
                    className="input"
                    type="datetime-local"
                    step="1"
                    value={effectiveAt}
                    disabled={busy}
                    onChange={event => setEffectiveAt(event.target.value)}
                  />
                  <span className="text-sm text-gray-600">留空以确认时刻生效。</span>
                </label>
              )}
              <div className="task-config-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => setAction(null)}
                >
                  取消
                </button>
                <button className="btn btn-primary" disabled={busy || loading}>
                  {busy ? '正在保存…' : '确认操作'}
                </button>
              </div>
            </form>
          )}
          <div role="tablist" aria-label="实例任务配置详情" className="task-config-tabs">
            {[
              ['scopes', '城市与规格'],
              ['rows', '任务行'],
              ['history', '版本历史'],
            ].map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={view === key}
                className={view === key ? 'active' : ''}
                disabled={busy}
                onClick={() => {
                  setView(key);
                  setAction(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {view === 'scopes' &&
            (version ? (
              <TaskConfigScopeTable key={version.id} rows={version.aggregates} />
            ) : (
              <p className="task-empty">尚未导入任务配置。点击“更新配置”上传本实例的完整配置。</p>
            ))}
          {view === 'rows' && <TaskRows key={version?.id || 'empty'} rows={version?.rows} />}
          {view === 'history' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                最近 {versionLimit} 个版本；重新启用会创建新版本，不覆盖历史记录。
              </p>
              <TaskConfigTable
                headers={[
                  '版本 / 来源',
                  { label: '任务数', numeric: true },
                  '生效时间',
                  '导入时间 / 操作人',
                  '操作',
                ]}
                empty={!versions.length}
                emptyText="尚无导入历史"
              >
                {versions.map(item => (
                  <tr key={item.id}>
                    <td>
                      V{item.number}
                      <span className="task-cell-sub">
                        {item.source === 'restore' ? '历史恢复' : '完整导入'}
                      </span>
                    </td>
                    <td className="task-num">{item.taskCount.toLocaleString()}</td>
                    <td>
                      {taskConfigTime(item.effectiveAt)}
                      {item.effectiveTo && (
                        <span className="task-cell-sub">至 {taskConfigTime(item.effectiveTo)}</span>
                      )}
                    </td>
                    <td>
                      {taskConfigTime(item.createdAt)}
                      <span className="task-cell-sub">操作人 ID：{item.actorId || '—'}</span>
                    </td>
                    <td>
                      <div className="task-config-actions">
                        <button
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() => viewVersion(item.id)}
                        >
                          查看
                        </button>
                        {instance.active && (
                          <button
                            className="btn btn-secondary"
                            disabled={
                              busy ||
                              loading ||
                              (item.id === instance.currentVersionId &&
                                instance.status === 'active')
                            }
                            onClick={() => changeAction('restore', item)}
                          >
                            <History className="w-4 h-4" />
                            重新启用
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </TaskConfigTable>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** 实例任务配置入口，权限由父页面和服务端共同保护，不依赖采集器完整性。 */
export default function ServerTaskConfigs({ initialInstanceId = null }) {
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(initialInstanceId);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await listTaskConfigs();
      if (current !== sequence.current) return;
      setItems(result.items);
      setLoaded(true);
    } catch (loadError) {
      if (current === sequence.current) setError(taskConfigError(loadError));
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);
  useEffect(() => {
    setSelectedId(initialInstanceId);
  }, [initialInstanceId]);
  const filtered = useMemo(
    () =>
      items.filter(
        item =>
          (showInactive || item.active) &&
          `${item.serverName} ${item.instanceName}`
            .toLocaleLowerCase()
            .includes(search.trim().toLocaleLowerCase())
      ),
    [items, search, showInactive]
  );
  return (
    <div className="task-config-root">
      {selectedId ? (
        <ConfigDetail
          key={selectedId}
          instanceId={selectedId}
          onBack={() => setSelectedId(null)}
          onChanged={load}
        />
      ) : (
        <section className="task-config-panel" aria-busy={loading}>
          <div className="task-config-title-row">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">任务配置</h2>
              <p className="text-sm text-gray-600 mt-1">按实例维护放货通知的任务分母</p>
            </div>
            <button className="btn btn-secondary" disabled={loading} onClick={load}>
              <RefreshCw className="w-4 h-4" />
              {loading ? '刷新中…' : '刷新配置'}
            </button>
          </div>
          <p className="task-config-note">
            每行配置代表一个任务；同城多门店计一次，跨城市分别计数。实例实际配置变更后，请重新导入完整文件。
          </p>
          {error && (
            <p role="alert" className="task-config-error">
              {error}{' '}
              <button className="task-back" onClick={load}>
                重试
              </button>
            </p>
          )}
          <div className="task-config-toolbar">
            <label className="task-config-field">
              <span className="sr-only">搜索服务器或实例</span>
              <input
                className="input"
                value={search}
                placeholder="搜索服务器或实例"
                aria-label="搜索服务器或实例"
                onChange={event => setSearch(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="accent-primary"
                checked={showInactive}
                onChange={event => setShowInactive(event.target.checked)}
              />
              显示已停用实例
            </label>
            <span className="text-sm text-gray-600">
              {loaded ? `${filtered.length} 个实例` : '正在读取实例…'}
            </span>
          </div>
          <TaskConfigTable
            headers={[
              '服务器 / 实例',
              { label: '任务总数', numeric: true },
              { label: '城市 / 规格', numeric: true },
              '版本 / 生效时间',
              '最近确认',
              '状态',
              '操作',
            ]}
            empty={!filtered.length}
            emptyText={loading && !loaded ? '正在读取任务配置…' : '没有匹配的实例'}
          >
            {filtered.map(item => (
              <tr key={item.instanceId}>
                <td>
                  <button
                    className="text-primary font-medium text-left"
                    onClick={() => setSelectedId(item.instanceId)}
                  >
                    {item.serverName}
                    <span className="task-cell-sub">{item.instanceName}</span>
                  </button>
                </td>
                <td className="task-num font-semibold">
                  {item.currentVersionId ? item.taskCount.toLocaleString() : '—'}
                </td>
                <td className="task-num">
                  {item.currentVersionId ? `${item.cityCount} / ${item.specCount}` : '—'}
                </td>
                <td>
                  {item.currentVersionId ? (
                    <>
                      <span>V{item.currentVersionNumber}</span>
                      <span className="task-cell-sub">{taskConfigTime(item.effectiveAt)}</span>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {taskConfigTime(item.lastConfirmedAt)}
                  {taskConfigNeedsReview(item) && (
                    <span className="task-cell-sub">超过 24 小时 · 建议复核</span>
                  )}
                </td>
                <td>
                  <TaskConfigStatus status={item.status} />
                  {!item.active && <span className="task-cell-sub">实例已停用</span>}
                </td>
                <td>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setSelectedId(item.instanceId)}
                  >
                    {item.active ? '查看 / 更新' : '查看历史'}
                  </button>
                </td>
              </tr>
            ))}
          </TaskConfigTable>
        </section>
      )}
    </div>
  );
}
