import { useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, RotateCcw } from 'lucide-react';
import OrderOverlay from './orderOverlay';

/** 本地列偏好编辑；支持拖动与键盘/触屏按钮排序，固定列保持原位。 */
export default function OrderColumnConfigModal({ columns, onSave, onReset, onClose }) {
  const [tempColumns, setTempColumns] = useState(columns);
  const [draggedIndex, setDraggedIndex] = useState(null);
  const toggleColumn = key =>
    setTempColumns(previous =>
      previous.map(column =>
        column.key === key && !column.pinned ? { ...column, visible: !column.visible } : column
      )
    );
  const moveColumn = (from, to) => {
    if (
      from === null ||
      from === to ||
      to < 0 ||
      to >= tempColumns.length ||
      tempColumns[from].pinned ||
      tempColumns[to].pinned
    )
      return;
    setTempColumns(previous => {
      const next = [...previous];
      const [column] = next.splice(from, 1);
      next.splice(to, 0, column);
      return next;
    });
  };
  return (
    <OrderOverlay
      title="列设置"
      subtitle="调整订单列表的显示字段与顺序"
      onClose={onClose}
      className="order-column-dialog"
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary mr-auto inline-flex items-center gap-2"
            onClick={() => {
              onReset();
              onClose();
            }}
          >
            <RotateCcw className="h-4 w-4" />
            恢复默认
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onSave(tempColumns);
              onClose();
            }}
          >
            保存
          </button>
        </>
      }
    >
      <div className="order-detail-section-heading">
        <h3>列表字段</h3>
        <span className="order-inline-note">
          已显示 {tempColumns.filter(column => column.visible).length} / {tempColumns.length} 列
        </span>
      </div>
      <div>
        {tempColumns.map((column, index) => (
          <div
            key={column.key}
            className={`order-column-row ${draggedIndex === index ? 'bg-blue-50' : ''}`}
            draggable={!column.pinned}
            onDragStart={event => {
              if (column.pinned) return event.preventDefault();
              setDraggedIndex(index);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={event => {
              event.preventDefault();
              if (!column.pinned && draggedIndex !== null) {
                moveColumn(draggedIndex, index);
                setDraggedIndex(index);
              }
            }}
            onDragEnd={() => setDraggedIndex(null)}
          >
            <GripVertical
              className={`h-4 w-4 shrink-0 ${column.pinned ? 'invisible' : 'text-gray-400'}`}
              aria-hidden="true"
            />
            <label>
              <input
                type="checkbox"
                checked={column.visible}
                disabled={column.pinned}
                onChange={() => toggleColumn(column.key)}
              />
              <span>{column.label}</span>
            </label>
            {column.sensitive && <span className="badge badge-warning">敏感</span>}
            {column.pinned ? (
              <span className="order-inline-note">固定</span>
            ) : (
              <div className="flex gap-1">
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label={`上移${column.label}`}
                  disabled={index === 0 || tempColumns[index - 1]?.pinned}
                  onClick={() => moveColumn(index, index - 1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label={`下移${column.label}`}
                  disabled={index === tempColumns.length - 1 || tempColumns[index + 1]?.pinned}
                  onClick={() => moveColumn(index, index + 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="order-panel-note mt-4">
        拖动手柄或使用上下箭头调整顺序。配置仅保存在当前浏览器；隐藏列不会改变数据访问权限。
      </p>
    </OrderOverlay>
  );
}
