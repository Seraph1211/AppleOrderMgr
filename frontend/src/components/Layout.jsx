import { useState, useEffect, useRef } from 'react';
import '../pages/ordersWorkspace.css';
import './appSidebar.css';
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
import AlertModal from './AlertModal';
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
  const menuRef = useRef(null);
  const sidebarRef = useRef(null);
  const navigationTriggerRef = useRef(null);
  const mainRef = useRef(null);
  const preferenceKeyRef = useRef(null);
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
    if (preferenceKeyRef.current && preferenceKeyRef.current !== navigationStorageKey) {
      let saved = [];
      try {
        const value = JSON.parse(localStorage.getItem(navigationStorageKey) || '[]');
        if (Array.isArray(value))
          saved = value.filter(id => NAVIGATION_GROUPS.some(group => group.id === id));
      } catch (_error) {
        // 禁用存储时继续使用当前路由分组。
      }
      preferenceKeyRef.current = navigationStorageKey;
      setExpandedGroups([...new Set([...saved, ...(activeGroupId ? [activeGroupId] : [])])]);
      return;
    }
    preferenceKeyRef.current = navigationStorageKey;
    try {
      localStorage.setItem(navigationStorageKey, JSON.stringify(expandedGroups));
    } catch (_error) {
      // 无存储权限时，只在本次页面会话保留展开状态。
    }
  }, [navigationStorageKey, expandedGroups, activeGroupId]);

  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const previous = navigationTriggerRef.current;
    const main = mainRef.current;
    const panel = sidebarRef.current;
    const overflow = document.body.style.overflow;
    main.inert = true;
    document.body.style.overflow = 'hidden';
    panel.querySelector('button')?.focus({ preventScroll: true });
    const closeOnEscape = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebarOpen(false);
      }
      if (event.key !== 'Tab') return;
      const controls = [...panel.querySelectorAll('a[href],button:not(:disabled)')].filter(
        node => node.getClientRects().length && !node.closest('[hidden]')
      );
      const first = controls[0];
      const last = controls.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    const desktop = window.matchMedia(
      location.pathname === '/orders' ? '(min-width: 1100px)' : '(min-width: 1024px)'
    );
    const closeOnDesktop = () => {
      if (desktop.matches) setSidebarOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      desktop.removeEventListener('change', closeOnDesktop);
      document.removeEventListener('keydown', closeOnEscape);
      main.inert = false;
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [sidebarOpen, location.pathname]);

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

  return (
    <div
      className={`min-h-screen bg-gray-50 ${location.pathname === '/orders' ? 'orders-workspace' : ''}`}
    >
      {/* 移动端侧边栏遮罩 */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭导航遮罩"
          className="app-navigation-backdrop fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 侧边栏 */}
      <aside
        ref={sidebarRef}
        role={sidebarOpen ? 'dialog' : undefined}
        aria-modal={sidebarOpen || undefined}
        aria-label="应用导航"
        className={`app-sidebar ${sidebarOpen ? 'is-open' : ''}
        fixed inset-y-0 left-0 z-50 lg:z-20 w-64 lg:w-52 bg-white border-r border-gray-200
        transform transition-transform duration-200 ease-in-out lg:translate-x-0
        ${sidebarOpen ? 'visible translate-x-0' : 'invisible lg:visible -translate-x-full'}
      `}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="app-brand flex shrink-0 items-center justify-between h-[72px] px-4">
            <div className="flex min-w-0 items-center gap-1">
              <img
                src="/order-mark-blue.png"
                alt=""
                aria-hidden="true"
                className="h-11 w-11 shrink-0 object-contain"
              />
              <div className="min-w-0">
                <span className="app-brand-name block text-sm font-semibold text-gray-900">
                  Apple Orders Mgr
                </span>
                <span className="app-brand-caption block text-xs text-gray-500">
                  订单管理工作台
                </span>
              </div>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              aria-label="关闭导航"
              className="app-sidebar-close lg:hidden min-h-11 min-w-11 flex items-center justify-center text-gray-400 hover:text-gray-600"
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
          <div className="app-version shrink-0 border-t border-gray-200 px-4 py-3 text-xs text-gray-500">
            <span aria-label="系统版本">v{import.meta.env.VITE_APP_VERSION}</span>
          </div>
        </div>
      </aside>

      {/* 主内容区 */}
      <div ref={mainRef} className="app-main lg:pl-52">
        {/* 顶部栏 */}
        <header className="sticky top-0 z-10 h-[52px] bg-white">
          <div className="flex items-center justify-between h-full px-4">
            <button
              ref={navigationTriggerRef}
              onClick={() => setSidebarOpen(true)}
              aria-label="打开导航"
              className="app-navigation-trigger lg:hidden min-h-11 min-w-11 flex items-center justify-center text-gray-400 hover:text-gray-600"
            >
              <Menu className="w-6 h-6" />
            </button>

            {location.pathname === '/orders' && (
              <img
                src="/order-mark-blue.png"
                alt=""
                aria-hidden="true"
                className="h-9 w-9 object-contain lg:hidden"
              />
            )}
            <div className="flex-1" />

            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
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
