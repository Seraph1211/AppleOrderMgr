import { useState, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Package,
  User,
  Mail,
  Menu,
  X,
  Apple,
  TrendingUp,
  Users,
  LogOut,
  Lock,
  ScrollText
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

const baseNavigation = [
  { name: '仪表板', href: '/', icon: LayoutDashboard },
  { name: '订单管理', href: '/orders', icon: Package },
  { name: 'Apple ID', href: '/apple-ids', icon: Apple },
  { name: '取机人', href: '/recipients', icon: User },
  { name: '渠道管理', href: '/channels', icon: TrendingUp },
  { name: '系统日志', href: '/system-logs', icon: ScrollText },
]

const adminNavigation = [
  { name: '用户管理', href: '/users', icon: Users, adminOnly: true },
]

export default function Layout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout, isAdmin } = useAuth()

  // 根据用户角色生成导航菜单
  const navigation = isAdmin()
    ? [...baseNavigation, ...adminNavigation]
    : baseNavigation

  // 处理登出
  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 移动端侧边栏遮罩 */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 侧边栏 */}
      <aside className={`
        fixed inset-y-0 left-0 z-20 w-64 bg-white border-r border-gray-200
        transform transition-transform duration-200 ease-in-out lg:translate-x-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-between h-16 px-6">
            <div className="flex items-center space-x-2">
              <Apple className="w-8 h-8 text-primary" />
              <span className="text-lg font-semibold text-gray-900">Apple Orders Mgr</span>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden text-gray-400 hover:text-gray-600"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* 导航 */}
          <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
            {navigation.map((item) => {
              const isActive = location.pathname === item.href
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    flex items-center space-x-3 px-4 py-3 rounded-lg transition-all duration-200
                    ${isActive
                      ? 'bg-primary text-white shadow-sm'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                    }
                  `}
                >
                  <item.icon className="w-5 h-5" />
                  <span className="font-medium">{item.name}</span>
                </Link>
              )
            })}
          </nav>

          {/* 底部信息 */}
          <div className="p-4 border-t border-gray-200">
            <div className="text-xs text-gray-500">
              <p>Apple 订单管理系统</p>
              <p className="mt-1">v1.0.0</p>
            </div>
          </div>
        </div>
      </aside>

      {/* 主内容区 */}
      <div className="lg:pl-64">
        {/* 顶部栏 */}
        <header className="sticky top-0 z-10 h-16 bg-white">
          <div className="flex items-center justify-between h-full px-6">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden text-gray-400 hover:text-gray-600"
            >
              <Menu className="w-6 h-6" />
            </button>

            <div className="flex-1" />

            <div className="flex items-center space-x-4">
              {/* 邮件监听状态 */}
              <div className="flex items-center space-x-2 text-sm">
                <Mail className="w-4 h-4 text-primary" />
                <span className="text-gray-600">邮件监听中</span>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                </span>
              </div>

              {/* 分隔线 */}
              <div className="h-6 w-px bg-gray-200"></div>

              {/* 用户信息 */}
              <div className="flex items-center space-x-3">
                <div className="flex items-center space-x-2">
                  <User className="w-4 h-4 text-gray-600" />
                  <span className="text-sm font-medium text-gray-900">{user?.username}</span>
                  {user?.role === 'admin' ? (
                    <span className="badge badge-error">管理员</span>
                  ) : (
                    <span className="badge badge-info">用户</span>
                  )}
                </div>

                {/* 下拉菜单 */}
                <div className="relative" ref={menuRef}>
                  <button
                    onClick={() => setMenuOpen((prev) => !prev)}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <Menu className="w-5 h-5" />
                  </button>

                  {/* 下拉菜单内容 */}
                  {menuOpen && (
                    <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
                      <div className="py-2">
                        <button
                          onClick={() => {
                            setMenuOpen(false)
                            navigate('/change-password')
                          }}
                          className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <Lock className="w-4 h-4" />
                          <span>修改密码</span>
                        </button>
                        <div className="border-t border-gray-200 my-2"></div>
                        <button
                          onClick={() => {
                            setMenuOpen(false)
                            handleLogout()
                          }}
                          className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-error hover:bg-gray-50 transition-colors"
                        >
                          <LogOut className="w-4 h-4" />
                          <span>退出登录</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* 页面内容 */}
        <main className="p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
