import { useState } from 'react'
import { X, AlertCircle, GripVertical } from 'lucide-react'

export default function ColumnConfigModal({ columns, onSave, onReset, onClose }) {
  const [tempColumns, setTempColumns] = useState(columns)
  const [draggedIndex, setDraggedIndex] = useState(null)

  const toggleColumn = (key) => {
    setTempColumns((prev) =>
      prev.map((col) =>
        col.key === key && !col.pinned ? { ...col, visible: !col.visible } : col
      )
    )
  }

  const handleDragStart = (e, index) => {
    if (tempColumns[index].pinned) {
      e.preventDefault()
      return
    }
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e, index) => {
    e.preventDefault()
    if (tempColumns[index].pinned || draggedIndex === null || draggedIndex === index) {
      return
    }

    const newColumns = [...tempColumns]
    const draggedItem = newColumns[draggedIndex]

    // 移除拖拽项
    newColumns.splice(draggedIndex, 1)
    // 插入到新位置
    newColumns.splice(index, 0, draggedItem)

    setTempColumns(newColumns)
    setDraggedIndex(index)
  }

  const handleDragEnd = () => {
    setDraggedIndex(null)
  }

  const handleSave = () => {
    onSave(tempColumns)
    onClose()
  }

  const handleReset = () => {
    onReset()
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">列设置</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 max-h-96 overflow-y-auto">
          <div className="space-y-2">
            {tempColumns.map((col, index) => (
              <div
                key={col.key}
                draggable={!col.pinned}
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragEnd={handleDragEnd}
                className={`flex items-center space-x-3 p-3 rounded-lg border transition-all ${
                  col.pinned
                    ? 'opacity-60 cursor-not-allowed bg-gray-50 border-gray-200'
                    : draggedIndex === index
                    ? 'opacity-50 border-primary bg-primary-50'
                    : 'cursor-move hover:bg-gray-50 border-gray-200 hover:border-primary'
                }`}
              >
                {/* 拖拽手柄 */}
                {!col.pinned && (
                  <GripVertical className="w-5 h-5 text-gray-400 flex-shrink-0" />
                )}
                {col.pinned && (
                  <div className="w-5 h-5 flex-shrink-0"></div>
                )}

                {/* 复选框 */}
                <input
                  type="checkbox"
                  checked={col.visible}
                  onChange={() => toggleColumn(col.key)}
                  disabled={col.pinned}
                  className="w-4 h-4 text-primary border-gray-300 rounded focus:ring-primary"
                />

                {/* 标签 */}
                <span className="flex-1 text-sm text-gray-700">{col.label}</span>

                {/* 徽章 */}
                <div className="flex items-center space-x-2">
                  {col.pinned && (
                    <span className="badge badge-info text-xs">固定</span>
                  )}
                  {col.sensitive && (
                    <span className="badge badge-warning text-xs">敏感</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Info message */}
          <div className="mt-4 p-3 bg-blue-50 rounded-lg flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-blue-800">
              配置将保存到浏览器本地存储，刷新页面后仍然生效。拖动列可调整显示顺序。
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-gray-200">
          <button onClick={handleReset} className="btn btn-secondary">
            恢复默认
          </button>
          <button onClick={handleSave} className="btn btn-primary">
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
