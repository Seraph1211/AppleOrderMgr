import { useCallback, useEffect, useRef, useState } from 'react';
import IdentityApiAdmin from './identityApiAdmin';
import IdentityApiConfirm from './identityApiConfirm';
import { useAuth } from '../contexts/AuthContext';
import { Copy, KeyRound, RefreshCw, ShieldOff, AlertCircle } from 'lucide-react';
import { identityApi } from '../api/identityApi';
import { copyIdentityText } from '../utils/copyIdentityText';
import { buildIdentityApiGuide } from '../utils/identityApiGuide';

const formatTime = value =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

/** 本人的身份核验 API 令牌；完整令牌只在复制操作中短暂获取。 */
export default function IdentityApiTab() {
  const { user } = useAuth();
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const generation = useRef(0);
  const operation = useRef(false);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const response = await identityApi.apiToken();
      if (current === generation.current) setMetadata(response.data);
    } catch (_failure) {
      if (current === generation.current) {
        setMetadata(null);
        setError('API 信息加载失败，请刷新重试。权限变更后请联系管理员。');
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

  const perform = async (action, callback) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      await callback();
    } catch (_failure) {
      setError(
        action === 'copy' || action === 'guide'
          ? '复制失败，请使用 HTTPS 并允许剪贴板访问后重试；令牌不可用时请刷新状态。'
          : '操作未确认成功，请刷新查看当前状态后再操作。'
      );
    } finally {
      operation.current = false;
      setBusy('');
    }
  };
  const changeToken = action =>
    perform(action, async () => {
      const response = await {
        create: identityApi.createApiToken,
        reset: identityApi.resetApiToken,
        revoke: identityApi.revokeApiToken,
      }[action]();
      setMetadata(response.data);
      setConfirmation('');
      setNotice(
        action === 'revoke'
          ? '令牌已停用，原令牌无法继续调用。'
          : action === 'reset'
            ? '令牌已重置，旧令牌已失效。请单独复制新令牌。'
            : '令牌已创建，请单独复制并妥善保管。'
      );
    });
  const token = metadata?.token;
  const expired = Boolean(token?.expiresAt && new Date(token.expiresAt).getTime() <= Date.now());
  const usable = token?.status === 'active' && !expired;
  const tokenLabel = !token
    ? '未创建'
    : token.status === 'revoked'
      ? '已停用 / 已撤销'
      : expired || token.status === 'expired'
        ? '已过期'
        : usable
          ? '有效'
          : '不可用';
  const service = metadata?.service;
  const serviceReady = service?.configured && service?.enabled && !service?.paused;

  return (
    <section className="p-4 sm:p-6 space-y-5 min-w-0" aria-label="API 接入管理">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">本人 API 令牌</h2>
          <p className="text-sm text-gray-500 mt-1">
            使用独立令牌通过 HTTPS GET 核验。完整令牌仅写入剪贴板，请妥善保管。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-secondary inline-flex items-center gap-2"
            disabled={loading || Boolean(busy)}
            onClick={load}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            刷新状态
          </button>
          <button
            type="button"
            className="btn btn-secondary inline-flex items-center gap-2"
            disabled={Boolean(busy)}
            onClick={() =>
              perform('guide', async () => {
                await copyIdentityText(() => buildIdentityApiGuide(window.location.origin));
                setNotice('使用说明已复制，仅包含占位参数，不含本人令牌和证件信息。');
              })
            }
          >
            <Copy className="w-4 h-4" />
            {busy === 'guide' ? '正在复制…' : '一键复制使用说明'}
          </button>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex gap-2"
        >
          <AlertCircle className="w-5 h-5 shrink-0" />
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-lg border border-blue-200 bg-primary-50 p-4 text-sm text-primary"
        >
          {notice}
        </div>
      )}
      {loading ? (
        <p role="status" className="py-10 text-center text-gray-500">
          正在加载 API 信息…
        </p>
      ) : (
        metadata && (
          <>
            {!serviceReady && (
              <p
                role="status"
                className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800"
              >
                {service?.paused
                  ? '核验服务已暂停，请联系管理员核查后恢复。'
                  : '核验服务尚未配置或未启用，当前无法发起核验。'}
              </p>
            )}
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">项目</th>
                    <th className="px-4 py-3 text-left font-medium">当前状态</th>
                  </tr>
                </thead>
                <tbody className="text-gray-700 divide-y divide-gray-200">
                  {[
                    [
                      '令牌状态',
                      <span
                        key="status"
                        className={`badge badge-${usable ? 'success' : 'warning'}`}
                      >
                        {tokenLabel}
                      </span>,
                    ],
                    ['令牌前缀', token?.prefix ? `${token.prefix}…` : '—'],
                    ['创建时间', formatTime(token?.createdAt)],
                    ['有效期至', formatTime(token?.expiresAt)],
                    ['最后使用', formatTime(token?.lastUsedAt)],
                    ['每分钟请求上限', `${metadata.limits.requestsPerMinute} 次`],
                    [
                      '今日新调用',
                      `${metadata.usage.providerCalls} / ${metadata.limits.dailyProviderCalls} 次（北京时间 ${metadata.usage.date}）`,
                    ],
                    ['确定结果复用', `${metadata.limits.dedupSeconds} 秒内，本人相同姓名和身份证`],
                  ].map(([label, value]) => (
                    <tr key={label} className="hover:bg-gray-50">
                      <th className="px-4 py-3 text-left font-medium whitespace-nowrap">{label}</th>
                      <td className="px-4 py-3 min-w-[160px]">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-3">
              {!token ? (
                <button
                  type="button"
                  className="btn btn-primary inline-flex items-center gap-2"
                  disabled={Boolean(busy)}
                  onClick={() => changeToken('create')}
                >
                  <KeyRound className="w-4 h-4" />
                  {busy === 'create' ? '正在创建…' : '创建本人令牌'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-primary inline-flex items-center gap-2"
                    disabled={!usable || Boolean(busy)}
                    onClick={() =>
                      perform('copy', async () => {
                        await copyIdentityText(async () => {
                          const response = await identityApi.revealApiToken();
                          if (!response.data?.token) throw new Error('令牌不可用');
                          return response.data.token;
                        });
                        setNotice('本人令牌已复制，请妥善保管。');
                      })
                    }
                  >
                    <Copy className="w-4 h-4" />
                    {busy === 'copy' ? '正在复制…' : '一键复制 Token'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary inline-flex items-center gap-2"
                    disabled={Boolean(busy)}
                    onClick={() => setConfirmation('reset')}
                  >
                    <RefreshCw className="w-4 h-4" />
                    重置令牌
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary inline-flex items-center gap-2"
                    disabled={!usable || Boolean(busy)}
                    onClick={() => setConfirmation('revoke')}
                  >
                    <ShieldOff className="w-4 h-4" />
                    停用令牌
                  </button>
                </>
              )}
            </div>
            <p className="text-sm text-gray-500 leading-6">
              默认有效期 90
              天。新调用可能消耗套餐额度，一致与不一致均为确定结果；超时或异常属于未知结果，请保留核验编号联系管理员，禁止自动重试。复用结果不增加新供应商调用次数。
            </p>
          </>
        )
      )}
      {user?.role === 'admin' && <IdentityApiAdmin onChange={load} />}
      {confirmation && (
        <IdentityApiConfirm
          title={confirmation === 'reset' ? '重置本人令牌' : '停用本人令牌'}
          busy={Boolean(busy)}
          onCancel={() => setConfirmation('')}
          onConfirm={() => changeToken(confirmation)}
        >
          <p className="text-sm text-gray-600">
            {confirmation === 'reset'
              ? '重置后旧令牌立即失效，已接入的工具需要更新为新令牌。确认重置？'
              : '停用后当前令牌立即失效，已接入的工具将无法继续调用。确认停用？'}
          </p>
        </IdentityApiConfirm>
      )}
    </section>
  );
}
