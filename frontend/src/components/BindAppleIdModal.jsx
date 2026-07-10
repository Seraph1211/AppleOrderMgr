import { useState, useEffect } from 'react'
import { X, AlertCircle } from 'lucide-react'
import { getAppleIds } from '../api/appleIdsApi'

export default function BindAppleIdModal({ selectedRecipients, onClose, onConfirm }) {
  const [loading, setLoading] = useState(true)
  const [availableCount, setAvailableCount] = useState(0)
  const [binding, setBinding] = useState(false)

  useEffect(() => {
    // 查询未使用的 Apple ID 数量
    const fetchAvailableCount = async () => {
      try {
        const response = await getAppleIds({ status: '未使用', limit: 1000 })
        // 后端返回的数据结构：response.data.total
        setAvailableCount(response.data?.total || 0)
      } catch (error) {
        console.error('获取可用 Apple ID 数量失败:', error)
        setAvailableCount(0)
      } finally {
        setLoading(false)
      }
    }

    fetchAvailableCount()
  }, [])

  const handleConfirm = async () => {
    setBinding(true)
    try {
      await onConfirm()
      onClose()
    } catch (error) {
      console.error('绑定失败:', error)
    } finally {
      setBinding(false)
    }
  }

  const selectedCount = selectedRecipients.length
  const insufficientStock = availableCount < selectedCount

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">确认绑定 Apple ID</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            disabled={binding}
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-4">
          {loading ? (
            <div className="text-center py-8">
              <div className="inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
              <p className="mt-2 text-sm text-gray-500">正在查询可用 Apple ID...</p>
            </div>
          ) : (
            <>
              <p className="text-gray-700">
                是否要为当前选中的 <span className="font-semibold text-primary">{selectedCount}</span> 个取机人绑定 Apple ID？
              </p>

              <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">选中取机人数量：</span>
                  <span className="font-medium text-gray-900">{selectedCount} 个</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">可用 Apple ID 数量：</span>
                  <span className={`font-medium ${insufficientStock ? 'text-orange-600' : 'text-green-600'}`}>
                    {availableCount} 个
                  </span>
                </div>
              </div>

              {insufficientStock && (
                <div className="flex items-start space-x-2 bg-orange-50 border border-orange-200 rounded-lg p-3">
                  <AlertCircle className="w-5 h-5 text-orange-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm text-orange-800 font-medium">库存不足提示</p>
                    <p className="text-sm text-orange-700 mt-1">
                      当前库存未使用状态的 Apple ID 仅 {availableCount} 个，超过库存数量的取机人将无法绑定。
                    </p>
                  </div>
                </div>
              )}

              <p className="text-xs text-gray-500">
                * 绑定后，Apple ID 的状态将自动更新为"使用中"
              </p>
            </>
          )}
        </div>

        {/* 按钮 */}
        <div className="flex items-center justify-end space-x-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="btn btn-secondary"
            disabled={binding || loading}
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={binding || loading || availableCount === 0}
            className="btn btn-primary"
          >
            {binding ? '绑定中...' : '确认绑定'}
          </button>
        </div>
      </div>
    </div>
  )
}
