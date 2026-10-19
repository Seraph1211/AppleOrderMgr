import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Mail, MessageSquare, RefreshCw, Save } from 'lucide-react';
import {
  cancelServerMonitorDelivery,
  getServerMonitorChannels,
  getServerMonitorDelivery,
  getServerMonitorDeliveries,
  getServerMonitorNotificationHealth,
  retryServerMonitorDelivery,
  saveServerMonitorChannel,
  sendServerMonitorCurrentSummary,
  testServerMonitorChannel,
} from '../api/serverMonitorNotificationsApi';

const CHANNEL_NAME = { email: '邮件', wecom: '企业微信' };
const STATUS_NAME = {
  pending: '排队中',
  sending: '发送中',
  accepted: '对方已接受',
  unknown: '结果未知',
  failed: '发送失败',
  skipped: '已跳过',
};
const CATEGORY_NAME = {
  alert: '异常告警',
  recovery: '恢复通知',
  reminder: '持续提醒',
  test: '合成测试',
  summary: '当前异常摘要',
  daily: '每日摘要',
  storm: '风暴告警',
};
const SEVERITY_NAME = { info: '提醒', warning: '警告', critical: '严重' };
const DEFAULT_POLICY = {
  warningWindowMinutes: 3,
  infoEnabled: false,
  recoveryMinutes: 2,
  criticalReminderMinutes: [15, 30, 60],
  warningReminderMinutes: 60,
  dailySummaryEnabled: false,
};

const formatTime = value =>
  value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—';

function responseErrorCode(error) {
  return error?.response?.data?.error?.code || error?.code;
}

function errorMessage(error) {
  return error?.response?.data?.error?.message || error?.message || '请求失败，请重试';
}

function normalizeChannel(channel) {
  return {
    ...channel,
    recipients: channel.recipients || [],
    policy: { ...DEFAULT_POLICY, ...(channel.policy || {}) },
  };
}

function getChannelHealthLabel(channel, health) {
  if (health?.state === 'paused' || health?.pausedReason || channel.pausedReason) return '通道已暂停';
  if (health?.state === 'not_started' || !health?.heartbeatAt) return 'Worker 尚未启动';
  if (health?.state === 'stale' || health?.heartbeatStale === true) return '心跳已超时';
  if (health?.state === 'backlog' || Number(health?.overdueCount) > 0) return '投递积压';
  if (Number(health?.unknownCount) > 0) return '有未知投递待核对';
  if (Number(health?.failedCount) > 0) return '存在失败投递';
  if (Number(health?.pendingCount) > 0) return '有待发投递';
  if (health?.state === 'healthy') return '运行正常';
  return '状态未知';
}

function ChannelEditor({ channel, onSaved, onNotice, canConfigure }) {
  const [draft, setDraft] = useState(() => normalizeChannel(channel));
  const [recipientDraft, setRecipientDraft] = useState(() => (channel.recipients || []).join('\n'));
  const [webhook, setWebhook] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    setDraft(normalizeChannel(channel));
    setRecipientDraft((channel.recipients || []).join('\n'));
    setWebhook('');
    setPreview(null);
    setConflict(false);
  }, [channel]);

  const isEmail = draft.channel === 'email';
  const dirty = useMemo(
    () =>
      draft.enabled !== channel.enabled ||
      draft.sendRecovery !== channel.sendRecovery ||
      draft.targetName !== channel.targetName ||
      (isEmail && recipientDraft !== (channel.recipients || []).join('\n')) ||
      JSON.stringify(draft.policy) !==
        JSON.stringify({ ...DEFAULT_POLICY, ...(channel.policy || {}) }) ||
      Boolean(webhook),
    [channel, draft, isEmail, recipientDraft, webhook]
  );

  const patch = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const patchPolicy = (key, value) =>
    setDraft(current => ({ ...current, policy: { ...current.policy, [key]: value } }));

  async function save() {
    setSaving(true);
    setError('');
    setConflict(false);
    try {
      const payload = {
        expectedVersion: draft.version,
        enabled: draft.enabled,
        sendRecovery: Boolean(draft.sendRecovery),
      };
      if (isEmail) {
        payload.recipients = recipientDraft
          .split('\n')
          .map(value => value.trim())
          .filter(Boolean);
      }
      else {
        payload.policy = draft.policy;
        payload.targetName = draft.targetName || '';
        if (webhook) payload.webhook = webhook;
      }
      const saved = await saveServerMonitorChannel(draft.channel, payload);
      setWebhook('');
      await onSaved(saved);
      onNotice(`${CHANNEL_NAME[draft.channel]}通道设置已保存。`);
    } catch (saveError) {
      if (responseErrorCode(saveError) === 'CONCURRENT_MODIFICATION') {
        setConflict(true);
        setError('设置已被其他用户更新。当前草稿已保留；请先查看服务器最新版本，再决定是否重新编辑。');
      } else setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setError('');
    try {
      const result = await testServerMonitorChannel(draft.channel, {
        requestKey: crypto.randomUUID(),
      });
      onNotice(`合成测试已登记，投递编号 ${result.deliveryId}，当前状态：${STATUS_NAME[result.status] || result.status}。`);
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setTesting(false);
    }
  }

  async function loadPreview() {
    setSummaryLoading(true);
    setError('');
    try {
      const result = await sendServerMonitorCurrentSummary(draft.channel, { preview: true });
      setPreview(result.preview || result);
    } catch (previewError) {
      setError(errorMessage(previewError));
    } finally {
      setSummaryLoading(false);
    }
  }

  async function sendSummary() {
    if (!preview) return;
    const accepted = window.confirm(
      `即将向${CHANNEL_NAME[draft.channel]}目标发送一次当前异常摘要（${preview.eventCount || 0} 个事件）。确认发送？`
    );
    if (!accepted) return;
    setSummaryLoading(true);
    setError('');
    try {
      const result = await sendServerMonitorCurrentSummary(draft.channel, {
        preview: false,
        requestKey: crypto.randomUUID(),
        expectedVersion: draft.version,
      });
      setPreview(null);
      onNotice(`当前异常摘要已登记，投递编号 ${result.deliveryId}。`);
    } catch (summaryError) {
      setError(errorMessage(summaryError));
    } finally {
      setSummaryLoading(false);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-gray-900">
            {isEmail ? <Mail className="h-4 w-4 text-primary" /> : <MessageSquare className="h-4 w-4 text-primary" />}
            {CHANNEL_NAME[draft.channel]}通道
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            {draft.targetName || (isEmail ? draft.smtp?.sender || '邮件目标' : '尚未命名群聊')}
            {' · '}
            {draft.configured ? '目标已配置' : '目标未配置'}
            {draft.lastAcceptedAt ? ` · 最近接受 ${formatTime(draft.lastAcceptedAt)}` : ''}
          </p>
          {isEmail && draft.smtp && (
            <p className="mt-1 text-xs text-gray-500">
              {draft.smtp.configured ? 'SMTP 配置正常' : 'SMTP 配置不完整'}
              {draft.smtp.reusedFromOrderMailbox ? ' · 复用订单邮箱' : ' · 使用独立 SMTP 配置'}
            </p>
          )}
        </div>
        <span className={`badge ${draft.enabled ? 'badge-success' : 'badge-warning'}`}>
          {draft.enabled ? '已启用' : '已关闭'}
        </span>
      </div>

      {draft.pausedReason && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          通道暂停原因：{draft.pausedReason}
        </p>
      )}
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p>{error}</p>
          {conflict && <p className="mt-1">草稿内容仍保留在表单中；请复制需要保留的修改，重新读取最新设置后再保存。</p>}
        </div>
      )}
      {dirty && <p role="status" className="text-sm text-amber-700">有未保存的修改。</p>}

      <fieldset disabled={!canConfigure || saving} className="space-y-4">
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <label className="inline-flex min-h-9 items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={Boolean(draft.enabled)} onChange={event => patch('enabled', event.target.checked)} />
            启用{CHANNEL_NAME[draft.channel]}自动通知
          </label>
          <label className="inline-flex min-h-9 items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={Boolean(draft.sendRecovery)} onChange={event => patch('sendRecovery', event.target.checked)} />
            发送恢复通知
          </label>
        </div>
        {isEmail ? (
          <label className="flex max-w-2xl flex-col gap-1 text-sm text-gray-700">
            收件邮箱（每行一个）
            <textarea
              className="input min-h-24 font-mono"
              value={recipientDraft}
              onChange={event => setRecipientDraft(event.target.value)}
              placeholder="ops@example.com"
            />
          </label>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-gray-700">
              群聊名称
              <input className="input" maxLength={100} value={draft.targetName || ''} onChange={event => patch('targetName', event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-gray-700">
              Webhook（保存后不回显）
              <input
                className="input font-mono"
                type="password"
                autoComplete="new-password"
                value={webhook}
                disabled={channel.enabled || draft.enabled}
                onChange={event => setWebhook(event.target.value)}
                placeholder={draft.configured ? '已配置；留空保持原目标' : '粘贴机器人 Webhook'}
              />
              <span className="text-xs text-gray-500">请先保存关闭通道，再替换目标；保存后只显示“目标已配置”。</span>
            </label>
          </div>
        )}
        <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <h4 className="text-sm font-medium text-gray-800">通知策略</h4>
          {isEmail ? (
            <p className="text-sm leading-6 text-gray-700">
              邮件沿用现有策略：严重告警立即发送；警告延迟 10 分钟合并；提醒级别在下一整点发送；恢复通知延迟 10 分钟，并校验恢复状态；不新增周期提醒。
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <label className="flex flex-col gap-1 text-sm text-gray-700">
                  警告合并窗口（分钟）
                  <input className="input" type="number" min="1" max="60" value={draft.policy.warningWindowMinutes} onChange={event => patchPolicy('warningWindowMinutes', Number(event.target.value))} />
                </label>
                <label className="flex flex-col gap-1 text-sm text-gray-700">
                  严重告警提醒间隔（分钟，逗号分隔）
                  <input
                    className="input"
                    value={draft.policy.criticalReminderMinutes.join(',')}
                    onChange={event => patchPolicy('criticalReminderMinutes', event.target.value.split(',').map(value => Number(value.trim())).filter(Number.isFinite))}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-gray-700">
                  警告持续提醒间隔（分钟）
                  <input className="input" type="number" min="1" max="1440" value={draft.policy.warningReminderMinutes} onChange={event => patchPolicy('warningReminderMinutes', Number(event.target.value))} />
                </label>
                <label className="flex flex-col gap-1 text-sm text-gray-700">
                  恢复稳定观察（分钟）
                  <input className="input" type="number" min="1" max="60" value={draft.policy.recoveryMinutes} onChange={event => patchPolicy('recoveryMinutes', Number(event.target.value))} />
                </label>
                <label className="inline-flex min-h-9 items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={Boolean(draft.policy.infoEnabled)} onChange={event => patchPolicy('infoEnabled', event.target.checked)} />
                  接收普通提醒（默认关闭）
                </label>
                <label className="inline-flex min-h-9 items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={Boolean(draft.policy.dailySummaryEnabled)} onChange={event => patchPolicy('dailySummaryEnabled', event.target.checked)} />
                  启用每日摘要（默认关闭）
                </label>
                <p className="self-center text-sm text-gray-500">每日摘要发送时间固定为北京时间 09:00。</p>
              </div>
              <p className="text-xs text-gray-500">严重首次告警立即发送；恢复及摘要按当前策略执行。实际生效规则以保存后的服务端版本为准。</p>
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary inline-flex items-center gap-1" onClick={save} disabled={!canConfigure || !dirty || saving}>
            <Save className="h-4 w-4" />{saving ? '保存中…' : '保存此通道'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={runTest} disabled={!canConfigure || testing}>
            {testing ? '登记中…' : '发送合成测试'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={loadPreview} disabled={!canConfigure || summaryLoading}>
            {summaryLoading ? '读取中…' : '预览当前异常摘要'}
          </button>
        </div>
      </fieldset>
      {preview && (
        <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-blue-900">当前异常摘要预览 · {preview.eventCount || 0} 个事件</p>
            <button type="button" className="text-sm text-gray-600 underline" onClick={() => setPreview(null)}>关闭预览</button>
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-blue-100 bg-white p-3 text-sm text-gray-800">{preview.text || '当前没有可发送的异常摘要。'}</pre>
          <button type="button" className="btn btn-primary" disabled={!canConfigure || summaryLoading || !(preview.eventCount > 0)} onClick={sendSummary}>
            确认一次发送
          </button>
        </div>
      )}
      {!canConfigure && <p className="text-sm text-gray-500">当前账号只有通知查看权限。</p>}
    </section>
  );
}

function DeliveryDetail({ id, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getServerMonitorDelivery(id)
      .then(result => {
        if (active) setDetail(result);
      })
      .catch(loadError => {
        if (active) setError(errorMessage(loadError));
      });
    return () => {
      active = false;
    };
  }, [id]);
  return (
    <section className="space-y-3 rounded-xl border border-blue-200 bg-white p-4" aria-label="投递详情">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-gray-900">投递详情与双通道状态</h3>
        <button type="button" className="btn btn-secondary" onClick={onClose}>关闭</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!detail && !error && <p role="status" className="text-sm text-gray-500">正在读取详情…</p>}
      {detail && (
        <>
          <p className="break-all text-xs text-gray-500">投递编号：{detail.id}</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="bg-gray-50 text-gray-500"><tr><th className="p-2">关联通道</th><th className="p-2">目标</th><th className="p-2">状态</th><th className="p-2">时间</th><th className="p-2">失败原因</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {(detail.relatedDeliveries || [detail]).map(item => (
                  <tr key={item.id}><td className="p-2">{CHANNEL_NAME[item.channel] || item.channel}</td><td className="p-2">{item.targetName || '—'}</td><td className="p-2">{STATUS_NAME[item.status] || item.status}</td><td className="p-2">{formatTime(item.sentAt || item.createdAt)}</td><td className="p-2">{item.lastError || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4 className="text-sm font-medium text-gray-800">关联事件</h4>
          {(detail.events || []).length === 0 ? <p className="text-sm text-gray-500">没有关联事件。</p> : (
            <ul className="space-y-2 text-sm">
              {detail.events.map(event => <li key={event.eventId} className="rounded border border-gray-200 p-2">{event.ruleName || CATEGORY_NAME[event.category] || event.category} · {event.instanceLabel || '—'} · {event.hitCount ?? '—'} 次 · {formatTime(event.at)}{event.originalUnknown ? <span className="ml-2 text-amber-700">原提醒结果未知</span> : null}</li>)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export default function ServerMonitorNotifications({ onNotice = () => {}, canConfigure = true, canRetry = true, initialEventId = '', invalidEventId = false }) {
  const [channels, setChannels] = useState(null);
  const [health, setHealth] = useState(null);
  const [rows, setRows] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [cursorStack, setCursorStack] = useState([]);
  const [filters, setFilters] = useState(() => ({ channel: '', status: '', deviceId: '', eventId: initialEventId, dateFrom: '', dateTo: '' }));
  const [filterDraft, setFilterDraft] = useState(() => ({ channel: '', status: '', deviceId: '', eventId: initialEventId, dateFrom: '', dateTo: '' }));
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const initialEventIdRef = useRef(initialEventId);

  useEffect(() => {
    if (initialEventIdRef.current === initialEventId) return;
    initialEventIdRef.current = initialEventId;
    setFilters(current => ({ ...current, eventId: initialEventId }));
    setFilterDraft(current => ({ ...current, eventId: initialEventId }));
    setCursorStack([]);
  }, [initialEventId]);

  const loadChannels = useCallback(async () => {
    try {
      const result = await getServerMonitorChannels();
      setChannels(result.channels.map(normalizeChannel));
      setError('');
      return result.channels;
    } catch (loadError) {
      setError(errorMessage(loadError));
      throw loadError;
    }
  }, []);
  const refreshHealth = useCallback(async () => {
    try {
      setRefreshing(true);
      const result = await getServerMonitorNotificationHealth();
      setHealth(result);
    } catch (healthError) {
      setError(errorMessage(healthError));
    } finally {
      setRefreshing(false);
    }
  }, []);
  const loadDeliveries = useCallback(async () => {
    if (invalidEventId) {
      setRows([]);
      setNextCursor(null);
      return;
    }
    try {
      setHistoryError('');
      const params = { limit: 30, ...filters };
      Object.keys(params).forEach(key => {
        if (!params[key]) delete params[key];
      });
      const cursor = cursorStack[cursorStack.length - 1];
      if (cursor) params.cursor = cursor;
      const result = await getServerMonitorDeliveries(params);
      setRows(result.rows || []);
      setNextCursor(result.nextCursor || null);
    } catch (loadError) {
      setRows([]);
      setHistoryError(errorMessage(loadError));
    }
  }, [cursorStack, filters, invalidEventId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.allSettled([loadChannels(), refreshHealth()]).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [loadChannels, refreshHealth]);
  useEffect(() => {
    loadDeliveries();
  }, [loadDeliveries]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') refreshHealth();
    };
    const timer = window.setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refreshHealth]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') loadDeliveries();
    };
    const timer = window.setInterval(refresh, 30000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadDeliveries]);

  async function updateSavedChannel(saved) {
    if (!saved) return;
    setChannels(current =>
      (current || []).map(item =>
        item.channel === saved.channel ? normalizeChannel(saved) : item
      )
    );
  }

  async function retry(item) {
    let acknowledgeUnknown = false;
    if (item.status === 'unknown') {
      acknowledgeUnknown = window.confirm('该投递已出站但结果无法确认。重试可能造成重复通知。确认已经核对并仍要重试？');
      if (!acknowledgeUnknown) return;
    } else if (!window.confirm('确认重试这条失败投递？系统会再次校验目标、通道开关和事件状态。')) return;
    try {
      await retryServerMonitorDelivery(item.id, { expectedVersion: item.version, ...(acknowledgeUnknown ? { acknowledgeUnknown: true } : {}) });
      await loadDeliveries();
      onNotice('重试请求已登记。');
    } catch (retryError) {
      setHistoryError(errorMessage(retryError));
    }
  }

  async function cancel(item) {
    if (!window.confirm('仅可取消尚未出站的投递。确认取消此排队任务？')) return;
    try {
      await cancelServerMonitorDelivery(item.id, { expectedVersion: item.version, reason: '用户在监控通知页面取消' });
      await loadDeliveries();
      onNotice('排队投递已取消。');
    } catch (cancelError) {
      setHistoryError(errorMessage(cancelError));
    }
  }

  const healthByChannel = Object.fromEntries((health?.channels || []).map(item => [item.channel, item]));
  const channelList = channels || [];
  return (
    <div className="space-y-4">
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <section className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead className="bg-gray-50 text-gray-500"><tr><th className="p-3">通道</th><th className="p-3">自动通知</th><th className="p-3">Worker 状态</th><th className="p-3">心跳 / 最近接受</th><th className="p-3">待发 / 逾期</th><th className="p-3">最老到期</th><th className="p-3">失败 / 未知</th><th className="p-3">暂停原因</th></tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? <tr><td colSpan="8" className="p-6 text-center text-gray-500">正在读取通知状态…</td></tr> : channelList.map(channel => {
              const status = healthByChannel[channel.channel] || {};
              return <tr key={channel.channel}><td className="p-3 font-medium">{CHANNEL_NAME[channel.channel] || channel.channel}</td><td className="p-3">{channel.enabled ? '启用' : '已关闭'}</td><td className="p-3">{getChannelHealthLabel(channel, status)}</td><td className="p-3">心跳 {formatTime(status.heartbeatAt)}<br />超时阈值 {status.staleAfterSeconds ?? '—'} 秒<br />接受 {formatTime(status.lastAcceptedAt || channel.lastAcceptedAt)}</td><td className="p-3">{status.pendingCount ?? '—'} / {status.overdueCount ?? '—'}</td><td className="p-3">{formatTime(status.oldestDueAt)}</td><td className="p-3">{status.failedCount ?? '—'} / {status.unknownCount ?? '—'}</td><td className="p-3">{status.pausedReason || channel.pausedReason || '—'}</td></tr>;
            })}
          </tbody>
        </table>
      </section>
      {health?.coverage && (health.coverage.healthEvents !== true || health.coverage.noNewLogs !== true || health.coverage.externalWatchdog !== true) && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          当前页面不表示第二阶段设备健康事件、无新增日志检测或外部看门狗已经覆盖。
        </p>
      )}
      {invalidEventId && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">链接中的事件 ID 格式无效，未发起筛选请求。请从告警通知中重新打开链接。</p>}
      {refreshing && <p role="status" className="text-xs text-gray-500">正在刷新通知健康状态…</p>}

      {loading && !channels ? <p role="status" className="p-6 text-center text-gray-500">正在读取通道设置…</p> : channelList.map(channel => (
        <ChannelEditor key={channel.channel} channel={channel} onSaved={updateSavedChannel} onNotice={onNotice} canConfigure={canConfigure} />
      ))}

      <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-gray-900">通知投递记录</h2>
          <button type="button" className="btn btn-secondary inline-flex items-center gap-1" onClick={loadDeliveries}>
            <RefreshCw className="h-4 w-4" />刷新记录
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm text-gray-700">通道<select className="input" value={filterDraft.channel} onChange={event => setFilterDraft(current => ({ ...current, channel: event.target.value }))}><option value="">全部通道</option><option value="email">邮件</option><option value="wecom">企业微信</option></select></label>
          <label className="flex flex-col gap-1 text-sm text-gray-700">状态<select className="input" value={filterDraft.status} onChange={event => setFilterDraft(current => ({ ...current, status: event.target.value }))}><option value="">全部状态</option>{Object.entries(STATUS_NAME).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
          <label className="flex flex-col gap-1 text-sm text-gray-700">设备 ID<input className="input" value={filterDraft.deviceId} onChange={event => setFilterDraft(current => ({ ...current, deviceId: event.target.value }))} /></label>
          <label className="flex flex-col gap-1 text-sm text-gray-700">事件 ID<input className="input" value={filterDraft.eventId} onChange={event => setFilterDraft(current => ({ ...current, eventId: event.target.value }))} /></label>
          <label className="flex flex-col gap-1 text-sm text-gray-700">开始日期<input className="input" type="date" value={filterDraft.dateFrom} onChange={event => setFilterDraft(current => ({ ...current, dateFrom: event.target.value }))} /></label>
          <label className="flex flex-col gap-1 text-sm text-gray-700">结束日期<input className="input" type="date" value={filterDraft.dateTo} onChange={event => setFilterDraft(current => ({ ...current, dateTo: event.target.value }))} /></label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => { setFilters(filterDraft); setCursorStack([]); }}>应用筛选</button>
          <button type="button" className="btn btn-secondary" onClick={() => { const empty = { channel: '', status: '', deviceId: '', eventId: '', dateFrom: '', dateTo: '' }; setFilterDraft(empty); setFilters(empty); setCursorStack([]); }}>清除筛选</button>
        </div>
        {historyError && <p role="alert" className="text-sm text-red-700">{historyError}</p>}
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full min-w-[1050px] text-left text-sm">
            <thead className="bg-gray-50 text-gray-500"><tr><th className="p-3">创建时间</th><th className="p-3">通道 / 目标</th><th className="p-3">事件 / 级别</th><th className="p-3">状态</th><th className="p-3">计划 / 发送</th><th className="p-3">次数</th><th className="p-3">失败摘要</th><th className="p-3">操作</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 ? <tr><td colSpan="8" className="p-8 text-center text-gray-500">{historyError ? '投递记录加载失败。' : '暂无投递记录。'}</td></tr> : rows.map(item => (
                <tr key={item.id} className="align-top hover:bg-gray-50"><td className="p-3 whitespace-nowrap">{formatTime(item.createdAt)}</td><td className="p-3">{CHANNEL_NAME[item.channel] || item.channel}<br /><span className="text-gray-500">{item.targetName || '—'}</span></td><td className="p-3">{CATEGORY_NAME[item.category] || item.category} / {SEVERITY_NAME[item.severity] || item.severity}<br /><span className="text-gray-500">{item.eventCount ?? 0} 个事件</span></td><td className="p-3">{STATUS_NAME[item.status] || item.status}</td><td className="p-3">计划 {formatTime(item.notBefore)}<br />发送 {formatTime(item.sentAt)}</td><td className="p-3">{item.attempts}</td><td className="p-3 max-w-xs break-words">{item.lastError || item.errorCode || '—'}</td><td className="p-3"><div className="flex flex-wrap gap-1"><button type="button" className="text-primary underline" onClick={() => setSelectedId(item.id)}>详情</button>{canRetry && ['failed', 'unknown'].includes(item.status) && <button type="button" className="text-primary underline" onClick={() => retry(item)}>重试</button>}{canRetry && item.status === 'pending' && <button type="button" className="text-red-700 underline" onClick={() => cancel(item)}>取消</button>}</div></td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" className="btn btn-secondary" disabled={!cursorStack.length} onClick={() => setCursorStack(stack => stack.slice(0, -1))}>上一页</button>
          <span>每页 30 条</span>
          <button type="button" className="btn btn-secondary" disabled={!nextCursor} onClick={() => setCursorStack(stack => [...stack, nextCursor])}>下一页</button>
        </div>
      </section>
      {selectedId && <DeliveryDetail id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
