import { useRef, useState } from 'react';
import ResponsiveSelect from './responsiveSelect';
import { STATUS_OPTIONS } from '../constants/status';
import { buildAppleIdBatchPayload } from '../utils/appleIdBatch';
import client from '../api/client';

/** 明确选择字段并确认后，批量修改 Apple ID 状态和备注。 */
export default function AppleIdBatchEditModal({ ids, onClose, onSaved }) {
  const [changes, setChanges] = useState({
    changeStatus: false,
    changeNotes: false,
    status: '未使用',
    notes: '',
  });
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submittingRef = useRef(false);
  const update = (key, value) => {
    setChanges(previous => ({ ...previous, [key]: value }));
    setConfirming(false);
    setError('');
  };
  const save = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      const response = await client.post(
        '/apple-ids/batch-update',
        buildAppleIdBatchPayload(ids, changes)
      );
      if (!response.success) throw new Error('批量修改失败');
      await onSaved(response.data.updated);
    } catch (failure) {
      setError(failure.message || '批量修改失败，请重试');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  return (
    <div className="!m-0 fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="批量修改 Apple ID"
        className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4"
      >
        <h2 className="text-xl font-semibold">批量修改 Apple ID（{ids.length} 个）</h2>
        <p className="text-sm text-gray-500">仅修改勾选字段，未勾选字段保留原值。</p>
        <fieldset disabled={submitting || confirming} className="space-y-4">
          <div className="space-y-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={changes.changeStatus}
                onChange={event => update('changeStatus', event.target.checked)}
              />
              修改状态
            </label>
            <ResponsiveSelect
              aria-label="批量新状态"
              className="input w-full"
              disabled={!changes.changeStatus}
              value={changes.status}
              onChange={event => update('status', event.target.value)}
            >
              {STATUS_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </ResponsiveSelect>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={changes.changeNotes}
                onChange={event => update('changeNotes', event.target.checked)}
              />
              修改备注
            </label>
            <textarea
              aria-label="批量新备注"
              className="input w-full"
              disabled={!changes.changeNotes}
              value={changes.notes}
              onChange={event => update('notes', event.target.value)}
            />
            <p className="text-sm text-gray-500">勾选修改备注并留空，将清空所选账号备注。</p>
          </div>
        </fieldset>
        {confirming && (
          <div className="bg-primary-50 p-3 rounded-lg text-sm space-y-2">
            <p>确认修改 {ids.length} 个 Apple ID？</p>
            <p>新状态：{changes.changeStatus ? changes.status : '保留原值'}</p>
            <p className="whitespace-pre-wrap break-words">
              备注：
              {changes.changeNotes
                ? changes.notes.trim() === ''
                  ? '清空备注'
                  : changes.notes
                : '保留原值'}
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end flex-wrap gap-3">
          <button className="btn btn-secondary" disabled={submitting} onClick={onClose}>
            取消
          </button>
          {confirming ? (
            <>
              <button
                className="btn btn-secondary"
                disabled={submitting}
                onClick={() => setConfirming(false)}
              >
                返回修改
              </button>
              <button className="btn btn-primary" disabled={submitting} onClick={save}>
                {submitting ? '正在保存…' : '确认保存'}
              </button>
            </>
          ) : (
            <button
              className="btn btn-primary"
              disabled={!changes.changeStatus && !changes.changeNotes}
              onClick={() => setConfirming(true)}
            >
              核对修改
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
