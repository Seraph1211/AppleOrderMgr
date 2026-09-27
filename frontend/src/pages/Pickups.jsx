import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Clock3,
  Camera,
  Download,
  ExternalLink,
  Eye,
  FileImage,
  History,
  Pencil,
  Search,
  Upload,
  X,
} from 'lucide-react';
import Pagination from '../components/Pagination';
import TagMultiSelect from '../components/TagMultiSelect';
import PickupDeviceScanner from '../components/PickupDeviceScanner';
import { describePickupEvent, formatPickupHistoryTime } from '../utils/pickupHistory';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import {
  confirmPickupEvidence,
  exportPickupRecords,
  getPickupEvents,
  getPickupEvidenceUrl,
  getPickupRecords,
  getPickupFilterOptions,
  preparePickupEvidence,
  updatePickupRecord,
} from '../api/pickupsApi';

const STATUS_LABELS = {
  pending: '待取货',
  picked_up: '已取货',
  exception: '异常',
};
const STATUS_BADGES = {
  pending: 'badge-warning',
  picked_up: 'badge-success',
  exception: 'badge-error',
};

function productText(products = []) {
  return products
    .map(item => `${item.name || item.model || '-'} ×${item.quantity ?? '-'}`)
    .join('、');
}

function pickupSchedule(item) {
  if (!item.pickupInfo) return item.pickupDate || '-';
  if (item.pickupInfo.appointmentMode === 'business_hours')
    return `${item.pickupDate || ''} 营业时间内`;
  return `${item.pickupDate || ''} ${[item.pickupInfo.startTime, item.pickupInfo.endTime].filter(Boolean).join('–')}`.trim();
}

function localDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function isImageEvidence(evidence) {
  return String(evidence?.contentType || '').startsWith('image/');
}

export default function Pickups() {
  const { can } = useAuth();
  const [searchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    search: searchParams.get('search') || '',
    status: '',
    tags: [],
  });
  const [tagOptions, setTagOptions] = useState([]);
  const [tagError, setTagError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [pageSize, setPageSize] = useState(20);
  const requestSequence = useRef(0);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [editing, setEditing] = useState(null);
  const [scanningOrder, setScanningOrder] = useState(null);
  const [events, setEvents] = useState(null);
  const [evidencePreview, setEvidencePreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState('');

  useEffect(() => {
    if (!editing && !events && !evidencePreview && !scanningOrder) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [editing, events, evidencePreview, scanningOrder]);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setItems([]);
    setError('');
    try {
      const response = await getPickupRecords({
        ...filters,
        page,
        pageSize,
      });
      if (sequence !== requestSequence.current) return;
      const lastPage = Math.max(1, Math.ceil(response.data.total / pageSize));
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setItems(response.data.items);
      setTotal(response.data.total);
    } catch (failure) {
      if (sequence === requestSequence.current) {
        setTotal(0);
        setError(failure.message || '加载取货记录失败');
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [filters, page, pageSize]);

  useEffect(() => {
    load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  useEffect(() => {
    let active = true;
    const loadTags = async () => {
      try {
        const response = await getPickupFilterOptions();
        if (active) setTagOptions(response.data.tags);
      } catch (failure) {
        if (active) setTagError(failure.message || '加载 TAG 筛选项失败，请刷新重试');
      }
    };
    loadTags();
    return () => {
      active = false;
    };
  }, []);

  const exportRecords = async () => {
    setExporting(true);
    setError('');
    try {
      await exportPickupRecords(filters);
    } catch (failure) {
      setError(failure.message || '导出取货清单失败');
    } finally {
      setExporting(false);
    }
  };

  const openEdit = item =>
    setEditing({
      ...item,
      pickedUpAtInput: localDateTime(item.pickedUpAt),
      settlementAmount: item.settlementAmount ?? '',
      settlementPerson: item.settlementPerson || '',
      notes: item.notes || '',
    });

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await updatePickupRecord(editing.orderId, {
        status: editing.status,
        pickedUpAt: editing.pickedUpAtInput
          ? new Date(editing.pickedUpAtInput).toISOString()
          : null,
        settlementAmount: editing.settlementAmount,
        settlementPerson: editing.settlementPerson,
        notes: editing.notes,
        expectedVersion: editing.version,
      });
      setEditing(null);
      await load();
    } catch (failure) {
      setError(failure.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const upload = async (kind, files) => {
    if (!files?.length) return;
    setUploading(kind);
    setError('');
    try {
      for (const file of [...files]) {
        const metadata = {
          kind,
          originalName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        };
        const prepared = await preparePickupEvidence(editing.orderId, metadata);
        const response = await fetch(prepared.data.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        if (!response.ok) throw new Error(`上传 ${file.name} 失败`);
        await confirmPickupEvidence(editing.orderId, {
          ...metadata,
          objectKey: prepared.data.objectKey,
        });
      }
      const refreshed = await getPickupRecords({
        search: String(editing.orderId),
        pageSize: 1,
      });
      openEdit(refreshed.data.items[0]);
      await load();
    } catch (failure) {
      setError(failure.message || '上传凭证失败');
    } finally {
      setUploading('');
    }
  };

  const viewEvidence = async evidence => {
    setEvidencePreview({ evidence, loading: true, url: '', error: '' });
    try {
      const response = await getPickupEvidenceUrl(editing.orderId, evidence.id);
      setEvidencePreview({
        evidence,
        loading: false,
        url: response.data.url,
        error: '',
      });
    } catch (failure) {
      setEvidencePreview({
        evidence,
        loading: false,
        url: '',
        error: failure.message || '加载凭证失败',
      });
    }
  };

  const showEvents = async item => {
    try {
      const response = await getPickupEvents(item.orderId);
      setEvents({ item, rows: response.data });
    } catch (failure) {
      setError(failure.message || '加载更新记录失败');
    }
  };

  return (
    <div className="pickups-page min-w-0 max-w-full space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">取货记录</h1>
          <p className="mt-1 text-sm text-gray-500">按订单TAG查看并登记交接与结款信息</p>
        </div>
        {can(PERMISSIONS.PICKUPS_EXPORT) && (
          <button
            className="btn btn-secondary w-full justify-center sm:w-auto"
            onClick={exportRecords}
            disabled={exporting}
          >
            <Download className="h-4 w-4" />
            <span>{exporting ? '导出中...' : '导出Excel'}</span>
          </button>
        )}
      </div>

      <div className="card flex flex-col gap-3 lg:flex-row">
        <label className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            className="input w-full pl-9"
            value={filters.search}
            onChange={event => {
              setFilters(value => ({ ...value, search: event.target.value }));
              setPage(1);
            }}
            placeholder="搜索系统编号、订单号、取机人"
          />
        </label>
        <div className="min-w-0 lg:w-56">
          <TagMultiSelect
            options={tagOptions}
            value={filters.tags}
            onChange={tags => {
              setFilters(value => ({ ...value, tags }));
              setPage(1);
            }}
            ariaLabel="订单 TAG 筛选"
          />
        </div>
        <select
          className="input lg:w-40"
          value={filters.status}
          onChange={event => {
            setFilters(value => ({ ...value, status: event.target.value }));
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          <option value="pending">待取货</option>
          <option value="picked_up">已取货</option>
          <option value="exception">异常</option>
        </select>
      </div>
      {(error || tagError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error || tagError}
        </div>
      )}

      <div className="hidden overflow-x-auto rounded-lg border border-gray-200 bg-white lg:block">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {[
                '系统编号/订单号',
                '商品',
                '取机人/TAG',
                '取货信息',
                '状态',
                '结款',
                '最后更新',
                '操作',
              ].map(label => (
                <th key={label} className="px-3 py-3 text-left text-xs font-medium text-gray-500">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map(item => (
              <tr key={item.orderId}>
                <td className="px-3 py-3 text-sm">
                  <div>#{item.orderId}</div>
                  <div className="text-gray-500">{item.orderNumber}</div>
                </td>
                <td className="max-w-xs px-3 py-3 text-sm">{productText(item.products)}</td>
                <td className="px-3 py-3 text-sm">
                  <div>{item.recipientName || '-'}</div>
                  <div className="text-gray-500">{item.tag || '-'}</div>
                </td>
                <td className="px-3 py-3 text-sm">
                  <div>{item.pickupStore || '-'}</div>
                  <div className="text-gray-500">{pickupSchedule(item)}</div>
                </td>
                <td className="px-3 py-3">
                  <span className={`badge ${STATUS_BADGES[item.status]}`}>
                    {STATUS_LABELS[item.status]}
                  </span>
                </td>
                <td className="px-3 py-3 text-sm">
                  <div>{item.settlementAmount === null ? '-' : `¥${item.settlementAmount}`}</div>
                  <div className="text-gray-500">{item.settlementPerson || '-'}</div>
                </td>
                <td className="px-3 py-3 text-sm">
                  <div>{item.lastUpdater?.name || '-'}</div>
                  <div className="text-gray-500">
                    {item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN') : '-'}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <div className="flex gap-2">
                    <button className="btn btn-secondary" onClick={() => setScanningOrder(item)}>
                      <Camera className="h-4 w-4" />
                      {can(PERMISSIONS.PICKUPS_EDIT) ? '设备扫码' : '设备'}
                    </button>
                    {can(PERMISSIONS.PICKUPS_EDIT) && (
                      <button className="btn btn-secondary" onClick={() => openEdit(item)}>
                        <Pencil className="h-4 w-4" />
                        登记
                      </button>
                    )}
                    <button className="btn btn-secondary" onClick={() => showEvents(item)}>
                      <History className="h-4 w-4" />
                      记录
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 lg:hidden">
        {items.map(item => (
          <div key={item.orderId} className="card space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-gray-900">
                  #{item.orderId} · {item.orderNumber}
                </div>
                <div className="mt-1 text-sm text-gray-500">
                  {item.tag || '-'} · {item.recipientName || '-'}
                </div>
              </div>
              <span className={`badge ${STATUS_BADGES[item.status]}`}>
                {STATUS_LABELS[item.status]}
              </span>
            </div>
            <div className="text-sm text-gray-700">{productText(item.products)}</div>
            <div className="text-sm text-gray-500">
              {item.pickupStore || '-'} · {pickupSchedule(item)}
            </div>
            <div className="flex gap-2">
              <button
                className="btn btn-secondary min-h-[44px]"
                onClick={() => setScanningOrder(item)}
              >
                <Camera className="h-4 w-4" />
                {can(PERMISSIONS.PICKUPS_EDIT) ? '设备扫码' : '设备'}
              </button>
              {can(PERMISSIONS.PICKUPS_EDIT) && (
                <button className="btn btn-primary flex-1" onClick={() => openEdit(item)}>
                  <Pencil className="h-4 w-4" />
                  登记
                </button>
              )}
              <button
                className="btn btn-secondary"
                aria-label={`查看订单 ${item.orderId} 更新记录`}
                onClick={() => showEvents(item)}
              >
                <History className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
      {scanningOrder && (
        <PickupDeviceScanner
          key={scanningOrder.orderId}
          order={scanningOrder}
          canEdit={can(PERMISSIONS.PICKUPS_EDIT)}
          onClose={() => setScanningOrder(null)}
          onSaved={load}
        />
      )}
      {loading && <div className="py-8 text-center text-gray-500">正在加载...</div>}
      {!loading && !items.length && (
        <div className="card py-10 text-center text-gray-500">暂无符合条件的订单</div>
      )}
      <Pagination
        currentPage={page}
        totalPages={Math.max(1, Math.ceil(total / pageSize))}
        totalItems={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={size => {
          setPageSize(size);
          setPage(1);
        }}
      />

      {editing && (
        <div className="fixed inset-0 z-50 flex min-h-0 items-end justify-center bg-black/50 sm:items-center sm:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pickup-edit-title"
            className="flex h-screen max-h-screen w-full flex-col overflow-hidden bg-white shadow-xl [height:100dvh] [max-height:100dvh] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl sm:rounded-xl"
          >
            <div className="flex shrink-0 items-start justify-between border-b border-gray-100 px-4 py-3 sm:px-5 sm:py-4">
              <div>
                <h2 id="pickup-edit-title" className="text-lg font-semibold">
                  登记取货 #{editing.orderId}
                </h2>
                <p className="text-sm text-gray-500">
                  {editing.orderNumber} · {editing.tag || '-'}
                </p>
              </div>
              <button className="p-2" aria-label="关闭取货登记" onClick={() => setEditing(null)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  取货状态
                  <select
                    className="input mt-1 w-full"
                    value={editing.status}
                    onChange={event =>
                      setEditing(value => ({
                        ...value,
                        status: event.target.value,
                      }))
                    }
                  >
                    <option value="pending">待取货</option>
                    <option value="picked_up">已取货</option>
                    <option value="exception">异常</option>
                  </select>
                </label>
                <label className="min-w-0 text-sm">
                  实际取货时间
                  <input
                    type="datetime-local"
                    className="input mt-1 w-full min-w-0"
                    value={editing.pickedUpAtInput}
                    onChange={event =>
                      setEditing(value => ({
                        ...value,
                        pickedUpAtInput: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="text-sm">
                  结款金额
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    className="input mt-1 w-full"
                    value={editing.settlementAmount}
                    onChange={event =>
                      setEditing(value => ({
                        ...value,
                        settlementAmount: event.target.value,
                      }))
                    }
                    placeholder="非必填"
                  />
                </label>
                <label className="text-sm">
                  结款人
                  <input
                    className="input mt-1 w-full"
                    value={editing.settlementPerson}
                    onChange={event =>
                      setEditing(value => ({
                        ...value,
                        settlementPerson: event.target.value,
                      }))
                    }
                    placeholder="非必填"
                  />
                </label>
                <label className="text-sm sm:col-span-2">
                  备注
                  <textarea
                    className="input mt-1 min-h-24 w-full"
                    value={editing.notes}
                    onChange={event =>
                      setEditing(value => ({
                        ...value,
                        notes: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                {['pickup', 'settlement'].map(kind => (
                  <div key={kind} className="rounded-lg border border-gray-200 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="font-medium">
                        {kind === 'pickup' ? '取货凭证' : '结款凭证'}
                      </span>
                      <label className="btn btn-secondary shrink-0 cursor-pointer">
                        <Upload className="h-4 w-4" />
                        {uploading === kind ? '上传中' : '上传'}
                        <input
                          type="file"
                          multiple
                          accept="image/jpeg,image/png,image/webp,application/pdf"
                          className="hidden"
                          disabled={Boolean(uploading)}
                          onChange={event => upload(kind, event.target.files)}
                        />
                      </label>
                    </div>
                    <div className="space-y-2">
                      {editing.evidence
                        .filter(file => file.kind === kind)
                        .map(file => (
                          <button
                            type="button"
                            key={file.id}
                            className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2 text-left text-sm hover:border-primary/40 hover:bg-primary-50"
                            onClick={() => viewEvidence(file)}
                          >
                            <FileImage className="h-5 w-5 shrink-0 text-primary" />
                            <span className="min-w-0 flex-1 truncate">{file.originalName}</span>
                            <Eye className="h-4 w-4 shrink-0 text-gray-500" />
                            <span className="sr-only">查看</span>
                          </button>
                        ))}
                      {!editing.evidence.some(file => file.kind === kind) && (
                        <p className="text-sm text-gray-400">未上传（非必填）</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="pickup-dialog-footer flex shrink-0 gap-3 border-t border-gray-100 bg-white px-4 py-3 sm:justify-end sm:px-5">
              <button
                className="btn btn-secondary flex-1 justify-center sm:flex-none"
                onClick={() => setEditing(null)}
              >
                取消
              </button>
              <button
                className="btn btn-primary flex-1 justify-center sm:flex-none"
                disabled={saving || uploading}
                onClick={save}
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {events && (
        <div className="fixed inset-0 z-50 flex min-h-0 items-end justify-center bg-black/50 sm:items-center sm:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="更新记录"
            className="flex h-screen max-h-screen w-full flex-col overflow-hidden bg-white [height:100dvh] [max-height:100dvh] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl sm:rounded-xl"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3 sm:px-5">
              <h2 className="text-lg font-semibold">更新记录 #{events.item.orderId}</h2>
              <button className="p-2" aria-label="关闭更新记录" onClick={() => setEvents(null)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4 sm:p-5">
              {events.rows.map(row => (
                <div key={row.id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{row.actorName}</span>
                    <span className="text-gray-500">
                      <Clock3 className="mr-1 inline h-4 w-4" />
                      {formatPickupHistoryTime(row.createdAt)}（北京）
                    </span>
                  </div>
                  <ul className="mt-2 space-y-2 text-sm text-gray-600">
                    {describePickupEvent(row).map((line, index) => (
                      <li key={index} className="whitespace-pre-wrap break-words">
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {!events.rows.length && (
                <p className="py-6 text-center text-gray-500">暂无更新记录</p>
              )}
            </div>
          </div>
        </div>
      )}

      {evidencePreview && (
        <div className="fixed inset-0 z-[60] flex min-h-0 items-center justify-center bg-black/80 p-0 sm:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pickup-evidence-title"
            className="flex h-screen max-h-screen w-full flex-col overflow-hidden bg-white [height:100dvh] [max-height:100dvh] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-4xl sm:rounded-xl"
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
              <div className="min-w-0">
                <h2 id="pickup-evidence-title" className="font-semibold">
                  {evidencePreview.evidence.kind === 'pickup' ? '取货凭证' : '结款凭证'}
                </h2>
                <p className="truncate text-sm text-gray-500">
                  {evidencePreview.evidence.originalName}
                </p>
              </div>
              <button
                type="button"
                className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
                aria-label="关闭凭证预览"
                onClick={() => setEvidencePreview(null)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-gray-100 p-3 sm:p-5">
              {evidencePreview.loading && <p className="text-gray-500">正在加载凭证...</p>}
              {evidencePreview.error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
                  {evidencePreview.error}
                </div>
              )}
              {evidencePreview.url && isImageEvidence(evidencePreview.evidence) && (
                <img
                  src={evidencePreview.url}
                  alt={evidencePreview.evidence.originalName}
                  className="max-h-full max-w-full object-contain"
                  onError={() =>
                    setEvidencePreview(current =>
                      current?.evidence.id === evidencePreview.evidence.id
                        ? {
                            ...current,
                            url: '',
                            error: '凭证图片加载失败，请关闭后重试',
                          }
                        : current
                    )
                  }
                />
              )}
              {evidencePreview.url && !isImageEvidence(evidencePreview.evidence) && (
                <iframe
                  title={evidencePreview.evidence.originalName}
                  src={evidencePreview.url}
                  className="h-full min-h-[60vh] w-full rounded bg-white"
                />
              )}
            </div>
            {evidencePreview.url && (
              <div className="pickup-dialog-footer flex shrink-0 justify-end border-t border-gray-200 bg-white px-4 py-3">
                <a
                  className="btn btn-secondary w-full justify-center sm:w-auto"
                  href={evidencePreview.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="h-4 w-4" />
                  在新窗口打开
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
