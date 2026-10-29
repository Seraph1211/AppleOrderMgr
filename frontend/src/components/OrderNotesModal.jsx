import OrderOverlay from './orderOverlay';
import { Save } from 'lucide-react';
import { useState } from 'react';

/**
 * 编辑订单备注的通用弹窗。
 * @param {{order: Object, saving: boolean, error?: string, onClose: Function, onSave: Function}} props - 弹窗配置
 * @returns {JSX.Element} 备注编辑弹窗
 */
export default function OrderNotesModal({ order, saving, error = '', onClose, onSave }) {
  const [notes, setNotes] = useState(order.notes || '');

  return (
    <OrderOverlay
      title="修改备注"
      size="small"
      onClose={onClose}
      busy={saving}
      subtitle={`订单 ID ${order.id ?? '-'} · ${order.orderNumber}`}
      closeLabel="关闭修改备注弹窗"
      footer={
        <>
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(notes)}
            className="btn btn-primary inline-flex items-center gap-2"
            disabled={saving}
          >
            <Save className={`h-4 w-4 ${saving ? 'animate-pulse' : ''}`} />
            {saving ? '保存中...' : '保存备注'}
          </button>
        </>
      }
    >
      <form
        onSubmit={event => {
          event.preventDefault();
          onSave(notes);
        }}
      >
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-700" htmlFor="order-notes-input">
            订单备注
          </label>
          <textarea
            id="order-notes-input"
            data-order-autofocus
            autoFocus
            className="input min-h-32 text-base"
            maxLength="2000"
            disabled={saving}
            value={notes}
            onChange={event => setNotes(event.target.value)}
            placeholder="请输入订单备注，留空可清除备注"
          />
          <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
            <span>{notes.length}/2000</span>
            {error && (
              <span role="alert" className="text-right text-red-600">
                {error}
              </span>
            )}
          </div>
        </div>
      </form>
    </OrderOverlay>
  );
}
