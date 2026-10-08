import { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
  Bell,
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
  ClipboardCheck,
  BadgeDollarSign,
  Warehouse,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getEmailProcessingMetrics } from '../api';
import AlertModal from './AlertModal';
import { PERMISSIONS } from '../constants/permissions';
import {
  DASHBOARD_NAVIGATION,
  PROFILE_NAVIGATION,
  NAVIGATION_GROUPS,
  getVisibleNavigationGroups,
  isNavigationItemActive,
} from '../constants/navigation';

const navigationIcons = {
  ShieldCheck,
  Bell,
  LayoutDashboard,
  Package,
  User,
  Mail,
  Apple,
  TrendingUp,
  Users,
  Settings,
  ScrollText,
  CreditCard,
  ListChecks,
  ClipboardCheck,
  BadgeDollarSign,
  Warehouse,
};

function NavigationLink({ item, pathname, nested = false, onNavigate }) {
  const Icon = navigationIcons[item.icon];
  const active = isNavigationItemActive(item, pathname);
  return (
    <Link
      to={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-11 items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${nested ? 'ml-5' : ''} ${active ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`}
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="font-medium">{item.name}</span>
    </Link>
  );
}

export default function Layout({ children }) {
  const [logoutError, setLogoutError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emailWorker, setEmailWorker] = useState(null);
  const menuRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, can } = useAuth();

  const navigationGroups = getVisibleNavigationGroups(user, can);
  const activeGroupId = navigationGroups.find(group =>
    group.children.some(item => isNavigationItemActive(item, location.pathname))
  )?.id;
  const navigationStorageKey = `navigation-groups:v1:${user?.id}`;
  const [expandedGroups, setExpandedGroups] = useState(() => {
    let saved = [];
    try {
      const stored = JSON.parse(localStorage.getItem(navigationStorageKey) || '[]');
      if (Array.isArray(stored))
        saved = stored.filter(id => NAVIGATION_GROUPS.some(group => group.id === id));
    } catch (_error) {
      // 存储被禁用或旧值损坏时，仍可正常使用导航。
    }
    return [...new Set([...saved, ...(activeGroupId ? [activeGroupId] : [])])];
  });

  useEffect(() => {
    if (activeGroupId) {
      setExpandedGroups(current =>
        current.includes(activeGroupId) ? current : [...current, activeGroupId]
      );
    }
  }, [location.pathname, activeGroupId]);

  useEffect(() => {
    try {
      localStorage.setItem(navigationStorageKey, JSON.stringify(expandedGroups));
    } catch (_error) {
      // 无存储权限时，只在本次页面会话保留展开状态。
    }
  }, [navigationStorageKey, expandedGroups]);

  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const closeOnEscape = event => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [sidebarOpen]);

  const toggleNavigationGroup = id => {
    setExpandedGroups(current =>
      current.includes(id) ? current.filter(value => value !== id) : [...current, id]
    );
  };

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
        <button
          type="button"
          aria-label="关闭导航遮罩"
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 侧边栏 */}
      <aside
        className={`
        fixed inset-y-0 left-0 z-50 lg:z-20 w-64 lg:w-52 bg-white border-r border-gray-200
        transform transition-transform duration-200 ease-in-out lg:translate-x-0
        ${sidebarOpen ? 'visible translate-x-0' : 'invisible lg:visible -translate-x-full'}
      `}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex shrink-0 items-center justify-between h-[52px] px-4">
            <div className="flex items-center space-x-2">
              <Apple className="w-7 h-7 shrink-0 text-primary" />
              <span className="text-sm font-semibold text-gray-900">Apple Orders Mgr</span>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              aria-label="关闭导航"
              className="lg:hidden min-h-11 min-w-11 flex items-center justify-center text-gray-400 hover:text-gray-600"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* 导航 */}
          <nav
            aria-label="主导航"
            className="min-h-0 flex-1 px-3 py-4 space-y-1 overflow-y-auto overscroll-contain"
          >
            {can(DASHBOARD_NAVIGATION.permission) && (
              <NavigationLink
                item={DASHBOARD_NAVIGATION}
                pathname={location.pathname}
                onNavigate={() => setSidebarOpen(false)}
              />
            )}
            {navigationGroups.map(group => {
              const Icon = navigationIcons[group.icon];
              const expanded = expandedGroups.includes(group.id);
              const active = activeGroupId === group.id;
              return (
                <div key={group.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`navigation-${group.id}`}
                    onClick={() => toggleNavigationGroup(group.id)}
                    className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${active ? 'text-primary' : 'text-gray-600 hover:text-gray-900'} hover:bg-gray-100`}
                  >
                    <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span className="flex-1 font-semibold">{group.name}</span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                  <div id={`navigation-${group.id}`} hidden={!expanded} className="mt-1 space-y-1">
                    {group.children.map(item => (
                      <NavigationLink
                        key={item.href}
                        item={item}
                        pathname={location.pathname}
                        nested
                        onNavigate={() => setSidebarOpen(false)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </nav>

          <div className="shrink-0 border-t border-gray-200 px-3 py-2">
            <NavigationLink
              item={PROFILE_NAVIGATION}
              pathname={location.pathname}
              onNavigate={() => setSidebarOpen(false)}
            />
          </div>
          {/* 底部信息 */}
          <div className="shrink-0 p-4 border-t border-gray-200">
            <div className="text-xs text-gray-500">
              <p>Apple 订单管理系统</p>
              <p className="mt-1">v1.0.0</p>
            </div>
          </div>
        </div>
      </aside>

      {/* 主内容区 */}
      <div className="lg:pl-52">
        {/* 顶部栏 */}
        <header className="sticky top-0 z-10 h-[52px] bg-white">
          <div className="flex items-center justify-between h-full px-4">
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="打开导航"
              className="lg:hidden min-h-11 min-w-11 flex items-center justify-center text-gray-400 hover:text-gray-600"
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
                    aria-label="账号菜单"
                    className="min-h-11 min-w-11 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
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
        <main className="app-content min-w-0 p-3 sm:p-4">{children}</main>
        {logoutError && (
          <AlertModal title="退出失败" message={logoutError} onClose={() => setLogoutError('')} />
        )}
      </div>
    </div>
  );
}
