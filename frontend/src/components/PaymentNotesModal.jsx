import { Save, X } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * 编辑付款任务处理备注的通用弹窗。
 * @param {{task: Object, saving: boolean, error?: string, onClose: Function, onSave: Function}} props - 弹窗配置
 * @returns {JSX.Element} 备注编辑弹窗
 */
export default function PaymentNotesModal({ task, saving, error = '', onClose, onSave }) {
  const [notes, setNotes] = useState(task.processingNotes || '');

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, saving]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-notes-modal-title"
        className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-xl"
        onSubmit={event => {
          event.preventDefault();
          onSave(notes);
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
          <div>
            <h2 id="payment-notes-modal-title" className="text-lg font-semibold text-gray-900">
              修改备注
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              订单 ID：{task.orderId ?? '-'} · {task.orderNumber}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary p-2"
            aria-label="关闭修改备注弹窗"
            disabled={saving}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <label className="block text-sm font-medium text-gray-700" htmlFor="payment-notes-input">
            处理备注
          </label>
          <textarea
            id="payment-notes-input"
            autoFocus
            className="input min-h-32"
            maxLength="2000"
            disabled={saving}
            value={notes}
            onChange={event => setNotes(event.target.value)}
            placeholder="请输入处理备注，留空可清除备注"
          />
          <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
            <span>{notes.length}/2000</span>
            {error && <span className="text-right text-red-600">{error}</span>}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-4">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="btn btn-primary inline-flex items-center gap-2"
            disabled={saving}
          >
            <Save className={`h-4 w-4 ${saving ? 'animate-pulse' : ''}`} />
            {saving ? '保存中...' : '保存备注'}
          </button>
        </div>
      </form>
    </div>
  );
}
