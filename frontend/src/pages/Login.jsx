import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Apple, Lock, User } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import client from '../api/client'
import AlertModal from '../components/AlertModal'

export default function Login() {
  const navigate = useNavigate()
  const { login } = useAuth()

  const [formData, setFormData] = useState({
    username: '',
    password: '',
    rememberMe: false,
  })

  const [loading, setLoading] = useState(false)
  const [alertModal, setAlertModal] = useState(null)
  const [lockInfo, setLockInfo] = useState(null)

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
    // 清除错误信息
    setAlertModal(null)
    setLockInfo(null)
  }

  /**
   * 计算锁定剩余时间
   * @param {string} lockedUntil - 锁定截止时间
   * @returns {string|null} 剩余时间字符串
   */
  const calculateLockTime = (lockedUntil) => {
    const now = new Date()
    const lockEnd = new Date(lockedUntil)
    const diffMs = lockEnd - now

    if (diffMs <= 0) {
      return null
    }

    const minutes = Math.floor(diffMs / 60000)
    const seconds = Math.floor((diffMs % 60000) / 1000)

    return `${minutes} 分 ${seconds} 秒`
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

    if (!formData.password) {
      setAlertModal({
        title: '提示',
        message: '请输入密码',
      })
      return
    }

    setLoading(true)
    setAlertModal(null)
    setLockInfo(null)

    try {
      const response = await client.post('/auth/login', {
        username: formData.username,
        password: formData.password,
      })

      // 登录成功
      if (response.success && response.data) {
        const { token, user } = response.data

        // 调用 AuthContext 的 login 方法
        login({
          token,
          username: user.username,
          role: user.role,
          forcePasswordChange: user.forcePasswordChange
        }, formData.rememberMe)

        // 检查是否需要强制修改密码
        if (user.forcePasswordChange) {
          navigate('/change-password')
        } else {
          navigate('/')
        }
      } else {
        setAlertModal({
          title: '登录失败',
          message: response.message || '登录失败，请重试',
        })
      }
    } catch (error) {
      // 处理登录失败
      let errorMessage = '登录失败，请重试'
      let lockUntil = null

      if (error.response) {
        const { status, data } = error.response

        if (status === 401) {
          errorMessage = data.message || '用户名或密码错误'
        } else if (status === 403) {
          errorMessage = data.message || '账号已被锁定'
          lockUntil = data.lockedUntil
        } else {
          errorMessage = data.message || '登录失败，请稍后重试'
        }
      } else if (error.message) {
        errorMessage = error.message
      } else if (typeof error === 'string') {
        errorMessage = error
      }

      setAlertModal({
        title: '登录失败',
        message: errorMessage,
      })

      // 设置锁定信息
      if (lockUntil) {
        const lockTime = calculateLockTime(lockUntil)
        if (lockTime) {
          setLockInfo(`账号已被锁定，剩余时间: ${lockTime}`)
        }
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full">
        {/* Logo 和标题 */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center space-x-2 mb-4">
            <Apple className="w-12 h-12 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">Apple Orders Mgr</h1>
          <p className="text-gray-600 mt-2">Apple 订单管理系统</p>
        </div>

        {/* 登录表单 */}
        <div className="card">
          <h2 className="text-xl font-semibold text-gray-900 mb-6">登录</h2>

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
                  autoComplete="username"
                  value={formData.username}
                  onChange={handleChange}
                  className="input pl-10"
                  placeholder="请输入用户名"
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
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={handleChange}
                  className="input pl-10"
                  placeholder="请输入密码"
                  disabled={loading}
                />
              </div>
            </div>

            {/* 记住我 */}
            <div className="flex items-center">
              <input
                id="rememberMe"
                name="rememberMe"
                type="checkbox"
                checked={formData.rememberMe}
                onChange={handleChange}
                className="h-4 w-4 text-primary focus:ring-primary border-gray-300 rounded"
                disabled={loading}
              />
              <label htmlFor="rememberMe" className="ml-2 block text-sm text-gray-700">
                记住我（7天内免登录）
              </label>
            </div>

            {/* 登录按钮 */}
            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={loading}
            >
              {loading ? '登录中...' : '登录'}
            </button>
          </form>
        </div>

        {/* 底部信息 */}
        <p className="text-center text-sm text-gray-500 mt-8">
          Apple 订单管理系统 v1.0.0
        </p>
      </div>

      {/* 错误提示 Modal */}
      {alertModal && (
        <AlertModal
          title={alertModal.title}
          message={alertModal.message}
          onClose={() => setAlertModal(null)}
        />
      )}

      {/* 锁定信息提示 */}
      {lockInfo && (
        <div className="fixed bottom-8 left-1/2 transform -translate-x-1/2 bg-red-50 border border-red-200 rounded-lg px-6 py-3 shadow-lg">
          <p className="text-sm text-red-600">{lockInfo}</p>
        </div>
      )}
    </div>
  )
}
