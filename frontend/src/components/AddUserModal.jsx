import { useState } from 'react'
import { X, User, Lock } from 'lucide-react'
import client from '../api/client'
import AlertModal from './AlertModal'

export default function AddUserModal({ onClose, onSuccess }) {
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    role: 'user',
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

    // 前端验证
    if (!formData.username.trim()) {
      setAlertModal({
        title: '提示',
        message: '请输入用户名',
      })
      return
    }

    if (formData.username.length < 3) {
      setAlertModal({
        title: '提示',
        message: '用户名长度至少为 3 位',
      })
      return
    }

    if (!formData.password) {
      setAlertModal({
        title: '提示',
        message: '请输入密码',
      })
      return
    }

    if (formData.password.length < 6) {
      setAlertModal({
        title: '提示',
        message: '密码长度至少为 6 位',
      })
      return
    }

    if (formData.password !== formData.confirmPassword) {
      setAlertModal({
        title: '提示',
        message: '密码与确认密码不一致',
      })
      return
    }

    setLoading(true)

    try {
      const response = await client.post('/users', {
        username: formData.username,
        password: formData.password,
        role: formData.role,
      })

      if (response.success) {
        setAlertModal({
          title: '成功',
          message: '用户创建成功',
          onClose: () => {
            setAlertModal(null)
            onSuccess()
          },
        })
      } else {
        setAlertModal({
          title: '创建失败',
          message: response.message || '用户创建失败',
        })
      }
    } catch (error) {
      setAlertModal({
        title: '创建失败',
        message: error.message || '用户创建失败',
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
            <h3 className="text-xl font-bold text-gray-900">新增用户</h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              disabled={loading}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* 用户名 */}
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-2">
                用户名
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <User className="w-5 h-5 text-gray-400" />
                </div>
                <input
                  id="username"
                  name="username"
                  type="text"
                  value={formData.username}
                  onChange={handleChange}
                  className="input pl-10"
                  placeholder="请输入用户名（至少3位）"
                  disabled={loading}
                />
              </div>
            </div>

            {/* 密码 */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                密码
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="w-5 h-5 text-gray-400" />
                </div>
                <input
                  id="password"
                  name="password"
                  type="password"
                  value={formData.password}
                  onChange={handleChange}
                  className="input pl-10"
                  placeholder="请输入密码（至少6位）"
                  disabled={loading}
                />
              </div>
            </div>

            {/* 确认密码 */}
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-2">
                确认密码
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="w-5 h-5 text-gray-400" />
                </div>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  className="input pl-10"
                  placeholder="请再次输入密码"
                  disabled={loading}
                />
              </div>
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
                {loading ? '创建中...' : '确认创建'}
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
