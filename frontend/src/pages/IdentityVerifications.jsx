import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ShieldCheck,
  UserRound,
  FileSpreadsheet,
  History,
  Download,
  Upload,
  Play,
  Square,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import { identityApi, downloadIdentityFile } from '../api/identityApi';

const states = {
  pending: ['待核验', 'info'],
  processing: ['核验中', 'info'],
  matched: ['一致', 'success'],
  mismatched: ['不一致', 'error'],
  error: ['接口异常', 'warning'],
  unknown: ['结果未知', 'warning'],
  invalid: ['格式错误', 'error'],
  cancelled: ['已停止', 'warning'],
  draft: ['待确认', 'info'],
  queued: ['排队中', 'info'],
  running: ['核验中', 'info'],
  paused: ['已暂停', 'warning'],
  completed: ['已完成', 'success'],
};
const time = value => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—');
function Badge({ status }) {
  const [label, variant] = states[status] || [status, 'info'];
  return <span className={`badge badge-${variant} whitespace-nowrap`}>{label}</span>;
}

/** 身份核验：单人提交、Excel预览、后台进度和原始记录。 */
export default function IdentityVerifications() {
  const { user, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const batchId = params.get('batch') || '';
  const [tab, setTab] = useState('single');
  const [name, setName] = useState('');
  const [idCardNumber, setIdCardNumber] = useState('');
  const [file, setFile] = useState(null);
  const [service, setService] = useState(null);
  const [detail, setDetail] = useState(null);
  const [history, setHistory] = useState({ batches: [], total: 0 });
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [resultFilter, setResultFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const keyRef = useRef(null);
  const generation = useRef(0);
  const canRead = can(PERMISSIONS.IDENTITY_READ);
  const canVerify = can(PERMISSIONS.IDENTITY_VERIFY);
  const canBatch = can(PERMISSIONS.IDENTITY_BATCH);
  const ready = service?.configured && service?.enabled;

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      setLoading(true);
      const [status, records, selected] = await Promise.all([
        identityApi.status(),
        identityApi.list({
          page,
          from: from || undefined,
          to: to || undefined,
        }),
        batchId ? identityApi.detail(batchId) : Promise.resolve(null),
      ]);
      if (current !== generation.current) return;
      setService(status.data);
      setHistory(records.data);
      setDetail(selected?.data || null);
    } catch (failure) {
      if (current === generation.current) {
        setError(failure.message);
        setDetail(null);
        setHistory({ batches: [], total: 0 });
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [batchId, page, from, to]);

  useEffect(() => {
    if (!canRead) {
      generation.current++;
      setDetail(null);
      setHistory({ batches: [], total: 0 });
      setName('');
      setIdCardNumber('');
      setFile(null);
      return undefined;
    }
    load();
    return () => {
      generation.current++;
    };
  }, [canRead, load]);

  useEffect(() => {
    if (!canRead) return undefined;
    const active =
      detail?.rows.some(row => ['pending', 'processing'].includes(row.status)) &&
      ['queued', 'running', 'cancelled'].includes(detail?.batch.status);
    if (!active && !history.batches.some(batch => ['queued', 'running'].includes(batch.status)))
      return undefined;
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [canRead, detail, history, load]);

  useEffect(() => {
    if (tab === 'single' && !canVerify) setTab(canBatch ? 'excel' : 'history');
    if (tab === 'excel' && !canBatch) setTab(canVerify ? 'single' : 'history');
  }, [tab, canVerify, canBatch]);

  const perform = async action => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const openBatch = id => {
    setResultFilter('');
    setDetail(null);
    setParams({ batch: id });
  };
  const submitSingle = event => {
    event.preventDefault();
    perform(async () => {
      if (!keyRef.current) keyRef.current = crypto.randomUUID();
      const response = await identityApi.single({ name, idCardNumber }, keyRef.current);
      keyRef.current = null;
      openBatch(response.data.batchId);
      setNotice('已提交核验，可在下方查看结果。再次提交将发起新的核验。');
    });
  };
  const preview = () =>
    perform(async () => {
      if (!file) throw new Error('请先选择Excel文件');
      if (!file.name.toLowerCase().endsWith('.xlsx') || file.size > 10 * 1024 * 1024)
        throw new Error('请选择不超过10MB的.xlsx文件');
      const response = await identityApi.preview(file);
      openBatch(response.data.batch.id);
      setNotice('文件预览完成，尚未调用核验服务。请检查下方行数据后点击开始。');
    });
  const control = action =>
    perform(async () => {
      const response = await identityApi.control(batchId, action);
      setDetail(response.data);
      await load();
    });
  const rows = (detail?.rows || []).filter(row => !resultFilter || row.status === resultFilter);
  const actionable = detail?.batch.source === 'single' ? canVerify : canBatch;
  const pending =
    detail?.rows.filter(row => row.status === 'pending' && !row.duplicateOf).length || 0;
  const resolved =
    detail?.rows.filter(row => !['pending', 'processing'].includes(row.status)).length || 0;
  const th = 'px-4 py-3 text-left text-sm font-medium text-gray-500 whitespace-nowrap';
  const td = 'px-4 py-3 text-sm text-gray-700 whitespace-nowrap';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-gray-900">身份核验</h1>
            <p className="text-gray-500 mt-1">核对姓名与身份证信息，支持单人和 Excel 批量核验</p>
          </div>
        </div>
        <button
          className="btn btn-secondary inline-flex items-center gap-2"
          onClick={() => {
            setError('');
            load();
          }}
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 flex gap-2"
        >
          <AlertCircle className="w-5 h-5 shrink-0" />
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-lg border border-blue-200 bg-primary-50 p-4 text-primary"
        >
          {notice}
        </div>
      )}
      {service && !ready && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-yellow-800">
          核验服务尚未配置或未启用。可以预览 Excel 和查看已有记录，启用后才能正式核验。
        </div>
      )}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div
          className="flex border-b border-gray-200 overflow-x-auto"
          role="tablist"
          aria-label="核验方式"
        >
          {[
            ...(canVerify ? [['single', '单人核验', UserRound]] : []),
            ...(canBatch ? [['excel', 'Excel 批量核验', FileSpreadsheet]] : []),
            ['history', '核验记录', History],
          ].map(([key, label, Icon]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`px-5 py-4 text-sm font-medium inline-flex items-center gap-2 whitespace-nowrap border-b-2 ${tab === key ? 'border-primary text-primary bg-primary-50' : 'border-transparent text-gray-500 hover:bg-gray-50'}`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>
        {tab === 'single' && canVerify && (
          <form className="p-6 space-y-5" onSubmit={submitSingle}>
            <div className="flex flex-col lg:flex-row gap-4 lg:items-end">
              <label className="block flex-1 text-sm font-medium text-gray-700">
                姓名
                <input
                  className="input mt-2 w-full"
                  required
                  maxLength={100}
                  autoComplete="off"
                  placeholder="请输入完整姓名"
                  value={name}
                  onChange={event => {
                    setName(event.target.value);
                    keyRef.current = null;
                  }}
                />
              </label>
              <label className="block flex-[2] text-sm font-medium text-gray-700">
                身份证号
                <input
                  className="input mt-2 w-full font-mono"
                  required
                  maxLength={30}
                  autoComplete="off"
                  placeholder="请输入大陆18位居民身份证号"
                  value={idCardNumber}
                  onChange={event => {
                    setIdCardNumber(event.target.value);
                    keyRef.current = null;
                  }}
                />
              </label>
              <button
                className="btn btn-primary inline-flex justify-center items-center gap-2 whitespace-nowrap"
                disabled={busy || !ready}
              >
                <ShieldCheck className="w-4 h-4" />
                {busy ? '正在提交…' : '核验一次'}
              </button>
            </div>
            <p className="text-sm text-gray-500">
              提交后向已购服务发送姓名与身份证号，预计消耗 1 次套餐额度。一致与不一致均可能计费。
            </p>
          </form>
        )}
        {tab === 'excel' && canBatch && (
          <div className="p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-gray-900">上传名单，预览后开始核验</h2>
                <p className="mt-1 text-sm text-gray-500">
                  两列：姓名、身份证号。每批最多 1000 行，文件不超过 10MB。
                </p>
              </div>
              <button
                className="btn btn-secondary inline-flex items-center gap-2"
                disabled={busy}
                onClick={() => perform(() => downloadIdentityFile())}
              >
                <Download className="w-4 h-4" />
                下载模板
              </button>
            </div>
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-5 flex flex-col sm:flex-row sm:items-center gap-4">
              <label className="flex-1 min-w-0 text-sm text-gray-700">
                选择 Excel 文件
                <input
                  aria-label="选择Excel文件"
                  type="file"
                  accept=".xlsx"
                  className="block mt-2 w-full text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-primary"
                  onChange={event => setFile(event.target.files?.[0] || null)}
                />
              </label>
              <button
                className="btn btn-primary inline-flex items-center justify-center gap-2 whitespace-nowrap"
                disabled={busy || !file}
                onClick={preview}
              >
                <Upload className="w-4 h-4" />
                {busy ? '正在处理…' : '上传并预览'}
              </button>
            </div>
            <p className="text-sm text-gray-500">
              上传预览不消耗次数。身份证号请以文本填写；重复组合共用一次结果，格式错误行不会提交。
            </p>
          </div>
        )}
        {tab === 'history' && (
          <div>
            <div className="p-4 flex flex-wrap gap-4 items-end">
              <label className="text-sm text-gray-600">
                开始日期
                <input
                  aria-label="开始日期"
                  type="date"
                  className="input block mt-1"
                  value={from}
                  onChange={event => {
                    setPage(1);
                    setFrom(event.target.value);
                  }}
                />
              </label>
              <label className="text-sm text-gray-600">
                结束日期
                <input
                  aria-label="结束日期"
                  type="date"
                  className="input block mt-1"
                  value={to}
                  onChange={event => {
                    setPage(1);
                    setTo(event.target.value);
                  }}
                />
              </label>
              <p className="text-sm text-gray-500 pb-2">
                {user?.role === 'admin' ? '管理员可查看全部核验记录' : '仅显示本人提交的核验记录'}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-y border-gray-200">
                  <tr>
                    {[
                      '提交时间',
                      '来源 / 批次',
                      '提交账号',
                      '总行数',
                      '预计请求数',
                      '状态',
                      '操作',
                    ].map(label => (
                      <th key={label} className={th}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.batches.map(batch => (
                    <tr key={batch.id} className="border-b border-gray-200 hover:bg-gray-50">
                      <td className={td}>{time(batch.createdAt)}</td>
                      <td className={td}>
                        {batch.source === 'single' ? '单人' : 'Excel'} · {batch.id.slice(0, 8)}
                      </td>
                      <td className={td}>U{String(batch.userId).padStart(4, '0')}</td>
                      <td className={td}>{batch.summary.total}</td>
                      <td className={td}>{batch.summary.valid}</td>
                      <td className={td}>
                        <Badge status={batch.status} />
                      </td>
                      <td className={td}>
                        <button
                          className="text-primary font-medium"
                          onClick={() => openBatch(batch.id)}
                        >
                          查看结果
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!history.batches.length && (
                    <tr>
                      <td colSpan={7} className="p-10 text-center text-gray-500">
                        {loading ? '正在加载…' : '暂无核验记录'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="p-4 flex items-center justify-between text-sm text-gray-500">
              <span>
                共 {history.total} 个批次 · 第 {page} 页
              </span>
              <div className="flex gap-2">
                <button
                  className="btn btn-secondary"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={page * 20 >= history.total || loading}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      {batchId && !detail && loading && (
        <div className="py-12 text-center text-gray-500">正在加载核验明细…</div>
      )}
      {detail && (
        <section
          className="bg-white border border-gray-200 rounded-xl overflow-hidden"
          aria-label="核验结果"
        >
          <div className="p-5 space-y-4">
            <div className="flex flex-wrap justify-between items-center gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-semibold text-gray-900">
                  {detail.batch.status === 'draft' ? '名单预览' : '核验结果'}
                </h2>
                <Badge status={detail.batch.status} />
                <span className="text-sm text-gray-500">{detail.batch.id.slice(0, 8)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {actionable && ['draft', 'paused'].includes(detail.batch.status) && (
                  <button
                    className="btn btn-primary inline-flex items-center gap-2"
                    disabled={busy || !ready || !pending}
                    onClick={() => control('start')}
                  >
                    <Play className="w-4 h-4" />
                    {detail.batch.status === 'paused' ? '继续未开始项目' : '开始核验'}（{pending}{' '}
                    次）
                  </button>
                )}
                {actionable && !['completed', 'cancelled'].includes(detail.batch.status) && (
                  <button
                    className="btn btn-secondary inline-flex items-center gap-2"
                    disabled={busy}
                    onClick={() => control('stop')}
                  >
                    <Square className="w-4 h-4" />
                    停止未开始项目
                  </button>
                )}
                {can(PERMISSIONS.IDENTITY_EXPORT) && (
                  <button
                    className="btn btn-secondary inline-flex items-center gap-2"
                    disabled={busy}
                    onClick={() => perform(() => downloadIdentityFile(batchId))}
                  >
                    <Download className="w-4 h-4" />
                    导出原始结果
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-600">
              <span>共 {detail.batch.summary.total} 行</span>
              <span>有效组合 {detail.batch.summary.valid}</span>
              <span>重复 {detail.batch.summary.duplicates}</span>
              <span>格式错误 {detail.batch.summary.invalid}</span>
              <span>空行 {detail.batch.summary.empty}</span>
              <span>一致 {detail.counts.matched || 0}</span>
              <span>不一致 {detail.counts.mismatched || 0}</span>
            </div>
            {detail.batch.message && (
              <p role="status" className="text-sm text-yellow-800 bg-yellow-50 p-3 rounded-lg">
                {detail.batch.message}
              </p>
            )}
            {detail.batch.status !== 'draft' && (
              <div>
                <div className="flex justify-between text-xs text-gray-500 mb-2">
                  <span>处理进度</span>
                  <span>
                    {resolved} / {detail.rows.length} 行
                  </span>
                </div>
                <progress
                  className="w-full h-2 accent-blue-800"
                  max={detail.rows.length || 1}
                  value={resolved}
                  aria-label="处理进度"
                />
              </div>
            )}
            <label className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
              <span className="whitespace-nowrap">筛选结果</span>
              <select
                className="input w-auto min-w-[140px]"
                aria-label="筛选结果"
                value={resultFilter}
                onChange={event => setResultFilter(event.target.value)}
              >
                <option value="">全部结果</option>
                {[
                  'pending',
                  'processing',
                  'matched',
                  'mismatched',
                  'error',
                  'unknown',
                  'invalid',
                  'cancelled',
                ].map(status => (
                  <option key={status} value={status}>
                    {states[status][0]}
                  </option>
                ))}
              </select>
              <span className="whitespace-nowrap">{rows.length} 行</span>
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-y border-gray-200">
                <tr>
                  {[
                    '原始行',
                    '姓名',
                    '身份证号',
                    '核验结果',
                    '说明',
                    '性别 / 生日',
                    '地区',
                    '核验时间',
                    '流水号',
                  ].map(label => (
                    <th className={th} key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.rowNumber} className="border-b border-gray-200 hover:bg-gray-50">
                    <td className={td}>{row.rowNumber}</td>
                    <td className={td}>{row.name || '—'}</td>
                    <td className={`${td} font-mono`}>{row.idCardNumber || '—'}</td>
                    <td className={td}>
                      <Badge status={row.status} />
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 min-w-[240px] max-w-md">
                      {row.message || '等待核验'}
                      {row.duplicateOf && (
                        <div className="text-xs text-gray-400 mt-1">
                          共用第 {row.duplicateOf} 行结果
                        </div>
                      )}
                    </td>
                    <td className={td}>
                      {row.resultData?.sex || '—'} / {row.resultData?.birthday || '—'}
                    </td>
                    <td className={td}>{row.resultData?.area || '—'}</td>
                    <td className={td}>{time(row.finishedAt)}</td>
                    <td className={`${td} font-mono`}>{row.resultData?.sn || '—'}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={9} className="p-10 text-center text-gray-500">
                      没有符合筛选条件的记录
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
