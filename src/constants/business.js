/**
 * 业务枚举与权限常量。
 * @module constants/business
 */

const ACCOUNT_STATUSES = Object.freeze(['未使用', '使用中', '已下架', '异常']);

const ORDER_STATUSES = Object.freeze([
  'payment_due',
  'payment_received',
  'picked_up',
  'payment_expired',
  'pending',
  'processing',
  'shipped',
  'ready_for_pickup',
  'delivered',
  'cancelled',
  'pickup_cancelled',
  'unknown',
]);

const EMAIL_ORDER_STATUSES = Object.freeze([
  'unknown',
  'confirmed',
  'processing',
  'ready_for_pickup',
  'picked_up',
  'partially_cancelled',
  'cancelled',
  'expired',
  'partially_return_requested',
  'return_requested',
]);

const USER_ROLES = Object.freeze(['admin', 'operator', 'pickupStaff', 'readOnly']);

/** 将未识别的存量订单状态归为 unknown，不推断其业务结果。 */
function normalizeOrderStatus(status) {
  return ORDER_STATUSES.includes(status) ? status : 'unknown';
}

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
  STOCK_READ: 'stock.read',
  STOCK_RECEIVE: 'stock.receive',
  STOCK_TRANSFER: 'stock.transfer',
  STOCK_SOURCE_LINK: 'stock.source.link',
  STOCK_CATALOG_MANAGE: 'stock.catalog.manage',
  STOCK_COST_READ: 'stock.cost.read',
  STOCK_COST_EDIT: 'stock.cost.edit',
  STOCK_SALES_READ: 'stock.sales.read',
  STOCK_SALES_EDIT: 'stock.sales.edit',
  STOCK_SALES_SHIP: 'stock.sales.ship',
  STOCK_EXPENSES_READ: 'stock.expenses.read',
  STOCK_EXPENSES_EDIT: 'stock.expenses.edit',
  STOCK_PROFIT_READ: 'stock.profit.read',
  STOCK_COLLECTIONS_READ: 'stock.collections.read',
  STOCK_COLLECTIONS_EDIT: 'stock.collections.edit',
  STOCK_RECEIPTS_READ: 'stock.receipts.read',
  STOCK_RECEIPTS_EDIT: 'stock.receipts.edit',
  STOCK_IMPORT: 'stock.import',
  STOCK_EXPORT: 'stock.export',
  STOCK_CORRECT: 'stock.correct',
  STOCK_SETTINGS_MANAGE: 'stock.settings.manage',

  INVENTORY_READ: 'inventory.read',
  PROXY_READ: 'proxy_orders.read',
  PROXY_EDIT: 'proxy_orders.edit',
  PROXY_STATUS: 'proxy_orders.status',
  PROXY_COPY: 'proxy_orders.copy',
  PROXY_ACCOUNTS: 'proxy_orders.accounts',
  PROXY_LINK: 'proxy_orders.link',
  WECOM_READ: 'wecom.read',
  WECOM_CONFIGURE: 'wecom.configure',
  WECOM_RETRY: 'wecom.retry',
  MONITOR_MANAGE: 'monitor.manage',
  INGESTION_READ: 'ingestion.read',
  INGESTION_MANAGE: 'ingestion.manage',
  INGESTION_DEVICES_MANAGE: 'ingestion.devices.manage',
  INGESTION_RECORDS_PROCESS: 'ingestion.records.process',
  INGESTION_CONTENT_READ: 'ingestion.content.read',
  IDENTITY_READ: 'identity.read',
  IDENTITY_VERIFY: 'identity.verify',
  IDENTITY_BATCH: 'identity.batch',
  IDENTITY_EXPORT: 'identity.export',
  DASHBOARD_READ: 'dashboard.read',
  STATS_READ: 'stats.read',
  ORDERS_READ: 'orders.read',
  ORDER_MAIL_READ: 'order_mail.read',
  ORDER_MAIL_FORWARD: 'order_mail.forward',
  ORDER_MAIL_MANAGE: 'order_mail.manage',
  ORDERS_EDIT: 'orders.edit',
  ORDERS_EXPORT: 'orders.export',
  ORDERS_PAYER_EDIT: 'orders.payer.edit',
  PICKUPS_READ: 'pickups.read',
  PICKUPS_EDIT: 'pickups.edit',
  PICKUPS_EXPORT: 'pickups.export',
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
  APPLE_IDS_SECRETS_READ: 'apple_ids.secrets.read',
  ORDERS_SECRETS_READ: 'orders.secrets.read',
  RECIPIENTS_EXPORT_SENSITIVE: 'recipients.export_sensitive',
});

const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze(Object.values(PERMISSIONS)),
  operator: Object.freeze([]),
  pickupStaff: Object.freeze([]),
  readOnly: Object.freeze([]),
});

module.exports = {
  ACCOUNT_STATUSES,
  ORDER_STATUSES,
  EMAIL_ORDER_STATUSES,
  normalizeOrderStatus,
  USER_ROLES,
  MIN_PASSWORD_LENGTH,
  PAYMENT_WINDOW_MINUTES,
  PAYMENT_WINDOW_MS,
  EMAIL_PROCESSING_STATUSES,
  EMAIL_TERMINAL_STATUSES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
};
