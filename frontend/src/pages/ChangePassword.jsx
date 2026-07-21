import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, ArrowLeft } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import client from '../api/client'
import AlertModal from '../components/AlertModal'

export default function ChangePassword() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()

  const [formData, setFormData] = useState({
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
  })

  const [loading, setLoading] = useState(false)
  const [alertModal, setAlertModal] = useState(null)

  // 判断是否是强制修改密码
  const isForceChange = user?.forcePasswordChange === true

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
    if (!formData.oldPassword) {
      setAlertModal({
        title: '提示',
        message: '请输入旧密码',
      })
      return
    }

    if (!formData.newPassword) {
      setAlertModal({
        title: '提示',
        message: '请输入新密码',
      })
      return
    }

    if (formData.newPassword.length < 6) {
      setAlertModal({
        title: '提示',
        message: '新密码长度至少为 6 位',
      })
      return
    }

    if (formData.newPassword !== formData.confirmPassword) {
      setAlertModal({
        title: '提示',
        message: '新密码与确认密码不一致',
      })
      return
    }

    if (formData.oldPassword === formData.newPassword) {
      setAlertModal({
        title: '提示',
        message: '新密码不能与旧密码相同',
      })
      return
    }

    setLoading(true)

    try {
      const response = await client.post('/auth/change-password', {
        oldPassword: formData.oldPassword,
        newPassword: formData.newPassword,
        confirmPassword: formData.confirmPassword,
      })

      if (response.success) {
        setAlertModal({
          title: '成功',
          message: '密码修改成功',
          onClose: () => {
            // 如果是强制修改密码，需要更新用户信息
            if (isForceChange) {
              // 清除 forcePasswordChange 标志（后端已更新，前端也需同步）
              const storage = user.storageType === 'localStorage' ? localStorage : sessionStorage
              const storedUser = JSON.parse(storage.getItem('user'))
              storedUser.forcePasswordChange = false
              storage.setItem('user', JSON.stringify(storedUser))
            }
            // 返回首页
            navigate('/')
          },
        })
      } else {
        setAlertModal({
          title: '修改失败',
          message: response.message || '密码修改失败，请重试',
        })
      }
    } catch (error) {
      let errorMessage = '密码修改失败，请重试'

      if (error.message) {
        errorMessage = error.message
      } else if (typeof error === 'string') {
        errorMessage = error
      }

      setAlertModal({
        title: '修改失败',
        message: errorMessage,
      })
    } finally {
      setLoading(false)
    }
  }

  const handleBack = () => {
    // 如果是强制修改密码，不允许返回，只能登出
    if (isForceChange) {
      logout()
      navigate('/login')
    } else {
      navigate(-1)
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* 页面标题 */}
      <div className="flex items-center mb-6">
        {!isForceChange && (
          <button
            onClick={handleBack}
            className="mr-4 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <h1 className="text-2xl font-bold text-gray-900">修改密码</h1>
      </div>

      {/* 强制修改密码提示 */}
      {isForceChange && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 mb-6">
          <p className="text-sm text-yellow-800">
            首次登录需要修改密码，修改后才能继续使用系统。
          </p>
        </div>
      )}

      {/* 修改密码表单 */}
      <div className="card">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* 旧密码 */}
          <div>
            <label htmlFor="oldPassword" className="block text-sm font-medium text-gray-700 mb-2">
              旧密码
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="w-5 h-5 text-gray-400" />
              </div>
              <input
                id="oldPassword"
                name="oldPassword"
                type="password"
                autoComplete="current-password"
                value={formData.oldPassword}
                onChange={handleChange}
                className="input pl-10"
                placeholder="请输入旧密码"
                disabled={loading}
              />
            </div>
          </div>

          {/* 新密码 */}
          <div>
            <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-2">
              新密码
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="w-5 h-5 text-gray-400" />
              </div>
              <input
                id="newPassword"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                value={formData.newPassword}
                onChange={handleChange}
                className="input pl-10"
                placeholder="请输入新密码（至少6位）"
                disabled={loading}
              />
            </div>
            <p className="text-sm text-gray-500 mt-1">密码长度至少为 6 位</p>
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
                autoComplete="new-password"
                value={formData.confirmPassword}
                onChange={handleChange}
                className="input pl-10"
                placeholder="请再次输入新密码"
                disabled={loading}
              />
            </div>
          </div>

          {/* 按钮 */}
          <div className="flex justify-end space-x-4">
            <button
              type="button"
              onClick={handleBack}
              className="btn btn-secondary"
              disabled={loading}
            >
              {isForceChange ? '登出' : '取消'}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
            >
              {loading ? '提交中...' : '确认修改'}
            </button>
          </div>
        </form>
      </div>

      {/* 提示 Modal */}
      {alertModal && (
        <AlertModal
          title={alertModal.title}
          message={alertModal.message}
          onClose={() => {
            if (alertModal.onClose) {
              alertModal.onClose()
            }
            setAlertModal(null)
          }}
        />
      )}
    </div>
  )
}
