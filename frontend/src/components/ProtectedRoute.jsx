import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * 路由权限守卫，支持单权限和全部权限集合。
 */
export default function ProtectedRoute({
  children,
  requiredRole = null,
  requiredPermission = null,
  requiredPermissions = [],
}) {
  const { user, isAuthenticated, isAdmin, can, hasAllPermissions, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
          <p className="text-gray-500 mt-4">加载中...</p>
        </div>
      </div>
    );
  }
  if (!isAuthenticated()) return <Navigate to="/login" state={{ from: location }} replace />;
  if (user?.forcePasswordChange && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  const forbidden =
    (requiredRole === 'admin' && !isAdmin()) ||
    (requiredPermission && !can(requiredPermission)) ||
    !hasAllPermissions(requiredPermissions);
  if (forbidden) {
    const fallback = user?.availableHome;
    if (fallback && fallback !== location.pathname) return <Navigate to={fallback} replace />;
    return (
      <div className="card max-w-md mx-auto mt-12 text-center">
        <h2 className="text-xl font-bold text-gray-900 mb-3">权限不足</h2>
        <p className="text-gray-600">当前账号没有可用的业务页面，请联系管理员。</p>
      </div>
    );
  }
  return children;
}
