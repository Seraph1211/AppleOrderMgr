import { useState } from 'react'
import { X, AlertCircle } from 'lucide-react'

export default function EditChannelModal({ channel, onClose, onSave }) {
  const [newTag, setNewTag] = useState(channel.channelName)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    // 验证
    if (!newTag || newTag.trim() === '') {
      setError('渠道名称不能为空')
      return
    }

    if (newTag === channel.channelName) {
      setError('新渠道名称与原名称相同')
      return
    }

    setLoading(true)
    try {
      await onSave(channel.tag, newTag)
    } catch (err) {
      setError(err.response?.data?.message || '修改失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        {/* 标题栏 */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">修改渠道名称</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容 */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* 错误提示 */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {/* 原名称 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              原渠道名称
            </label>
            <input
              type="text"
              value={channel.channelName}
              disabled
              className="input bg-gray-50 text-gray-500 cursor-not-allowed"
            />
          </div>

          {/* 新名称 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              新渠道名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="请输入新的渠道名称"
              className="input"
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              修改后将同步更新所有相关订单和取机人的标签
            </p>
          </div>

          {/* 警告提示 */}
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-yellow-800">
                <p className="font-medium mb-1">注意事项：</p>
                <ul className="list-disc list-inside space-y-1 text-xs">
                  <li>此操作将级联更新所有相关订单和取机人的标签</li>
                  <li>如果新名称已存在，将无法完成修改</li>
                  <li>建议在业务低峰期进行操作</li>
                </ul>
              </div>
            </div>
          </div>

          {/* 按钮 */}
          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary"
              disabled={loading}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
            >
              {loading ? '保存中...' : '确认修改'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
