import { PERMISSIONS } from './permissions.js';

export const DASHBOARD_NAVIGATION = {
  name: '仪表板',
  href: '/',
  icon: 'LayoutDashboard',
  permission: PERMISSIONS.DASHBOARD_READ,
};
export const PROFILE_NAVIGATION = { name: '个人设置', href: '/profile', icon: 'Settings' };
export const NAVIGATION_GROUPS = [
  {
    id: 'orders',
    name: '订单与库存',
    icon: 'Package',
    children: [
      { name: '订单管理', href: '/orders', icon: 'Package', permission: PERMISSIONS.ORDERS_READ },
      {
        name: '代抢管理',
        href: '/proxy-orders',
        icon: 'Package',
        permission: PERMISSIONS.PROXY_READ,
      },
      {
        name: '取货记录',
        href: '/pickups',
        icon: 'ClipboardCheck',
        permission: PERMISSIONS.PICKUPS_READ,
      },
      { name: '自有库存', href: '/stock', icon: 'Warehouse', permission: PERMISSIONS.STOCK_READ },
    ],
  },
  {
    id: 'inventory',
    name: '库存监控',
    icon: 'Warehouse',
    children: [
      {
        name: '库存查询',
        href: '/inventory-monitor',
        icon: 'Package',
        exact: true,
        permission: PERMISSIONS.INVENTORY_READ,
      },
      { name: '监控管理', href: '/inventory-monitor/manage', icon: 'Settings', adminOnly: true },
    ],
  },
  {
    id: 'payments',
    name: '付款管理',
    icon: 'CreditCard',
    children: [
      {
        name: '付款任务',
        href: '/payment-tasks',
        icon: 'CreditCard',
        permission: PERMISSIONS.PAYMENT_TASKS_READ_OWN,
      },
      {
        name: '付款调度',
        href: '/payment-dispatch',
        icon: 'ListChecks',
        permission: PERMISSIONS.PAYMENT_DISPATCH_READ,
      },
    ],
  },
  {
    id: 'resources',
    name: '基础资料',
    icon: 'Users',
    children: [
      {
        name: 'Apple ID',
        href: '/apple-ids',
        icon: 'Apple',
        permission: PERMISSIONS.APPLE_IDS_READ,
      },
      {
        name: '取机人',
        href: '/recipients',
        icon: 'User',
        permission: PERMISSIONS.RECIPIENTS_READ,
      },
      {
        name: '身份核验',
        href: '/identity-verifications',
        icon: 'ShieldCheck',
        permission: PERMISSIONS.IDENTITY_READ,
      },
      {
        name: '渠道管理',
        href: '/channels',
        icon: 'TrendingUp',
        permission: PERMISSIONS.CHANNELS_READ,
      },
    ],
  },
  {
    id: 'messages',
    name: '通知与邮件',
    icon: 'Mail',
    children: [
      {
        name: '企微订单通知',
        href: '/wecom-notifications',
        icon: 'Bell',
        permission: PERMISSIONS.WECOM_READ,
      },
      {
        name: '邮件处理',
        href: '/email-processing',
        icon: 'Mail',
        permission: PERMISSIONS.EMAIL_READ,
      },
      { name: '邮件联系人', href: '/mail-contacts', icon: 'Mail', adminOnly: true },
    ],
  },
  {
    id: 'system',
    name: '系统管理',
    icon: 'Settings',
    children: [
      { name: '公开报价', href: '/quote-pricing', icon: 'BadgeDollarSign', adminOnly: true },
      {
        name: '订单数据源',
        href: '/order-ingestion',
        icon: 'Mail',
        permission: PERMISSIONS.INGESTION_READ,
      },
      {
        name: '服务器监控',
        href: '/server-monitor',
        icon: 'TrendingUp',
        exact: true,
        permission: PERMISSIONS.MONITOR_MANAGE,
      },
      {
        name: '日志查询',
        href: '/server-monitor/logs',
        icon: 'ScrollText',
        permission: PERMISSIONS.MONITOR_MANAGE,
      },
      {
        name: '操作记录',
        href: '/operation-logs',
        icon: 'ScrollText',
        permission: PERMISSIONS.SYSTEM_LOGS_READ,
      },
      { name: '用户管理', href: '/users', icon: 'Users', permission: PERMISSIONS.USERS_READ },
    ],
  },
];

/** 按当前服务端权限快照过滤子菜单，隐藏无可见子项的分类。 */
export function getVisibleNavigationGroups(user, can) {
  return NAVIGATION_GROUPS.map(group => ({
    ...group,
    children: group.children.filter(item =>
      item.adminOnly ? user?.role === 'admin' : can(item.permission)
    ),
  })).filter(group => group.children.length > 0);
}

/** 详情路径归属对应菜单；精确匹配项避免监控父子页面同时选中。 */
export function isNavigationItemActive(item, pathname) {
  return (
    pathname === item.href ||
    (!item.exact && item.href !== '/' && pathname.startsWith(`${item.href}/`))
  );
}
