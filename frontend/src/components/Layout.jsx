import { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
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
  Settings,
  ScrollText,
  CreditCard,
  ListChecks,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getEmailProcessingMetrics } from '../api';
import AlertModal from './AlertModal';
import { PERMISSIONS } from '../constants/permissions';

const baseNavigation = [
  { name: '仪表板', href: '/', icon: LayoutDashboard, permission: PERMISSIONS.DASHBOARD_READ },
  { name: '订单管理', href: '/orders', icon: Package, permission: PERMISSIONS.ORDERS_READ },
  { name: 'Apple ID', href: '/apple-ids', icon: Apple, permission: PERMISSIONS.APPLE_IDS_READ },
  { name: '取机人', href: '/recipients', icon: User, permission: PERMISSIONS.RECIPIENTS_READ },
  {
    name: '身份核验',
    href: '/identity-verifications',
    icon: ShieldCheck,
    permission: PERMISSIONS.IDENTITY_READ,
  },
  { name: '渠道管理', href: '/channels', icon: TrendingUp, permission: PERMISSIONS.CHANNELS_READ },
];

const adminNavigation = [
  {
    name: '付款调度',
    href: '/payment-dispatch',
    icon: ListChecks,
    permission: PERMISSIONS.PAYMENT_DISPATCH_READ,
  },
  {
    name: '付款任务',
    href: '/payment-tasks',
    icon: CreditCard,
    permission: PERMISSIONS.PAYMENT_TASKS_READ_OWN,
  },
  { name: '邮件处理', href: '/email-processing', icon: Mail, permission: PERMISSIONS.EMAIL_READ },
  {
    name: '系统日志',
    href: '/system-logs',
    icon: ScrollText,
    permission: PERMISSIONS.SYSTEM_LOGS_READ,
  },
  {
    name: '操作记录',
    href: '/operation-logs',
    icon: ScrollText,
    permission: PERMISSIONS.SYSTEM_LOGS_READ,
  },
  { name: '用户管理', href: '/users', icon: Users, permission: PERMISSIONS.USERS_READ },
];

export default function Layout({ children }) {
  const [logoutError, setLogoutError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emailWorker, setEmailWorker] = useState(null);
  const menuRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, can } = useAuth();

  // 根据用户角色生成导航菜单
  const navigation = [...baseNavigation, ...adminNavigation]
    .filter(item => can(item.permission))
    .concat({ name: '个人设置', href: '/profile', icon: Settings });

  // 处理登出
  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login');
    } catch (_error) {
      setLogoutError('退出失败，请检查网络后重试');
    }
  };

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = event => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!can(PERMISSIONS.EMAIL_READ)) {
      setEmailWorker(null);
      return undefined;
    }
    let active = true;
    const loadStatus = async () => {
      try {
        const response = await getEmailProcessingMetrics();
        if (active) setEmailWorker(response.data.worker || null);
      } catch (_error) {
        if (active) setEmailWorker(null);
      }
    };
    loadStatus();
    const timer = setInterval(loadStatus, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [can]);

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
      <aside
        className={`
        fixed inset-y-0 left-0 z-20 w-64 bg-white border-r border-gray-200
        transform transition-transform duration-200 ease-in-out lg:translate-x-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}
      >
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
            {navigation.map(item => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    flex items-center space-x-3 px-4 py-3 rounded-lg transition-all duration-200
                    ${
                      isActive
                        ? 'bg-primary text-white shadow-sm'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                    }
                  `}
                >
                  <item.icon className="w-5 h-5" />
                  <span className="font-medium">{item.name}</span>
                </Link>
              );
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

            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              {can(PERMISSIONS.EMAIL_READ) && (
                <Link
                  to="/email-processing"
                  className="hidden md:flex items-center space-x-2 text-sm text-gray-500 hover:text-primary"
                  title={
                    emailWorker?.heartbeatAt
                      ? `最近心跳：${new Date(emailWorker.heartbeatAt).toLocaleString()}`
                      : '暂无 Worker 心跳'
                  }
                >
                  <Mail
                    className={`w-4 h-4 ${emailWorker?.isRunning && emailWorker?.isConnected ? 'text-green-600' : 'text-gray-400'}`}
                  />
                  <span>
                    {emailWorker?.isRunning && emailWorker?.isConnected
                      ? '邮件监听正常'
                      : '邮件监听未连接'}
                  </span>
                </Link>
              )}

              {/* 分隔线 */}
              <div className="hidden md:block h-6 w-px bg-gray-200"></div>

              {/* 用户信息 */}
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <User className="w-4 h-4 text-gray-600" />
                  <span
                    className="text-sm font-medium text-gray-900 truncate max-w-[120px] sm:max-w-xs"
                    title={`${user?.nickname || user?.username}（${user?.username}）`}
                  >
                    {user?.nickname || user?.username}
                    <span className="hidden sm:inline">（{user?.username}）</span>
                  </span>
                  {user?.role === 'admin' ? (
                    <span className="badge badge-error shrink-0 whitespace-nowrap">管理员</span>
                  ) : (
                    <span className="badge badge-info shrink-0 whitespace-nowrap">用户</span>
                  )}
                </div>

                {/* 下拉菜单 */}
                <div className="relative" ref={menuRef}>
                  <button
                    onClick={() => setMenuOpen(prev => !prev)}
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
                            setMenuOpen(false);
                            navigate('/profile');
                          }}
                          className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <Lock className="w-4 h-4" />
                          <span>个人设置／修改密码</span>
                        </button>
                        <div className="border-t border-gray-200 my-2"></div>
                        <button
                          onClick={() => {
                            setMenuOpen(false);
                            handleLogout();
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
        <main className="p-6">{children}</main>
        {logoutError && (
          <AlertModal title="退出失败" message={logoutError} onClose={() => setLogoutError('')} />
        )}
      </div>
    </div>
  );
}
