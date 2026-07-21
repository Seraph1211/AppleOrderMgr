import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

/**
 * 路由守卫组件
 * 检查用户是否已登录，支持角色权限检查和强制修改密码
 * @param {Object} props - 组件属性
 * @param {React.ReactNode} props.children - 子组件
 * @param {string} props.requiredRole - 所需角色（'admin' 或 'user'）
 */
export default function ProtectedRoute({ children, requiredRole = null }) {
  const { user, isAuthenticated, isAdmin, loading } = useAuth()
  const location = useLocation()

  // 加载中
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          <p className="text-gray-500 mt-4">加载中...</p>
        </div>
      </div>
    )
  }

  // 未登录：跳转到登录页
  if (!isAuthenticated()) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // 强制修改密码：跳转到修改密码页面（除非当前就在修改密码页面）
  if (user?.forcePasswordChange && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />
  }

  // 需要管理员权限但当前用户不是管理员
  if (requiredRole === 'admin' && !isAdmin()) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center max-w-md mx-4">
          <div className="card">
            <h2 className="text-xl font-bold text-gray-900 mb-4">权限不足</h2>
            <p className="text-gray-600 mb-6">您没有权限访问此页面，请联系管理员。</p>
            <button
              onClick={() => window.history.back()}
              className="btn btn-primary"
            >
              返回
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 通过验证：渲染子组件
  return children
}
