import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Clock3, Download, FileImage, History, Pencil, Search, Upload, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import {
  confirmPickupEvidence,
  exportPickupRecords,
  getPickupEvents,
  getPickupEvidenceUrl,
  getPickupRecords,
  preparePickupEvidence,
  updatePickupRecord,
} from '../api/pickupsApi';

const STATUS_LABELS = { pending: '待取货', picked_up: '已取货', exception: '异常' };
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

export default function Pickups() {
  const { can } = useAuth();
  const [searchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    search: searchParams.get('search') || '',
    status: '',
    tag: '',
  });
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [editing, setEditing] = useState(null);
  const [events, setEvents] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getPickupRecords({ ...filters, page, pageSize: 20 });
      setItems(response.data.items);
      setTotal(response.data.total);
    } catch (failure) {
      setError(failure.message || '加载取货记录失败');
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    load();
  }, [load]);

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
      const refreshed = await getPickupRecords({ search: String(editing.orderId), pageSize: 1 });
      openEdit(refreshed.data.items[0]);
      await load();
    } catch (failure) {
      setError(failure.message || '上传凭证失败');
    } finally {
      setUploading('');
    }
  };

  const viewEvidence = async evidence => {
    try {
      const response = await getPickupEvidenceUrl(editing.orderId, evidence.id);
      window.open(response.data.url, '_blank', 'noopener,noreferrer');
    } catch (failure) {
      setError(failure.message || '打开凭证失败');
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
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">取货记录</h1>
          <p className="mt-1 text-sm text-gray-500">按订单TAG查看并登记交接与结款信息</p>
        </div>
        {can(PERMISSIONS.PICKUPS_EXPORT) && (
          <button className="btn btn-secondary" onClick={() => exportPickupRecords(filters)}>
            <Download className="h-4 w-4" />
            导出Excel
          </button>
        )}
      </div>

      <div className="card flex flex-col gap-3 lg:flex-row">
        <label className="relative flex-1">
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
        <input
          className="input lg:w-56"
          value={filters.tag}
          onChange={event => {
            setFilters(value => ({ ...value, tag: event.target.value }));
            setPage(1);
          }}
          placeholder="订单TAG（精确）"
        />
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
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
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
            <div className="flex items-start justify-between">
              <div>
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
      {loading && <div className="py-8 text-center text-gray-500">正在加载...</div>}
      {!loading && !items.length && (
        <div className="card py-10 text-center text-gray-500">暂无符合条件的订单</div>
      )}
      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>共 {total} 条</span>
        <div className="flex gap-2">
          <button
            className="btn btn-secondary"
            disabled={page <= 1}
            onClick={() => setPage(value => value - 1)}
          >
            上一页
          </button>
          <button
            className="btn btn-secondary"
            disabled={page * 20 >= total}
            onClick={() => setPage(value => value + 1)}
          >
            下一页
          </button>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4">
          <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-xl bg-white p-5 sm:max-w-2xl sm:rounded-xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">登记取货 #{editing.orderId}</h2>
                <p className="text-sm text-gray-500">
                  {editing.orderNumber} · {editing.tag || '-'}
                </p>
              </div>
              <button className="p-2" aria-label="关闭取货登记" onClick={() => setEditing(null)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-sm">
                取货状态
                <select
                  className="input mt-1 w-full"
                  value={editing.status}
                  onChange={event =>
                    setEditing(value => ({ ...value, status: event.target.value }))
                  }
                >
                  <option value="pending">待取货</option>
                  <option value="picked_up">已取货</option>
                  <option value="exception">异常</option>
                </select>
              </label>
              <label className="text-sm">
                实际取货时间
                <input
                  type="datetime-local"
                  className="input mt-1 w-full"
                  value={editing.pickedUpAtInput}
                  onChange={event =>
                    setEditing(value => ({ ...value, pickedUpAtInput: event.target.value }))
                  }
                />
              </label>
              <label className="text-sm">
                结款金额
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="input mt-1 w-full"
                  value={editing.settlementAmount}
                  onChange={event =>
                    setEditing(value => ({ ...value, settlementAmount: event.target.value }))
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
                    setEditing(value => ({ ...value, settlementPerson: event.target.value }))
                  }
                  placeholder="非必填"
                />
              </label>
              <label className="text-sm sm:col-span-2">
                备注
                <textarea
                  className="input mt-1 min-h-24 w-full"
                  value={editing.notes}
                  onChange={event => setEditing(value => ({ ...value, notes: event.target.value }))}
                />
              </label>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {['pickup', 'settlement'].map(kind => (
                <div key={kind} className="rounded-lg border border-gray-200 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-medium">
                      {kind === 'pickup' ? '取货凭证' : '结款凭证'}
                    </span>
                    <label className="btn btn-secondary cursor-pointer">
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
                          key={file.id}
                          className="flex w-full items-center gap-2 rounded bg-gray-50 p-2 text-left text-sm"
                          onClick={() => viewEvidence(file)}
                        >
                          <FileImage className="h-4 w-4 text-primary" />
                          <span className="truncate">{file.originalName}</span>
                        </button>
                      ))}
                    {!editing.evidence.some(file => file.kind === kind) && (
                      <p className="text-sm text-gray-400">未上传（非必填）</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn btn-secondary" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="btn btn-primary" disabled={saving || uploading} onClick={save}>
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {events && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">更新记录 #{events.item.orderId}</h2>
              <button className="p-2" aria-label="关闭更新记录" onClick={() => setEvents(null)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {events.rows.map(row => (
                <div key={row.id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{row.actorName}</span>
                    <span className="text-gray-500">
                      <Clock3 className="mr-1 inline h-4 w-4" />
                      {new Date(row.createdAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  <pre className="mt-2 whitespace-pre-wrap text-xs text-gray-600">
                    {JSON.stringify(row.changes, null, 2)}
                  </pre>
                </div>
              ))}
              {!events.rows.length && (
                <p className="py-6 text-center text-gray-500">暂无更新记录</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
