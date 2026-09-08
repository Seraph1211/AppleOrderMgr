const {
  sequelize,
  User,
  UserPermission,
  UserPermissionEvent,
  PaymentStaffSetting,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { PERMISSIONS } = require('../constants/business');
const {
  ADMIN_RESERVED_PERMISSIONS,
  PERMISSION_DEPENDENCIES,
  PAYMENT_EXECUTION_PERMISSIONS,
  ALL_PERMISSION_CODES,
  getPermissionCatalog,
} = require('../constants/permissionCatalog');

const PAYMENT_ASSIGNMENT_LOCK_ID = 742091;

/**
 * 返回用户的有效权限。管理员固定拥有全部权限，普通用户仅使用显式授权。
 * @param {Object} user - 用户模型或至少含 id/role 的对象
 * @param {Object} [options] - 查询选项
 * @param {import('sequelize').Transaction} [options.transaction] - 事务
 * @returns {Promise<string[]>} 排序后的权限码
 */
async function getEffectivePermissions(user, options = {}) {
  if (user.role === 'admin') {
    return [...ALL_PERMISSION_CODES].sort();
  }
  const rows = await UserPermission.findAll({
    where: { userId: user.id },
    attributes: ['permissionCode'],
    order: [['permissionCode', 'ASC']],
    transaction: options.transaction,
  });
  return rows.map(row => row.permissionCode);
}

/**
 * 校验完整替换的权限集合。
 * @param {unknown} permissions - 待校验权限集合
 * @returns {string[]} 去重排序后的权限码
 */
function validatePermissionSet(permissions) {
  if (!Array.isArray(permissions)) {
    throw ApiError.badRequest('permissions 必须是数组');
  }
  const normalized = [...new Set(permissions.map(value => String(value).trim()))].sort();
  const unknown = normalized.filter(code => !ALL_PERMISSION_CODES.includes(code));
  if (unknown.length) {
    throw ApiError.badRequest('包含未知权限码', { unknownPermissions: unknown });
  }
  const reserved = normalized.filter(code => ADMIN_RESERVED_PERMISSIONS.includes(code));
  if (reserved.length) {
    throw ApiError.badRequest('管理员保留权限不能授予普通用户', {
      reservedPermissions: reserved,
    });
  }
  const permissionSet = new Set(normalized);
  const missingDependencies = [];
  for (const code of normalized) {
    for (const dependency of PERMISSION_DEPENDENCIES[code] || []) {
      if (!permissionSet.has(dependency)) {
        missingDependencies.push({ permission: code, dependency });
      }
    }
  }
  if (missingDependencies.length) {
    throw ApiError.badRequest('权限依赖不完整', { missingDependencies });
  }
  return normalized;
}

/**
 * 返回用户权限配置。
 * @param {number} userId - 用户 ID
 * @returns {Promise<Object>} 权限配置
 */
async function getUserPermissions(userId) {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'username', 'role', 'status', 'permissionsVersion'],
  });
  if (!user) {
    throw ApiError.notFound('用户不存在');
  }
  return {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
    },
    permissions: await getEffectivePermissions(user),
    version: user.permissionsVersion,
    editable: user.role !== 'admin',
  };
}

/**
 * 原子替换普通用户的显式权限集合。
 * @param {number} userId - 目标用户 ID
 * @param {Object} input - 更新输入
 * @param {string[]} input.permissions - 完整权限集合
 * @param {number} input.expectedVersion - 当前权限版本
 * @param {string} input.idempotencyKey - 幂等键
 * @param {string} [input.reason] - 变更原因
 * @param {number} actorUserId - 操作管理员 ID
 * @returns {Promise<Object>} 更新后的权限配置
 */
async function replaceUserPermissions(userId, input, actorUserId) {
  const normalized = validatePermissionSet(input.permissions);
  const expectedVersion = Number(input.expectedVersion);
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw ApiError.badRequest('expectedVersion 必须是非负整数');
  }
  if (!idempotencyKey || idempotencyKey.length > 100) {
    throw ApiError.badRequest('idempotencyKey 长度必须在 1-100 之间');
  }

  return await sequelize.transaction(async transaction => {
    // 与付款分配统一加锁顺序，避免“撤权锁用户、分配锁调度”形成死锁。
    await sequelize.query('SELECT pg_advisory_xact_lock(:lockId)', {
      replacements: { lockId: PAYMENT_ASSIGNMENT_LOCK_ID },
      transaction,
    });
    const previousEvent = await UserPermissionEvent.findOne({
      where: { actorUserId, idempotencyKey },
      transaction,
    });
    if (previousEvent) {
      if (previousEvent.userId !== userId) {
        throw ApiError.conflict('幂等键已用于其他用户', undefined, 'IDEMPOTENCY_CONFLICT');
      }
      return getUserPermissions(userId);
    }

    const user = await User.findByPk(userId, {
      attributes: ['id', 'username', 'role', 'status', 'permissionsVersion'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user) {
      throw ApiError.notFound('用户不存在');
    }
    if (user.role === 'admin') {
      throw ApiError.badRequest('管理员权限为系统固定全权，不接受逐项配置');
    }
    if (user.permissionsVersion !== expectedVersion) {
      throw ApiError.conflict(
        '权限配置已被其他操作更新，请刷新后重试',
        { currentVersion: user.permissionsVersion },
        'CONCURRENT_MODIFICATION'
      );
    }

    const beforePermissions = await getEffectivePermissions(user, { transaction });
    const revoked = beforePermissions.filter(code => !normalized.includes(code));
    if (revoked.some(code => PAYMENT_EXECUTION_PERMISSIONS.includes(code))) {
      await PaymentStaffSetting.update(
        {
          autoAssignEnabled: false,
          updatedBy: actorUserId,
          version: sequelize.literal('version + 1'),
        },
        { where: { userId: user.id }, transaction }
      );
    }

    await UserPermission.destroy({ where: { userId: user.id }, transaction });
    if (normalized.length) {
      await UserPermission.bulkCreate(
        normalized.map(permissionCode => ({
          userId: user.id,
          permissionCode,
          grantedBy: actorUserId,
        })),
        { transaction }
      );
    }
    const afterVersion = user.permissionsVersion + 1;
    await user.update({ permissionsVersion: afterVersion }, { transaction });
    await UserPermissionEvent.create(
      {
        userId: user.id,
        actorUserId,
        beforePermissions,
        afterPermissions: normalized,
        reason: input.reason ? String(input.reason).trim().slice(0, 500) : null,
        beforeVersion: expectedVersion,
        afterVersion,
        idempotencyKey,
        source: 'api',
      },
      { transaction }
    );
    return {
      user: { id: user.id, username: user.username, role: user.role, status: user.status },
      permissions: normalized,
      version: afterVersion,
      editable: true,
    };
  });
}

/**
 * 在同一事务中创建用户并写入初始权限。
 * @param {Object} userAttributes - 用户字段
 * @param {string[]} permissions - 普通用户初始权限
 * @param {number} actorUserId - 操作管理员 ID
 * @returns {Promise<Object>} 新用户与有效权限
 */
async function createUserWithPermissions(userAttributes, permissions, actorUserId) {
  const normalized =
    userAttributes.role === 'admin' ? [] : validatePermissionSet(permissions || []);
  return await sequelize.transaction(async transaction => {
    const user = await User.create(
      {
        ...userAttributes,
        permissionsVersion: userAttributes.role === 'admin' ? 0 : 1,
      },
      { transaction }
    );
    if (normalized.length) {
      await UserPermission.bulkCreate(
        normalized.map(permissionCode => ({
          userId: user.id,
          permissionCode,
          grantedBy: actorUserId,
        })),
        { transaction }
      );
    }
    if (user.role !== 'admin') {
      await UserPermissionEvent.create(
        {
          userId: user.id,
          actorUserId,
          beforePermissions: [],
          afterPermissions: normalized,
          reason: '创建用户时的初始授权',
          beforeVersion: 0,
          afterVersion: 1,
          idempotencyKey: null,
          source: 'create_user',
        },
        { transaction }
      );
    }
    return { user, permissions: await getEffectivePermissions(user, { transaction }) };
  });
}

/**
 * 按固定顺序选择登录后首页。
 * @param {string[]} permissions - 有效权限
 * @returns {string|null} 前端路径
 */
function resolveAvailableHome(permissions) {
  const candidates = [
    [PERMISSIONS.PAYMENT_TASKS_READ_OWN, '/payment-tasks'],
    [PERMISSIONS.DASHBOARD_READ, '/'],
    [PERMISSIONS.ORDERS_READ, '/orders'],
    [PERMISSIONS.APPLE_IDS_READ, '/apple-ids'],
    [PERMISSIONS.RECIPIENTS_READ, '/recipients'],
    [PERMISSIONS.CHANNELS_READ, '/channels'],
    [PERMISSIONS.PAYMENT_DISPATCH_READ, '/payment-dispatch'],
    [PERMISSIONS.USERS_READ, '/users'],
  ];
  return candidates.find(([permission]) => permissions.includes(permission))?.[1] || null;
}

module.exports = {
  PAYMENT_ASSIGNMENT_LOCK_ID,
  getEffectivePermissions,
  validatePermissionSet,
  getUserPermissions,
  replaceUserPermissions,
  createUserWithPermissions,
  resolveAvailableHome,
  getPermissionCatalog,
};
