import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, AlertCircle } from 'lucide-react';
import IdentityApiConfirm from './identityApiConfirm';
import { identityApi } from '../api/identityApi';

const time = value => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—');
const th = 'px-4 py-3 text-left font-medium text-gray-500 whitespace-nowrap';
const td = 'px-4 py-3 text-gray-700 whitespace-nowrap';

/** 管理员查看服务、未知核验和令牌元数据，不提供他人令牌读取。 */
export default function IdentityApiAdmin({ onChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  const operation = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const response = await identityApi.apiAdmin();
      if (current === generation.current) setData(response.data);
    } catch (_error) {
      if (current === generation.current) {
        setData(null);
        setError('管理信息加载失败，请刷新重试。');
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const requestGeneration = generation;
    load();
    return () => {
      requestGeneration.current++;
    };
  }, [load]);
  const validReason = reason.trim().length >= 5 && reason.trim().length <= 200;
  const confirm = async () => {
    if (operation.current || !action || (action.kind === 'resolve' && !validReason)) return;
    operation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response =
        action.kind === 'service'
          ? await identityApi.setApiPaused(!data.service.paused)
          : action.kind === 'resolve'
            ? await identityApi.resolveApiUnknown(action.id, reason.trim())
            : await identityApi.revokeUserApiToken(action.id);
      setData(response.data);
      setAction(null);
      setReason('');
      setNotice('操作已完成，请根据当前状态继续处理。');
      onChange();
    } catch (_error) {
      setError('操作未确认成功，请取消后刷新当前状态再操作。');
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="border-t border-gray-200 pt-6 space-y-4" aria-label="管理员 API 管理">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-900">管理员管理</h3>
          <p className="text-sm text-gray-500 mt-1">
            服务状态、待核查未知结果和最近 100 个令牌。仅展示令牌元数据。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary inline-flex items-center gap-2"
          onClick={load}
          disabled={loading || busy}
        >
          <RefreshCw className="w-4 h-4" />
          刷新管理信息
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700 bg-red-50 rounded-lg p-3 flex gap-2">
          <AlertCircle className="w-5 h-5 shrink-0" />
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-primary bg-primary-50 rounded-lg p-3">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status" className="py-6 text-center text-gray-500">
          正在加载管理信息…
        </p>
      ) : (
        data && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className={`badge badge-${data.service.paused ? 'warning' : 'info'}`}>
                {data.service.paused ? '服务已暂停' : '服务未暂停'}
              </span>
              <span className="text-gray-600">
                {data.service.configured && data.service.enabled
                  ? '已配置并启用'
                  : '尚未配置或未启用'}
              </span>
              {data.service.pauseReason && (
                <span className="text-gray-600 break-all">
                  暂停原因：{data.service.pauseReason}
                </span>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => setAction({ kind: 'service' })}
              >
                {data.service.paused ? '恢复服务' : '暂停服务'}
              </button>
            </div>
            <h4 className="text-sm font-semibold text-gray-900">待核查未知结果（最多 100 条）</h4>
            <p className="text-sm text-gray-500">
              先结合供应商证据确认处理，再解除重复调用保护。解除不会修改原始未知结果或自动重试，后续新请求可能扣次。
            </p>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {['核验编号', '账号', '说明', '开始时间', '完成时间', '操作'].map(label => (
                      <th key={label} className={th}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {data.unknown.map(row => (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className={`${td} font-mono`}>{row.id}</td>
                      <td className={td}>U{String(row.userId).padStart(4, '0')}</td>
                      <td className="px-4 py-3 text-gray-600 min-w-[180px]">
                        {row.message || '结果未知'}
                      </td>
                      <td className={td}>{time(row.startedAt)}</td>
                      <td className={td}>{time(row.finishedAt)}</td>
                      <td className={td}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() => {
                            setReason('');
                            setAction({ kind: 'resolve', id: row.id });
                          }}
                        >
                          核查后解除保护
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!data.unknown.length && (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-gray-500">
                        暂无待核查未知结果
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <h4 className="text-sm font-semibold text-gray-900">令牌管理（最多 100 条）</h4>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {['账号', '令牌前缀', '状态', '有效期至', '最后使用', '操作'].map(label => (
                      <th key={label} className={th}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {data.tokens.map(token => {
                    const expired = new Date(token.expiresAt).getTime() <= Date.now();
                    const active = token.status === 'active' && !expired;
                    return (
                      <tr key={token.id} className="hover:bg-gray-50">
                        <td className={td}>U{String(token.userId).padStart(4, '0')}</td>
                        <td className={`${td} font-mono`}>{token.prefix}…</td>
                        <td className={td}>
                          <span className={`badge badge-${active ? 'success' : 'warning'}`}>
                            {token.status === 'revoked' ? '已撤销' : expired ? '已过期' : '有效'}
                          </span>
                        </td>
                        <td className={td}>{time(token.expiresAt)}</td>
                        <td className={td}>{time(token.lastUsedAt)}</td>
                        <td className={td}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy || token.status !== 'active'}
                            onClick={() => setAction({ kind: 'revoke', id: token.id })}
                          >
                            撤销令牌
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!data.tokens.length && (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-gray-500">
                        暂无令牌
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )
      )}
      {action && (
        <IdentityApiConfirm
          title="确认管理员操作"
          busy={busy}
          disabled={action.kind === 'resolve' && !validReason}
          onCancel={() => setAction(null)}
          onConfirm={confirm}
        >
          <p className="text-sm text-gray-600">
            {action.kind === 'service'
              ? data.service.paused
                ? '已核查服务暂停原因并确认可以恢复？恢复后各入口可继续发起核验。'
                : '确认暂停服务？暂停后各入口将无法发起新的供应商核验。'
              : action.kind === 'resolve'
                ? '已核查供应商证据并确认允许后续重新核验？原未知记录仍会保留。'
                : '确认撤销此令牌？撤销后立即失效，所属员工需要重新获取令牌。'}
          </p>
          {action.kind === 'resolve' && (
            <label className="block text-sm text-gray-700">
              核查依据与处理原因
              <textarea
                className="input w-full mt-2"
                rows={3}
                maxLength={200}
                placeholder="填写 5–200 字核查依据，不含姓名、证件或令牌"
                value={reason}
                onChange={event => setReason(event.target.value)}
                disabled={busy}
              />
            </label>
          )}
        </IdentityApiConfirm>
      )}
    </section>
  );
}
