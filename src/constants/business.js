/**
 * 业务枚举与权限常量。
 * @module constants/business
 */

const ACCOUNT_STATUSES = Object.freeze(['未使用', '使用中', '已下架', '异常']);

const ORDER_STATUSES = Object.freeze([
  'pending',
  'processing',
  'shipped',
  'ready_for_pickup',
  'completed',
  'delivered',
  'cancelled',
  'pickup_cancelled',
  'unknown',
]);

const USER_ROLES = Object.freeze(['admin', 'operator', 'readOnly']);

const MIN_PASSWORD_LENGTH = 8;
const PAYMENT_WINDOW_MINUTES = 30;
const PAYMENT_WINDOW_MS = PAYMENT_WINDOW_MINUTES * 60 * 1000;

const EMAIL_PROCESSING_STATUSES = Object.freeze([
  'received',
  'ignored',
  'parsing',
  'retry_wait',
  'manual_review',
  'processing',
  'succeeded',
  'superseded',
]);

const EMAIL_TERMINAL_STATUSES = Object.freeze([
  'ignored',
  'manual_review',
  'succeeded',
  'superseded',
]);

const PERMISSIONS = Object.freeze({
  DASHBOARD_READ: 'dashboard.read',
  STATS_READ: 'stats.read',
  ORDERS_READ: 'orders.read',
  ORDERS_EDIT: 'orders.edit',
  ORDERS_EXPORT: 'orders.export',
  ORDERS_REFRESH: 'orders.refresh',
  ORDERS_PAYER_EDIT: 'orders.payer.edit',
  APPLE_IDS_READ: 'apple_ids.read',
  APPLE_IDS_CREATE: 'apple_ids.create',
  APPLE_IDS_EDIT: 'apple_ids.edit',
  APPLE_IDS_DELETE: 'apple_ids.delete',
  APPLE_IDS_IMPORT: 'apple_ids.import',
  APPLE_IDS_TEMPLATE_READ: 'apple_ids.template.read',
  RECIPIENTS_READ: 'recipients.read',
  RECIPIENTS_CREATE: 'recipients.create',
  RECIPIENTS_EDIT: 'recipients.edit',
  RECIPIENTS_DELETE: 'recipients.delete',
  RECIPIENTS_EXPORT: 'recipients.export',
  RECIPIENTS_IMPORT: 'recipients.import',
  RECIPIENTS_TEMPLATE_READ: 'recipients.template.read',
  RECIPIENTS_GENERATE_CONTACT: 'recipients.generate_contact',
  RECIPIENTS_GENERATE_ADDRESS: 'recipients.generate_address',
  RECIPIENTS_BIND_APPLE_IDS: 'recipients.bind_apple_ids',
  CHANNELS_READ: 'channels.read',
  CHANNELS_RENAME: 'channels.rename',
  PAYMENT_TASKS_READ_OWN: 'payment_tasks.read_own',
  PAYMENT_TASKS_HANDLE_OWN: 'payment_tasks.handle_own',
  PAYMENT_TASKS_PAYER_EDIT_OWN: 'payment_tasks.payer.edit_own',
  PAYMENT_TASKS_LINK_READ_OWN: 'payment_tasks.link.read_own',
  PAYMENT_TASKS_REFRESH_OWN: 'payment_tasks.refresh_own',
  PAYMENT_DISPATCH_READ: 'payment_dispatch.read',
  PAYMENT_DISPATCH_ASSIGN: 'payment_dispatch.assign',
  PAYMENT_DISPATCH_CONFIGURE: 'payment_dispatch.configure',
  PAYMENT_DISPATCH_CORRECT: 'payment_dispatch.correct',
  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  USERS_PERMISSIONS_MANAGE: 'users.permissions.manage',
  EMAIL_READ: 'email.read',
  EMAIL_CONTENT_READ: 'email.content.read',
  EMAIL_PROCESS: 'email.process',
  SYSTEM_LOGS_READ: 'system.logs.read',
  SYSTEM_REFRESH_READ: 'system.refresh.read',
  SYSTEM_REFRESH_MANAGE: 'system.refresh.manage',
  SYSTEM_PROXY_READ: 'system.proxy.read',
  SYSTEM_PROXY_MANAGE: 'system.proxy.manage',
  APPLE_IDS_SECRETS_READ: 'apple_ids.secrets.read',
  ORDERS_SECRETS_READ: 'orders.secrets.read',
  RECIPIENTS_EXPORT_SENSITIVE: 'recipients.export_sensitive',
});

const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze(Object.values(PERMISSIONS)),
  operator: Object.freeze([]),
  readOnly: Object.freeze([]),
});

module.exports = {
  ACCOUNT_STATUSES,
  ORDER_STATUSES,
  USER_ROLES,
  MIN_PASSWORD_LENGTH,
  PAYMENT_WINDOW_MINUTES,
  PAYMENT_WINDOW_MS,
  EMAIL_PROCESSING_STATUSES,
  EMAIL_TERMINAL_STATUSES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
};
