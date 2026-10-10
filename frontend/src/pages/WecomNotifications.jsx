import ResponsiveSelect from '../components/responsiveSelect';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, RefreshCw, Save, Send, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import {
  getWecomSettings,
  saveWecomSettings,
  testWecomNotification,
  getWecomDeliveries,
  retryWecomDelivery,
} from '../api/wecomNotificationsApi';

const STATUSES = {
  pending: ['排队中', 'badge-info'],
  waiting: ['等待付款码', 'badge-warning'],
  sending: ['发送中', 'badge-info'],
  accepted: ['接口已接受', 'badge-success'],
  failed: ['失败', 'badge-error'],
  unknown: ['结果未知', 'badge-warning'],
  skipped: ['已跳过', 'bg-gray-100 text-gray-600 border border-gray-200'],
};
const ERRORS = {
  ORDER_MISSING: '订单已不存在',
  ORDER_TERMINAL: '订单已付款或进入终态',
  ORDER_EXPIRED: '已超过付款截止时间',
  DEADLINE_MISSING: '缺少准确下单时间',
  LINK_MISSING: '没有可用付款链接',
  TEXT_TOO_LONG: '消息超过长度限制，未截断链接',
  RATE_LIMITED: '发送过于频繁，稍后重试',
  CONNECT_FAILED: '无法连接企微',
  WEBHOOK_REJECTED: '机器人配置无效，请重新保存',
  API_REJECTED: '企微拒绝发送，请检查机器人配置',
  RESPONSE_UNKNOWN: '回执不明确，请核对群消息',
  TRANSPORT_UNKNOWN: '未取得回执，请核对群消息',
  LEASE_UNKNOWN: '发送期间服务中断，请核对群消息',
  SCOPE_CHANGED: '通知已停用或目标已更换',
  DISABLED: '通知已停用',
  DESTINATION_CHANGED: '目标机器人已更换',
};
const formatTime = value =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '-';
const draftOf = data => ({
  enabled: data.enabled,
  groupName: data.groupName,
  webhook: '',
  expectedVersion: data.version,
});

/** 企业微信内部群通知配置与投递记录。 */
export default function WecomNotifications() {
  const { can } = useAuth();
  const canConfigure = can(PERMISSIONS.WECOM_CONFIGURE);
  const canRetry = can(PERMISSIONS.WECOM_RETRY);
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [history, setHistory] = useState(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [retryRow, setRetryRow] = useState(null);
  const [ack, setAck] = useState(false);
  const dialog = useRef(null);
  const generation = useRef(0);
  const testKey = useRef(null);
  const dirty = Boolean(
    draft &&
    settings &&
    (draft.webhook || draft.enabled !== settings.enabled || draft.groupName !== settings.groupName)
  );
  const conflict = draft && settings && draft.expectedVersion !== settings.version;

  const load = useCallback(
    async (resetDraft = false) => {
      const current = ++generation.current;
      try {
        const [config, records] = await Promise.all([
          getWecomSettings(),
          getWecomDeliveries({ page, status }),
        ]);
        if (current !== generation.current) return;
        setSettings(config.data);
        setDraft(previous => (resetDraft || !previous ? draftOf(config.data) : previous));
        setHistory(records.data);
        setError('');
      } catch (failure) {
        if (current === generation.current) setError(failure.message || '读取通知配置失败');
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [page, status]
  );

  useEffect(() => {
    setLoading(true);
    load();
    const timer = setInterval(() => load(), 5000);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (retryRow) dialog.current?.showModal();
    else dialog.current?.close();
  }, [retryRow]);

  async function save(event) {
    event.preventDefault();
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const response = await saveWecomSettings(draft);
      setSettings(response.data);
      setDraft(draftOf(response.data));
      testKey.current = null;
      setNotice(
        response.data.enabled
          ? '已启用，仅通知此后新建订单。'
          : '配置已保存，自动通知处于关闭状态。'
      );
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }
  async function sendTest() {
    setBusy('test');
    setError('');
    setNotice('');
    try {
      // 无回执时保留同一标识，再点测试不会创建重复投递。
      testKey.current ||= crypto.randomUUID();
      await testWecomNotification({
        expectedVersion: settings.version,
        idempotencyKey: testKey.current,
      });
      testKey.current = null;
      setNotice('测试消息已入队，请在投递记录及目标群中核对结果。');
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }
  async function retry() {
    setBusy('retry');
    setError('');
    setNotice('');
    try {
      await retryWecomDelivery(retryRow.id, {
        expectedVersion: retryRow.version,
        acknowledgeUnknown: ack,
      });
      setRetryRow(null);
      setNotice('已处理重试请求，发送前仍会检查订单状态和时效。');
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }
  const workerOnline =
    settings?.workerHeartbeatAt && Date.now() - Date.parse(settings.workerHeartbeatAt) < 30000;
  const summary = history?.summary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center">
            <Bell className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">企微订单通知</h1>
            <p className="text-sm text-gray-500">将新订单逐条发送至企业微信内部群</p>
          </div>
        </div>
        <button
          className="btn btn-secondary inline-flex items-center gap-2"
          disabled={Boolean(busy)}
          onClick={() => load()}
        >
          <RefreshCw className="w-4 h-4" />
          刷新记录
        </button>
      </div>
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 border border-red-200 p-3 text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-blue-800"
        >
          {notice}
        </div>
      )}
      {!draft && loading && (
        <p className="text-gray-500 flex gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          正在加载通知配置…
        </p>
      )}
      {draft && settings && (
        <form
          onSubmit={save}
          className="bg-white border border-gray-200 rounded-xl p-4 sm:p-6 space-y-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-gray-900 mr-2">群机器人设置</h2>
            <span
              className={`badge ${settings.enabled ? 'badge-success' : 'bg-gray-100 text-gray-600 border border-gray-200'}`}
            >
              {settings.enabled ? '自动通知已启用' : '自动通知已关闭'}
            </span>
            <span className={`badge ${workerOnline ? 'badge-info' : 'badge-warning'}`}>
              {workerOnline ? '发送服务在线' : '发送服务未就绪'}
            </span>
          </div>
          {settings.pausedReason && (
            <p role="alert" className="text-red-700">
              发送已暂停：
              {ERRORS[settings.pausedReason] || settings.pausedReason}
              。修正配置后保存可恢复。
            </p>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <label className="text-sm text-gray-700">
              目标群名称
              <input
                className="input mt-1 w-full"
                value={draft.groupName}
                maxLength={100}
                required
                disabled={!canConfigure || Boolean(busy)}
                onChange={e => setDraft({ ...draft, groupName: e.target.value })}
                placeholder="例如：订单付款通知群"
              />
            </label>
            <label className="text-sm text-gray-700">
              机器人 Webhook
              <input
                type="password"
                autoComplete="new-password"
                className="input mt-1 w-full"
                value={draft.webhook}
                disabled={!canConfigure || Boolean(busy) || settings.enabled}
                onChange={e => setDraft({ ...draft, webhook: e.target.value })}
                placeholder={
                  settings.configured
                    ? '已配置；留空保留，更换前请先停用'
                    : '粘贴企业微信机器人 Webhook'
                }
              />
              <span className="block mt-1 text-xs text-gray-500">
                密钥仅用于保存，不回显。仅支持企业微信内部群。
              </span>
            </label>
          </div>
          <label className="flex gap-2 items-center text-sm text-gray-700">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={!canConfigure || Boolean(busy)}
              onChange={e => setDraft({ ...draft, enabled: e.target.checked })}
            />
            启用新订单自动通知
          </label>
          <p className="text-sm text-gray-500">
            一单一条，每分钟最多发送 18 条；缺付款码等待 60
            秒后回退订单链接。发送前跳过已付款或超时订单，不补历史，不 @ 成员。
          </p>
          <p className="text-sm text-gray-500">
            仅群消息增加 TAG，付款页面复制格式保持不变。测试消息也会发送至当前配置的群。
          </p>
          <div className="flex flex-wrap gap-3 items-center">
            {canConfigure && (
              <>
                <button
                  className="btn btn-primary inline-flex items-center gap-2"
                  disabled={Boolean(busy) || Boolean(conflict)}
                  type="submit"
                >
                  <Save className="w-4 h-4" />
                  {busy === 'save' ? '保存中…' : '保存配置'}
                </button>
                <button
                  className="btn btn-secondary inline-flex items-center gap-2"
                  type="button"
                  disabled={
                    Boolean(busy) ||
                    dirty ||
                    Boolean(conflict) ||
                    !settings.configured ||
                    Boolean(settings.pausedReason)
                  }
                  onClick={sendTest}
                >
                  <Send className="w-4 h-4" />
                  {busy === 'test' ? '提交中…' : '发送测试消息'}
                </button>
              </>
            )}
            {dirty && <span className="text-sm text-amber-700">有未保存的修改</span>}
            {conflict && (
              <button
                className="btn btn-secondary inline-flex items-center gap-2"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => load(true)}
              >
                配置已更新，重新载入并放弃草稿
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500">
            上次保存：{formatTime(settings.updatedAt)} · 启用起点：
            {formatTime(settings.enabledAt)} · 服务心跳：
            {formatTime(settings.workerHeartbeatAt)}
          </p>
        </form>
      )}
      <section className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="p-4 sm:p-6 border-b border-gray-200 space-y-3">
          <div className="flex flex-wrap gap-3 justify-between items-center">
            <h2 className="font-semibold text-gray-900">投递记录</h2>
            <label className="text-sm text-gray-600">
              状态筛选{' '}
              <ResponsiveSelect
                className="input"
                value={status}
                onChange={e => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">全部状态</option>
                {Object.entries(STATUSES).map(([key, [label]]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </ResponsiveSelect>
            </label>
          </div>
          {summary && (
            <p className="text-sm text-gray-600">
              积压 {summary.backlog} 条 · 失败 {summary.failed} 条 · 结果未知 {summary.unknown} 条 ·
              已跳过 {summary.skipped} 条<br />
              最早待发：{formatTime(summary.oldestPendingAt)}
            </p>
          )}
          <p className="text-xs text-gray-500">
            持续高峰可能使排队订单超时并被跳过。“接口已接受”仍需在群中核对实际显示。
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left min-w-[900px]">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                {[
                  '订单 ID',
                  '目标群',
                  '状态',
                  '尝试次数',
                  '登记时间',
                  '接受时间',
                  '说明',
                  '操作',
                ].map(t => (
                  <th key={t} className="px-4 py-3 font-medium">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-gray-500">
                    正在加载投递记录…
                  </td>
                </tr>
              ) : !history ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-gray-500">
                    投递记录加载失败，请刷新重试
                  </td>
                </tr>
              ) : history.rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-gray-500">
                    暂无投递记录。配置后可发送测试消息。
                  </td>
                </tr>
              ) : (
                history.rows.map(row => (
                  <tr key={row.id}>
                    <td className="px-4 py-3 text-gray-900">
                      {row.kind === 'test' ? '测试消息' : (row.orderId ?? '-')}
                    </td>
                    <td className="px-4 py-3">{row.groupName}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`badge ${STATUSES[row.status]?.[1] || 'bg-gray-100 text-gray-600 border border-gray-200'}`}
                      >
                        {STATUSES[row.status]?.[0] || row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">{row.attempts}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatTime(row.createdAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatTime(row.sentAt)}</td>
                    <td className="px-4 py-3 max-w-xs">
                      {ERRORS[row.errorCode] || row.errorCode || '-'}
                    </td>
                    <td className="px-4 py-3">
                      {canRetry && ['failed', 'unknown'].includes(row.status) && (
                        <button
                          className="btn btn-secondary whitespace-nowrap"
                          disabled={Boolean(busy)}
                          onClick={() => {
                            setAck(false);
                            setRetryRow(row);
                          }}
                        >
                          重试
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="p-4 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
          <span>
            共 {history?.total || 0} 条 · 第 {page} / {Math.max(1, history?.totalPages || 1)} 页
          </span>
          <div className="flex gap-2">
            <button
              className="btn btn-secondary inline-flex items-center gap-2"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </button>
            <button
              className="btn btn-secondary inline-flex items-center gap-2"
              disabled={loading || page >= (history?.totalPages || 1)}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </section>
      <dialog
        ref={dialog}
        onCancel={event => {
          if (busy) event.preventDefault();
          else setRetryRow(null);
        }}
        className="rounded-xl p-6 w-[calc(100%-2rem)] max-w-md backdrop:bg-black/40"
        aria-labelledby="wecom-retry-title"
      >
        {error && (
          <p role="alert" className="text-red-700 mb-3">
            {error}
          </p>
        )}
        <h2 id="wecom-retry-title" className="text-lg font-semibold text-gray-900 mb-3">
          重试此条通知
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          {retryRow?.status === 'unknown'
            ? '之前的消息可能已经发到群中。请先核对群消息，再决定是否重新发送。'
            : '重试仍会检查原目标群、通知开关和订单时效。'}
        </p>
        {retryRow?.status === 'unknown' && (
          <label className="flex gap-2 text-sm text-gray-700 mb-4">
            <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
            我已核对群消息，确认重新发送并接受重复消息的可能
          </label>
        )}
        <div className="flex justify-end gap-3">
          <button
            className="btn btn-secondary inline-flex items-center gap-2"
            disabled={Boolean(busy)}
            onClick={() => setRetryRow(null)}
          >
            取消
          </button>
          <button
            className="btn btn-primary inline-flex items-center gap-2"
            disabled={Boolean(busy) || (retryRow?.status === 'unknown' && !ack)}
            onClick={retry}
          >
            {busy === 'retry' ? '提交中…' : '确认重试'}
          </button>
        </div>
      </dialog>
    </div>
  );
}
