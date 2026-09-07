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

const PERMISSIONS = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  EXPORT: 'export',
  REFRESH: 'refresh',
  VIEW_SECRETS: 'viewSecrets',
  MANAGE_USERS: 'manageUsers',
});

const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze(Object.values(PERMISSIONS)),
  operator: Object.freeze([
    PERMISSIONS.READ,
    PERMISSIONS.WRITE,
    PERMISSIONS.EXPORT,
    PERMISSIONS.REFRESH,
  ]),
  readOnly: Object.freeze([PERMISSIONS.READ]),
});

module.exports = {
  ACCOUNT_STATUSES,
  ORDER_STATUSES,
  USER_ROLES,
  MIN_PASSWORD_LENGTH,
  PERMISSIONS,
  ROLE_PERMISSIONS,
};
