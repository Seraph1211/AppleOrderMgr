import { useState } from 'react'
import { X } from 'lucide-react'
import client from '../api/client'
import AlertModal from './AlertModal'

export default function EditUserModal({ user, onClose, onSuccess }) {
  const [formData, setFormData] = useState({
    role: user.role,
    status: user.status,
  })

  const [loading, setLoading] = useState(false)
  const [alertModal, setAlertModal] = useState(null)

  const handleChange = (e) => {
    const { name, value } = e.target
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()

    setLoading(true)

    try {
      const response = await client.put(`/users/${user.id}`, {
        role: formData.role,
        status: formData.status,
      })

      if (response.success) {
        setAlertModal({
          title: '成功',
          message: '用户信息更新成功',
          onClose: () => {
            setAlertModal(null)
            onSuccess()
          },
        })
      } else {
        setAlertModal({
          title: '更新失败',
          message: response.message || '用户信息更新失败',
        })
      }
    } catch (error) {
      setAlertModal({
        title: '更新失败',
        message: error.message || '用户信息更新失败',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4">
        <div className="p-6">
          <div className="flex items-start justify-between mb-6">
            <h3 className="text-xl font-bold text-gray-900">编辑用户</h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              disabled={loading}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* 用户名（只读） */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                用户名
              </label>
              <input
                type="text"
                value={user.username}
                className="input bg-gray-50"
                disabled
              />
              <p className="text-sm text-gray-500 mt-1">用户名不可修改</p>
            </div>

            {/* 角色 */}
            <div>
              <label htmlFor="role" className="block text-sm font-medium text-gray-700 mb-2">
                角色
              </label>
              <select
                id="role"
                name="role"
                value={formData.role}
                onChange={handleChange}
                className="input"
                disabled={loading}
              >
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
            </div>

            {/* 状态 */}
            <div>
              <label htmlFor="status" className="block text-sm font-medium text-gray-700 mb-2">
                状态
              </label>
              <select
                id="status"
                name="status"
                value={formData.status}
                onChange={handleChange}
                className="input"
                disabled={loading}
              >
                <option value="active">正常</option>
                <option value="locked">锁定</option>
              </select>
            </div>

            {/* 按钮 */}
            <div className="flex justify-end space-x-4 pt-4">
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
                {loading ? '保存中...' : '确认保存'}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* 提示 Modal */}
      {alertModal && (
        <AlertModal
          title={alertModal.title}
          message={alertModal.message}
          onClose={() => {
            if (alertModal.onClose) {
              alertModal.onClose()
            } else {
              setAlertModal(null)
            }
          }}
        />
      )}
    </div>
  )
}
