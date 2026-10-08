import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import client from '../api/client';

/** 订单详情内手动补录、更正序列号，失败保留输入。 */
export default function OrderSerialEditor({ orderId, canEdit, onChange }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const busy = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    client
      .get(`/orders/${orderId}/devices`)
      .then(response => {
        if (current) setDevices(response.data.items);
      })
      .catch(err => {
        if (current) setError(err.message || '序列号加载失败');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [orderId, revision]);

  const save = async () => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      if (draft.removing) {
        await client.delete(`/orders/${orderId}/devices/${draft.id}`, {
          data: { expectedSerialNumber: draft.original, reason: draft.reason },
        });
        if (!active.current) return;
        const next = devices.filter(device => device.id !== draft.id);
        setDevices(next);
        setDraft(null);
        onChange(next.map(device => device.serialNumber));
        return;
      }
      const response = draft.id
        ? await client.put(`/orders/${orderId}/devices/${draft.id}`, {
            serialBarcode: draft.value,
            expectedSerialNumber: draft.original,
            reason: draft.reason,
          })
        : await client.post(`/orders/${orderId}/devices`, { serialBarcode: draft.value });
      if (!active.current) return;
      const saved = response.data.device;
      const next = draft.id
        ? devices.map(device => (device.id === saved.id ? { ...device, ...saved } : device))
        : devices.some(device => device.id === saved.id)
          ? devices
          : [...devices, saved];
      setDevices(next);
      setDraft(null);
      onChange(next.map(device => device.serialNumber));
    } catch (err) {
      if (active.current) setError(err.message || '序列号保存失败');
    } finally {
      busy.current = false;
      if (active.current) setSaving(false);
    }
  };
  return (
    <div className="min-w-0">
      <p className="text-sm text-gray-600">Serial No.</p>
      {loading ? (
        <p className="mt-1 text-sm text-gray-500">加载中...</p>
      ) : (
        <>
          {!devices.length && <p className="mt-1 text-sm text-gray-500">暂无序列号</p>}
          {devices.map(device => (
            <div key={device.id} className="mt-1 flex flex-wrap items-center gap-2">
              <span className="break-all font-mono text-sm">{device.serialNumber}</span>
              {canEdit && !draft && (
                <button
                  type="button"
                  className="btn btn-secondary inline-flex items-center gap-1.5"
                  aria-label={`修改序列号 ${device.serialNumber}`}
                  onClick={() => {
                    setError('');
                    setDraft({
                      id: device.id,
                      original: device.serialNumber,
                      value: device.serialNumber,
                      reason: '',
                    });
                  }}
                >
                  <Pencil className="h-4 w-4" />
                  <span>修改</span>
                </button>
              )}
              {canEdit && !draft && (
                <button
                  type="button"
                  className="btn btn-secondary inline-flex items-center gap-1.5 text-red-600"
                  aria-label={`删除序列号 ${device.serialNumber}`}
                  onClick={() => {
                    setError('');
                    setDraft({
                      id: device.id,
                      original: device.serialNumber,
                      value: device.serialNumber,
                      reason: '',
                      removing: true,
                    });
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  <span>删除</span>
                </button>
              )}
            </div>
          ))}
          {canEdit && !draft && !error && (
            <button
              type="button"
              className="btn btn-secondary inline-flex items-center gap-1.5 mt-2"
              onClick={() => setDraft({ value: '', reason: '' })}
            >
              <Plus className="h-4 w-4" />
              <span>补录序列号</span>
            </button>
          )}
        </>
      )}
      {draft && (
        <div className="mt-2 space-y-2 rounded-lg border border-blue-100 bg-blue-50 p-3">
          <label className="block text-sm">
            序列号
            <input
              aria-label="序列号"
              className="input mt-1 w-full font-mono"
              maxLength={64}
              value={draft.value}
              disabled={saving || draft.removing}
              autoCapitalize="characters"
              autoComplete="off"
              onChange={event => setDraft({ ...draft, value: event.target.value })}
            />
          </label>
          {draft.id && (
            <label className="block text-sm">
              {draft.removing ? '删除原因' : '修改原因'}
              <input
                aria-label={draft.removing ? '删除原因' : '修改原因'}
                className="input mt-1 w-full"
                maxLength={200}
                value={draft.reason}
                disabled={saving}
                onChange={event => setDraft({ ...draft, reason: event.target.value })}
              />
            </label>
          )}
          <p className="text-xs text-gray-500">
            {draft.removing
              ? '确认从本订单删除此序列号？库存设备和历史记录将保留，删除原因会记入操作日志。'
              : '10 或 12 位字母数字。修改会同步库存并保留操作记录；如需删除，请取消后点击序列号旁的“删除”。'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary inline-flex items-center gap-1.5"
              disabled={saving || !draft.value.trim() || (draft.id && !draft.reason.trim())}
              onClick={save}
            >
              <Save className="h-4 w-4" />
              {saving ? '处理中...' : draft.removing ? '确认删除序列号' : '保存序列号'}
            </button>
            <button
              type="button"
              className="btn btn-secondary inline-flex items-center gap-1.5"
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setError('');
              }}
            >
              <X className="h-4 w-4" />
              取消
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="mt-2 text-sm text-red-600" role="alert">
          {error}
          {!draft && (
            <button
              type="button"
              className="btn btn-secondary inline-flex items-center gap-1.5 ml-2"
              onClick={() => setRevision(value => value + 1)}
            >
              重试
            </button>
          )}
        </div>
      )}
    </div>
  );
}
