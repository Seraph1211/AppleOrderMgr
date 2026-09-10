import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, RefreshCw, Plus, X, Eye, Save, KeyRound, Copy } from 'lucide-react';
import { readIngestion, writeIngestion } from '../api/orderIngestionApi';
import { formatOrderTime } from '../utils/orderTime';

const STATUS = {
  received: '已接收',
  parsing: '解析中',
  ready: '待入库',
  processing: '入库中',
  succeeded: '已入库',
  duplicate: '重复留痕',
  retry_wait: '等待重试',
  manual_review: '待人工处理',
  closed: '已关闭',
};
const ELIGIBILITY = {
  allowed: '可处理',
  source_disabled: '来源暂停',
  device_disabled: '设备禁用',
  out_of_range: '超出当天范围',
};
const SCAN = {
  ready: '目录正常',
  waiting_file: '等待当天文件',
  unreadable: '无法读取',
  missing: '目录不存在',
};
const BACKFILL = {
  queued: '等待扫描',
  running: '扫描中',
  waiting_source: '等待来源完成扫描',
  partial: '部分完成',
  completed: '本轮完成',
  superseded: '被后续切换替代',
  failed: '扫描失败',
};
const FIELD_LABELS = {
  orderNumber: '订单号',
  contactEmail: '联系邮箱',
  appleId: 'Apple ID',
  lastName: '姓',
  firstName: '名',
  contactPhone: '手机号',
  recipientIdLast4: '身份证后四位',
  pickupStoreCode: '门店代码',
  paymentMethod: '支付方式',
  recipientTag: '来源 TAG',
  orderUrl: '订单链接',
  orderDate: '下单时间（北京时间）',
};
const TERMINAL = ['succeeded', 'duplicate', 'closed'];
const EMPTY_LIST = { items: [], total: 0, page: 1, limit: 20 };
const time = value => (value ? formatOrderTime(value) : '—');

function Pagination({ data, setPage, disabled }) {
  return (
    <div className="flex items-center justify-between gap-4 p-4 text-sm text-gray-600">
      <span>
        共 {data.total} 条 · 第 {data.page} / {Math.max(1, Math.ceil(data.total / data.limit))} 页
      </span>
      <div className="flex gap-2">
        <button
          className="btn btn-secondary"
          disabled={disabled || data.page <= 1}
          onClick={() => setPage(data.page - 1)}
        >
          上一页
        </button>
        <button
          className="btn btn-secondary"
          disabled={disabled || data.page * data.limit >= data.total}
          onClick={() => setPage(data.page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

function Dialog({ title, onClose, children }) {
  const dialog = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => [
      ...(dialog.current?.querySelectorAll(
        'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]'
      ) || []),
    ];
    focusable()[0]?.focus();
    const handler = e => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const items = focusable();
        if (!items.length) {
          e.preventDefault();
          return;
        }
        if (e.shiftKey && document.activeElement === items[0]) {
          e.preventDefault();
          items.at(-1).focus();
        } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
          e.preventDefault();
          items[0].focus();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/30 p-4">
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-xl bg-white p-6 shadow-xl"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
          <button className="btn btn-secondary" aria-label="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

/** 管理员来源开关、设备与可靠接收记录。 @returns {JSX.Element} 页面 */
export default function OrderIngestion() {
  const [settings, setSettings] = useState(null);
  const [devices, setDevices] = useState(EMPTY_LIST);
  const [records, setRecords] = useState(EMPTY_LIST);
  const [audits, setAudits] = useState(EMPTY_LIST);
  const [tab, setTab] = useState('records');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    status: '',
    eligibility: '',
    deviceId: '',
    orderNumber: '',
    dateFrom: '',
    dateTo: '',
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [preview, setPreview] = useState(null);
  const [backfill, setBackfill] = useState(null);
  const [deviceForm, setDeviceForm] = useState(null);
  const [credential, setCredential] = useState(null);
  const [detail, setDetail] = useState(null);
  const [content, setContent] = useState(null);
  const [draft, setDraft] = useState(null);
  const [password, setPassword] = useState('');
  const [passwordAction, setPasswordAction] = useState('keep');
  const [reason, setReason] = useState('');
  const [linkOrderId, setLinkOrderId] = useState('');
  const mutationKeys = useRef(new Map());
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const params = Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
      if (params.orderNumber && !/^W\d{10}$/.test(params.orderNumber)) delete params.orderNumber;
      const [s, d, list] = await Promise.all([
        readIngestion('/settings'),
        readIngestion('/devices', {
          page: tab === 'devices' ? page : 1,
          limit: tab === 'devices' ? 20 : 100,
        }),
        readIngestion(tab === 'audits' ? '/audits' : '/aos-records', {
          page: tab === 'records' || tab === 'audits' ? page : 1,
          limit: 20,
          ...(tab === 'audits' ? {} : params),
        }),
      ]);
      if (generation !== loadGeneration.current) return;
      setSettings(s.data);
      setDevices(d.data);
      if (tab === 'audits') setAudits(list.data);
      else setRecords(list.data);
      setUpdatedAt(new Date());
    } catch (failure) {
      if (generation === loadGeneration.current) setError(failure.message);
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [tab, page, filters]);

  useEffect(() => {
    setLoading(true);
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 5000);
    const visible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      loadGeneration.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (!backfill?.id || ['completed', 'superseded'].includes(backfill.status)) return;
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await readIngestion(`/backfills/${backfill.id}`);
        setBackfill(result.data);
      } catch (failure) {
        setError(failure.message);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [backfill?.id, backfill?.status]);

  useEffect(() => {
    if (!detail?.id || !['ready', 'processing', 'retry_wait'].includes(detail.status) || draft)
      return;
    let active = true;
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || busy) return;
      try {
        const result = await readIngestion(`/aos-records/${detail.id}`);
        if (active) setDetail(current => (current?.id === result.data.id ? result.data : current));
      } catch (failure) {
        if (active) setError(failure.message);
      }
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [detail?.id, detail?.status, draft, busy]);

  async function mutate(label, method, path, body, after) {
    if (busy) return;
    const signature = JSON.stringify([method, path, body]);
    let key = mutationKeys.current.get(signature);
    if (!key) {
      key = crypto.randomUUID();
      mutationKeys.current.set(signature, key);
    }
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const response = await writeIngestion(method, path, body, key);
      mutationKeys.current.delete(signature);
      await after?.(response.data);
      setNotice(`${label}已完成`);
      await load();
    } catch (failure) {
      setError(failure.message);
      if (['VERSION_CONFLICT', 'PREVIEW_EXPIRED', 'RECORD_STATE_INVALID'].includes(failure.code)) {
        mutationKeys.current.delete(signature);
        setPreview(null);
        await load();
      }
    } finally {
      setBusy('');
    }
  }

  async function prepareSwitch(targetSource) {
    setBusy('生成切换预览');
    setError('');
    try {
      const result = await writeIngestion(
        'post',
        '/switch-preview',
        { targetSource, expectedVersion: settings.version },
        crypto.randomUUID()
      );
      setPreview(result.data);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }
  const openRecord = useCallback(async id => {
    setBusy('读取记录');
    setError('');
    setContent(null);
    setDraft(null);
    setPassword('');
    setReason('');
    setLinkOrderId('');
    try {
      const result = await readIngestion(`/aos-records/${id}`);
      setDetail(result.data);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }, []);
  useEffect(() => {
    const record = new URLSearchParams(window.location.search).get('record');
    if (record && /^[a-f0-9-]{36}$/i.test(record)) openRecord(record);
  }, [openRecord]);
  async function showContent() {
    setBusy('读取敏感内容');
    setError('');
    try {
      const result = await readIngestion(`/aos-records/${detail.id}/content`);
      setContent(result.data);
      setDraft(result.data.data);
      setPassword('');
      setPasswordAction('keep');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }
  async function readDeviceCredential(device) {
    setBusy('读取设备凭证');
    setError('');
    try {
      const result = await readIngestion(`/devices/${device.id}/credential`);
      return result.data;
    } catch (failure) {
      setError(failure.message);
      return null;
    } finally {
      setBusy('');
    }
  }
  async function showDeviceCredential(device) {
    const result = await readDeviceCredential(device);
    if (result) setCredential(result);
  }
  async function copyDeviceCredential(device) {
    const result = await readDeviceCredential(device);
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.credential);
      setNotice(`${device.name} 的接入凭证已复制`);
    } catch (_failure) {
      setCredential(result);
      setError('浏览器未允许自动复制，请在弹窗中手动复制');
    }
  }
  async function copyCollectorServerUrl() {
    if (!settings?.collectorServerUrl) return;
    try {
      await navigator.clipboard.writeText(settings.collectorServerUrl);
      setNotice('采集器服务器 HTTPS 地址已复制');
    } catch (_failure) {
      setError('浏览器未允许自动复制，请手动选中地址复制');
    }
  }
  async function copyVisibleCredential() {
    try {
      await navigator.clipboard.writeText(credential.credential);
      setNotice(`${credential.device.name} 的接入凭证已复制`);
    } catch (_failure) {
      setError('浏览器未允许自动复制，请手动选中凭证复制');
    }
  }
  const closeDetail = useCallback(() => {
    setDetail(null);
    setContent(null);
    setDraft(null);
    setPassword('');
  }, []);
  const updateRecord = result => {
    setDetail(result.record);
    setContent(null);
    setDraft(null);
    setPassword('');
  };
  const changeFilter = (key, value) => {
    setPage(1);
    setFilters(current => ({ ...current, [key]: value }));
  };
  const canProcess =
    detail?.eligibility === 'allowed' &&
    !TERMINAL.includes(detail?.status) &&
    detail?.status !== 'processing';

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-bold text-gray-900">
            <Database className="h-6 w-6 text-primary" />
            订单数据源
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            选择自动入库来源，查看设备传输和订单处理结果。
          </p>
        </div>
        <button
          className="btn btn-secondary flex items-center gap-2"
          disabled={loading || !!busy}
          onClick={load}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </header>
      {error && (
        <div
          role="alert"
          className="fixed left-1/2 top-4 z-[70] w-[min(90vw,48rem)] -translate-x-1/2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 shadow"
        >
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-green-700">
          {notice}
        </p>
      )}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-gray-900">
              当前来源：
              {settings ? (settings.activeSource === 'aos' ? 'AOS 文件' : '邮件') : '加载中…'}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              重复订单仅关联留痕 · 切换后补录北京时间当天订单 · 已采集的跨天积压自动恢复
            </p>
            <p className="mt-2 text-xs text-gray-500">
              邮件：{settings?.readiness?.email.ready ? '已就绪' : '等待 Worker'} · AOS：
              {settings?.readiness?.aos.healthyDirectoryDeviceCount || 0} 台目录正常 /{' '}
              {settings?.readiness?.aos.enabledDeviceCount || 0} 台启用设备
            </p>
          </div>
          <div className="flex gap-2">
            {['email', 'aos'].map(source => (
              <button
                key={source}
                className={`btn ${settings?.activeSource === source ? 'btn-primary' : 'btn-secondary'}`}
                disabled={!settings || !!busy || settings.activeSource === source}
                onClick={() => prepareSwitch(source)}
              >
                {source === 'email' ? '邮件' : 'AOS 文件'}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          设置生效：{time(settings?.effectiveAt)} · 页面更新：{time(updatedAt)}
        </p>
      </section>
      {backfill && (
        <section className="rounded-lg border border-blue-200 bg-primary-50 p-4 text-sm">
          <p className="font-medium">当天补录：{BACKFILL[backfill.status] || backfill.status}</p>
          <p className="mt-1">
            已接收 {backfill.counts?.received ?? '—'} · 已入库 {backfill.counts?.created ?? '—'} ·
            重复 {backfill.counts?.duplicate ?? '—'} · 待处理 {backfill.counts?.pending ?? '—'}
          </p>
          <p className="mt-1 text-gray-600">
            来源尚未完成回查或设备尚未确认扫描时，此处不会显示全部完成。
          </p>
        </section>
      )}
      <div className="flex gap-1 border-b border-gray-200">
        {[
          ['records', 'AOS 处理记录'],
          ['devices', '采集设备'],
          ['audits', '操作审计'],
        ].map(([value, label]) => (
          <button
            key={value}
            onClick={() => {
              setTab(value);
              setPage(1);
            }}
            className={`px-5 py-3 text-sm ${tab === value ? 'border-b-2 border-primary font-medium text-primary' : 'text-gray-500'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'records' && (
        <>
          <div className="flex flex-wrap gap-3">
            <input
              aria-label="订单号筛选"
              className="input w-44"
              placeholder="完整订单号"
              value={filters.orderNumber}
              onChange={e => changeFilter('orderNumber', e.target.value)}
            />
            <select
              aria-label="处理状态"
              className="input w-40"
              value={filters.status}
              onChange={e => changeFilter('status', e.target.value)}
            >
              <option value="">全部处理状态</option>
              {Object.entries(STATUS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <select
              aria-label="入库资格"
              className="input w-40"
              value={filters.eligibility}
              onChange={e => changeFilter('eligibility', e.target.value)}
            >
              <option value="">全部入库资格</option>
              {Object.entries(ELIGIBILITY).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <select
              aria-label="设备筛选"
              className="input w-40"
              value={filters.deviceId}
              onChange={e => changeFilter('deviceId', e.target.value)}
            >
              <option value="">全部设备</option>
              {devices.items.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <input
              aria-label="下单起始日期"
              className="input w-40"
              type="date"
              value={filters.dateFrom}
              onChange={e => changeFilter('dateFrom', e.target.value)}
            />
            <input
              aria-label="下单结束日期"
              className="input w-40"
              type="date"
              value={filters.dateTo}
              onChange={e => changeFilter('dateTo', e.target.value)}
            />
          </div>
          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-left text-sm">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    {['订单号／文件', '下单时间', '设备', '处理结果', '入库资格', '操作'].map(
                      label => (
                        <th key={label} className="px-4 py-3 font-medium">
                          {label}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {records.items.map(row => (
                    <tr key={row.id} className="border-t border-gray-200 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="font-mono text-gray-900">{row.orderNumber || '待解析'}</p>
                        <p className="mt-1 text-xs text-gray-500">
                          {row.fileName} · 第 {row.lineNumber} 行
                        </p>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{time(row.orderDate)}</td>
                      <td className="px-4 py-3">
                        {devices.items.find(d => d.id === row.deviceId)?.name || '设备记录'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`badge ${row.status === 'manual_review' ? 'badge-error' : row.status === 'succeeded' ? 'badge-success' : 'badge-info'}`}
                        >
                          {STATUS[row.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3">{ELIGIBILITY[row.eligibility]}</td>
                      <td className="px-4 py-3">
                        <button
                          className="text-primary hover:underline"
                          disabled={!!busy}
                          onClick={() => openRecord(row.id)}
                        >
                          查看处理
                        </button>
                        {row.orderId && (
                          <Link
                            className="ml-3 text-primary hover:underline"
                            to={`/orders/${row.orderId}`}
                          >
                            查看订单
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!records.items.length && (
                <p className="p-10 text-center text-gray-500">
                  {loading ? '正在读取记录…' : '暂无符合条件的记录'}
                </p>
              )}
            </div>
            <Pagination data={records} setPage={setPage} disabled={loading} />
          </section>
        </>
      )}
      {tab === 'devices' && (
        <>
          <section className="rounded-xl border border-blue-200 bg-primary-50 p-4">
            <p className="text-sm font-medium text-gray-900">采集器服务器 HTTPS 地址</p>
            {settings?.collectorServerUrl ? (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <input
                  aria-label="采集器服务器 HTTPS 地址"
                  className="input min-w-0 flex-1 font-mono"
                  readOnly
                  value={settings.collectorServerUrl}
                  onFocus={event => event.target.select()}
                />
                <button
                  className="btn btn-secondary flex items-center gap-2"
                  onClick={copyCollectorServerUrl}
                >
                  <Copy className="h-4 w-4" />
                  复制地址
                </button>
              </div>
            ) : (
              <p className="mt-2 text-sm text-amber-700">
                服务器尚未配置公网地址。请由部署人员从 HTTPS 域名或 Cloudflare Tunnel
                获取根地址，并设置 AOS_COLLECTOR_PUBLIC_URL。
              </p>
            )}
            {settings?.collectorServerUrl?.includes('.trycloudflare.com') && (
              <p className="mt-2 text-xs text-amber-700">
                当前为临时 Quick Tunnel 地址；隧道重启后地址可能变化，需同步更新服务器配置和采集器。
              </p>
            )}
          </section>
          <div className="flex justify-end">
            <button
              className="btn btn-primary flex items-center gap-2"
              disabled={!!busy}
              onClick={() => setDeviceForm({ name: '', notes: '' })}
            >
              <Plus className="h-4 w-4" />
              登记设备
            </button>
          </div>
          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    {['设备', '运行状态', '目录状态', '传输／入库', '最近扫描', '操作'].map(l => (
                      <th key={l} className="px-4 py-3 font-medium">
                        {l}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {devices.items.map(d => (
                    <tr key={d.id} className="border-t border-gray-200">
                      <td className="px-4 py-4">
                        <p className="font-medium">{d.name}</p>
                        <p className="text-xs text-gray-500">{d.agentVersion || '尚未连接'}</p>
                      </td>
                      <td className="px-4 py-4">
                        {!d.enabled ? '已禁用' : d.online ? '在线' : '离线'}
                        <p className="text-xs text-gray-500">
                          {d.scanHealthy ? '扫描正常' : '扫描状态待核实'}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        {d.directories.length
                          ? d.directories.map(dir => (
                              <p key={dir.directoryId}>
                                {dir.label}：{SCAN[dir.state]}
                              </p>
                            ))
                          : '尚无目录报告'}
                      </td>
                      <td className="px-4 py-4">
                        本地待上传 {d.localCounts.pendingUpload}
                        <p className="text-xs text-gray-500">
                          今日接收 {d.serverCounts.todayReceived} · 已入库 {d.serverCounts.created}
                        </p>
                      </td>
                      <td className="px-4 py-4">{time(d.lastSuccessfulScanAt)}</td>
                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-3">
                          <button
                            className="text-primary"
                            disabled={!!busy}
                            onClick={() => setDeviceForm(d)}
                          >
                            编辑
                          </button>
                          <button
                            className="text-primary"
                            disabled={!!busy}
                            onClick={() =>
                              mutate(
                                d.enabled ? '禁用设备' : '启用设备',
                                'patch',
                                `/devices/${d.id}`,
                                {
                                  expectedVersion: d.version,
                                  enabled: !d.enabled,
                                }
                              )
                            }
                          >
                            {d.enabled ? '禁用' : '启用'}
                          </button>
                          <button
                            className="text-primary"
                            disabled={!!busy}
                            onClick={() => showDeviceCredential(d)}
                          >
                            查看凭证
                          </button>
                          <button
                            className="text-primary"
                            disabled={!!busy}
                            onClick={() => copyDeviceCredential(d)}
                          >
                            复制凭证
                          </button>
                          <button
                            className="text-primary"
                            disabled={!!busy}
                            onClick={() =>
                              setCredential({
                                device: d,
                                confirmRotation: true,
                              })
                            }
                          >
                            轮换凭证
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!devices.items.length && (
                <p className="p-10 text-center text-gray-500">尚未登记采集设备</p>
              )}
            </div>
            <Pagination data={devices} setPage={setPage} disabled={loading} />
          </section>
        </>
      )}
      {tab === 'audits' && (
        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  {['时间', '操作人', '动作', '目标'].map(l => (
                    <th key={l} className="px-4 py-3">
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {audits.items.map(row => (
                  <tr key={row.id} className="border-t border-gray-200">
                    <td className="px-4 py-3">{time(row.createdAt)}</td>
                    <td className="px-4 py-3">{row.username || '系统'}</td>
                    <td className="px-4 py-3">{row.action}</td>
                    <td className="px-4 py-3">{row.target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!audits.items.length && <p className="p-10 text-center text-gray-500">暂无操作审计</p>}
          </div>
          <Pagination data={audits} setPage={setPage} disabled={loading} />
        </section>
      )}

      {preview && (
        <Dialog title="确认切换订单数据源" onClose={() => !busy && setPreview(null)}>
          <p>
            切换到 <strong>{preview.targetSource === 'aos' ? 'AOS 文件' : '邮件'}</strong>
            ，补录日期为 {preview.businessDate}（北京时间）。
          </p>
          <p className="mt-3 text-sm text-gray-600">
            服务器已知待处理 {preview.knownPendingCount ?? '未知'} 条、重复{' '}
            {preview.knownDuplicateCount ?? '未知'} 条。
          </p>
          {preview.warnings.map((w, i) => (
            <p key={i} className="mt-2 text-sm text-amber-700">
              {w}
            </p>
          ))}
          <p className="mt-2 text-sm text-gray-500">
            旧来源停止入库，已接收记录保留。已有订单和付款处理不重置。
          </p>
          <button
            className="btn btn-primary mt-5"
            disabled={!!busy}
            onClick={() =>
              mutate(
                '切换来源',
                'put',
                '/settings',
                {
                  activeSource: preview.targetSource,
                  expectedVersion: preview.settingsVersion,
                  previewId: preview.previewId,
                },
                async result => {
                  setPreview(null);
                  if (result.backfillId) {
                    const b = await readIngestion(`/backfills/${result.backfillId}`);
                    setBackfill(b.data);
                  }
                }
              )
            }
          >
            {busy || '确认切换并补录当天'}
          </button>
        </Dialog>
      )}
      {deviceForm && (
        <Dialog
          title={deviceForm.id ? '编辑设备' : '登记采集设备'}
          onClose={() => !busy && setDeviceForm(null)}
        >
          <label className="block text-sm text-gray-700">
            设备名称
            <input
              className="input mt-1 w-full"
              maxLength={100}
              value={deviceForm.name}
              onChange={e => setDeviceForm({ ...deviceForm, name: e.target.value })}
            />
          </label>
          <label className="mt-4 block text-sm text-gray-700">
            备注
            <textarea
              className="input mt-1 w-full"
              maxLength={500}
              value={deviceForm.notes || ''}
              onChange={e => setDeviceForm({ ...deviceForm, notes: e.target.value })}
            />
          </label>
          <p className="mt-3 text-sm text-gray-500">监控目录在 Windows 采集器中选择和保存。</p>
          <button
            className="btn btn-primary mt-5"
            disabled={!!busy || !deviceForm.name.trim()}
            onClick={() =>
              mutate(
                '保存设备',
                deviceForm.id ? 'patch' : 'post',
                deviceForm.id ? `/devices/${deviceForm.id}` : '/devices',
                {
                  name: deviceForm.name,
                  notes: deviceForm.notes || '',
                  ...(deviceForm.id ? { expectedVersion: deviceForm.version } : {}),
                },
                result => {
                  setDeviceForm(null);
                  if ('credential' in result) setCredential(result);
                }
              )
            }
          >
            保存设备
          </button>
        </Dialog>
      )}
      {credential && (
        <Dialog
          title={credential.confirmRotation ? '轮换设备接入凭证' : '设备接入凭证'}
          onClose={() => !busy && setCredential(null)}
        >
          {credential.confirmRotation ? (
            <>
              <p>
                轮换后旧凭证立即失效。请在 {credential.device.name}{' '}
                的采集器中更新凭证，本地待发送队列会保留。
              </p>
              <button
                className="btn btn-primary mt-5 flex items-center gap-2"
                disabled={!!busy}
                onClick={() =>
                  mutate(
                    '轮换凭证',
                    'post',
                    `/devices/${credential.device.id}/rotate-credential`,
                    { expectedVersion: credential.device.version },
                    result => setCredential(result)
                  )
                }
              >
                <KeyRound className="h-4 w-4" />
                确认轮换
              </button>
            </>
          ) : (
            <>
              <p className="mb-4 text-sm text-gray-600">
                凭证在数据库中加密保存，每次查看都会记录操作审计。请复制到指定设备的采集器配置窗口。
              </p>
              {credential.credential ? (
                <div className="flex flex-wrap gap-3">
                  <input
                    aria-label="设备接入凭证"
                    className="input min-w-0 flex-1 font-mono"
                    readOnly
                    value={credential.credential}
                    onFocus={e => e.target.select()}
                  />
                  <button
                    className="btn btn-secondary flex items-center gap-2"
                    onClick={copyVisibleCredential}
                  >
                    <Copy className="h-4 w-4" />
                    复制
                  </button>
                </div>
              ) : (
                <p className="text-amber-700">
                  此次返回为幂等回执，凭证不再显示。请在设备列表明确轮换凭证后重新配置。
                </p>
              )}
            </>
          )}
        </Dialog>
      )}
      {detail && (
        <Dialog
          title={`AOS 来源记录 · ${detail.orderNumber || '待解析'}`}
          onClose={() => !busy && closeDetail()}
        >
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="badge badge-info">{STATUS[detail.status]}</span>
            <span>{ELIGIBILITY[detail.eligibility]}</span>
            <span>
              {detail.fileName} · 第 {detail.lineNumber} 行
            </span>
            {detail.orderId && (
              <Link className="text-primary" to={`/orders/${detail.orderId}`}>
                查看订单
              </Link>
            )}
          </div>
          {detail.issues?.map((i, n) => (
            <p key={n} className="mt-2 text-sm text-red-700">
              {FIELD_LABELS[i.field] || i.field}：{i.message}
            </p>
          ))}
          <dl className="my-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {[
              'lastName',
              'firstName',
              'contactEmail',
              'appleId',
              'contactPhone',
              'pickupStoreCode',
              'recipientTag',
              'orderDate',
            ].map(k => (
              <div key={k}>
                <dt className="text-gray-500">{FIELD_LABELS[k]}</dt>
                <dd className="break-all text-gray-900">
                  {k === 'orderDate' ? time(detail.safePreview[k]) : detail.safePreview[k] || '—'}
                </dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-secondary flex items-center gap-2"
              disabled={!!busy}
              onClick={showContent}
            >
              <Eye className="h-4 w-4" />
              查看原文与编辑资料
            </button>
            {!TERMINAL.includes(detail.status) && (
              <button
                className="btn btn-secondary"
                disabled={!!busy || detail.status === 'processing'}
                onClick={() =>
                  mutate(
                    '重新解析',
                    'post',
                    `/aos-records/${detail.id}/reparse`,
                    { expectedVersion: detail.version },
                    updateRecord
                  )
                }
              >
                重新解析原文件
              </button>
            )}
            {detail.status === 'retry_wait' && (
              <button
                className="btn btn-secondary"
                disabled={!!busy || !canProcess}
                onClick={() =>
                  mutate(
                    '重新排队',
                    'post',
                    `/aos-records/${detail.id}/retry`,
                    { expectedVersion: detail.version },
                    updateRecord
                  )
                }
              >
                重试上传后的处理
              </button>
            )}
          </div>
          {content && (
            <>
              <details className="my-4">
                <summary className="cursor-pointer text-sm text-gray-600">
                  原始行（含敏感信息，查看已审计）
                </summary>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-50 p-3 text-xs">
                  {content.rawLine}
                </pre>
              </details>
              {draft && !TERMINAL.includes(detail.status) && (
                <fieldset
                  disabled={!!busy || detail.status === 'processing'}
                  className="my-4 space-y-4"
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {Object.entries(FIELD_LABELS).map(([key, label]) => (
                      <label key={key} className="text-sm text-gray-700">
                        {label}
                        <input
                          autoComplete="off"
                          className="input mt-1 w-full"
                          value={
                            key === 'orderDate'
                              ? draft[key]
                                ? new Date(new Date(draft[key]).getTime() + 8 * 3600000)
                                    .toISOString()
                                    .slice(0, -1)
                                : ''
                              : draft[key] || ''
                          }
                          type={key === 'orderDate' ? 'datetime-local' : 'text'}
                          step={key === 'orderDate' ? '0.001' : undefined}
                          onChange={e =>
                            setDraft({
                              ...draft,
                              [key]:
                                key === 'orderDate'
                                  ? e.target.value
                                    ? `${e.target.value.length === 16 ? `${e.target.value}:00` : e.target.value}+08:00`
                                    : ''
                                  : e.target.value,
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr>
                          <th>商品型号</th>
                          <th>商品名称</th>
                          <th>数量</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {(draft.products || []).map((p, index) => (
                          <tr key={index}>
                            {['model', 'name', 'quantity'].map(field => (
                              <td key={field} className="p-1">
                                <input
                                  aria-label={`商品${index + 1}${field}`}
                                  className="input w-full"
                                  type={field === 'quantity' ? 'number' : 'text'}
                                  min={field === 'quantity' ? 1 : undefined}
                                  value={p?.[field] ?? ''}
                                  onChange={e =>
                                    setDraft({
                                      ...draft,
                                      products: draft.products.map((item, n) =>
                                        n === index
                                          ? {
                                              ...item,
                                              [field]:
                                                field === 'quantity'
                                                  ? Number(e.target.value)
                                                  : e.target.value,
                                            }
                                          : item
                                      ),
                                    })
                                  }
                                />
                              </td>
                            ))}
                            <td>
                              <button
                                type="button"
                                aria-label="移除商品"
                                onClick={() =>
                                  setDraft({
                                    ...draft,
                                    products: draft.products.filter((_, n) => n !== index),
                                  })
                                }
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    className="btn btn-secondary"
                    disabled={draft.products?.length >= 50}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        products: [...(draft.products || []), { model: '', name: '', quantity: 1 }],
                      })
                    }
                  >
                    添加商品
                  </button>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="text-sm">
                      <input
                        type="checkbox"
                        checked={passwordAction === 'replace'}
                        onChange={e => setPasswordAction(e.target.checked ? 'replace' : 'keep')}
                      />{' '}
                      替换订单密码快照
                    </label>
                    {passwordAction === 'replace' && (
                      <input
                        className="input"
                        type="password"
                        autoComplete="new-password"
                        aria-label="替换密码"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                      />
                    )}
                  </div>
                  <button
                    className="btn btn-primary flex items-center gap-2"
                    onClick={() =>
                      mutate(
                        '保存草稿',
                        'put',
                        `/aos-records/${detail.id}/draft`,
                        {
                          expectedVersion: detail.version,
                          data: draft,
                          passwordAction,
                          ...(passwordAction === 'replace' ? { password } : {}),
                        },
                        updateRecord
                      )
                    }
                  >
                    <Save className="h-4 w-4" />
                    保存草稿
                  </button>
                </fieldset>
              )}
            </>
          )}
          {!TERMINAL.includes(detail.status) && (
            <div className="mt-5 space-y-4 border-t border-gray-200 pt-4">
              <button
                className="btn btn-primary"
                disabled={!!busy || !canProcess || detail.status !== 'ready' || !!draft}
                title={draft ? '先保存草稿' : ELIGIBILITY[detail.eligibility]}
                onClick={() =>
                  mutate(
                    '确认入库',
                    'post',
                    `/aos-records/${detail.id}/ingest`,
                    { expectedVersion: detail.version },
                    updateRecord
                  )
                }
              >
                确认入库
              </button>
              <p className="text-xs text-gray-500">
                保存草稿与入库是两个操作；来源暂停时可修正资料，启用后才能入库。
              </p>
              <label className="block text-sm text-gray-700">
                人工处理原因
                <textarea
                  className="input mt-1 w-full"
                  maxLength={500}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-3">
                <button
                  className="btn btn-secondary"
                  disabled={!!busy || !reason.trim() || detail.status === 'processing'}
                  onClick={() =>
                    mutate(
                      '关闭来源记录',
                      'post',
                      `/aos-records/${detail.id}/resolve`,
                      {
                        expectedVersion: detail.version,
                        action: 'close',
                        reason,
                      },
                      updateRecord
                    )
                  }
                >
                  有理由关闭
                </button>
                <input
                  className="input w-40"
                  type="number"
                  min="1"
                  placeholder="已有订单内部 ID"
                  aria-label="已有订单内部 ID"
                  value={linkOrderId}
                  onChange={e => setLinkOrderId(e.target.value)}
                />
                <button
                  className="btn btn-secondary"
                  disabled={!!busy || !canProcess || !reason.trim() || !linkOrderId}
                  onClick={() =>
                    mutate(
                      '关联已有订单',
                      'post',
                      `/aos-records/${detail.id}/resolve`,
                      {
                        expectedVersion: detail.version,
                        action: 'link_existing',
                        reason,
                        orderId: Number(linkOrderId),
                      },
                      updateRecord
                    )
                  }
                >
                  关联同号订单
                </button>
              </div>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
