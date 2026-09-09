const logger = require('../utils/logger');
const { Op, fn, col, Sequelize } = require('sequelize');
const {
  sequelize,
  User,
  UserPermission,
  PaymentTask,
  PaymentTaskEvent,
  PaymentDispatchSetting,
  PaymentStaffSetting,
  PaymentDispatchEvent,
  Order,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { getOfficialDeadline, isPaymentBlocked } = require('./crawler/officialOrderData');
const { ORDER_STATUSES } = require('../constants/business');
const { PAYMENT_EXECUTION_PERMISSIONS } = require('../constants/permissionCatalog');
const { PAYMENT_ASSIGNMENT_LOCK_ID, getEffectivePermissions } = require('./permissionService');
const refreshJobService = require('./crawler/refreshJobService');
const { ACTIVE_PAYMENT_TASK_STATUSES, serializeTask } = require('./paymentTaskService');

function validateExpectedVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw ApiError.badRequest('expectedVersion 必须是非负整数');
  }
  return version;
}

function validateIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 100) {
    throw ApiError.badRequest('idempotencyKey 长度必须在 1-100 之间');
  }
  return key;
}

async function lockDispatch(transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(:lockId)', {
    replacements: { lockId: PAYMENT_ASSIGNMENT_LOCK_ID },
    transaction,
  });
}

async function getOrCreateSettings(transaction) {
  const [settings] = await PaymentDispatchSetting.findOrCreate({
    where: { id: 1 },
    defaults: { id: 1, enabled: false, mode: 'manual' },
    transaction,
  });
  return settings;
}

const isOrderExcluded = isPaymentBlocked;

// 手动分配用于过期任务交接，仅豁免付款过期，不放宽其他官网风险状态。
function isManualAssignmentBlocked(order) {
  if (order.status !== 'payment_expired') return isOrderExcluded(order);
  return isOrderExcluded({
    status: 'payment_due',
    paymentStatus: order.paymentStatus,
    officialStatusNeedsReview: order.officialStatusNeedsReview,
    validationIssues: order.validationIssues,
    officialAllItemsTerminal: false,
  });
}

function validatePaymentOrderUrl(orderUrl, orderNumber) {
  try {
    const parsed = new URL(orderUrl);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const validPath =
      pathParts[0] === 'xc' &&
      pathParts[1] === 'cn' &&
      pathParts[2] === 'vieworder' &&
      pathParts[3]?.toUpperCase() === String(orderNumber).toUpperCase() &&
      Boolean(pathParts[4]);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'www.apple.com.cn' ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      !validPath
    ) {
      throw new Error('invalid');
    }
  } catch (_error) {
    throw ApiError.conflict('订单付款链接无效', undefined, 'PAYMENT_LINK_INVALID');
  }
}

/**
 * 在订单入库事务内按当前调度范围幂等登记付款任务。
 * @param {Object} order - Order 模型
 * @param {import('sequelize').Transaction} transaction - 订单入库事务
 * @returns {Promise<Object|null>} 付款任务或 null
 */
async function enrollOrderInTransaction(order, transaction) {
  const settings = await getOrCreateSettings(transaction);
  if (!settings.enabled || !settings.scopeStartedAt || isOrderExcluded(order)) return null;
  if (new Date(order.createdAt) < new Date(settings.scopeStartedAt)) return null;
  const [task, created] = await PaymentTask.findOrCreate({
    where: { orderId: order.id },
    defaults: {
      orderId: order.id,
      processingStatus: 'pending',
      deadlineAt: getOfficialDeadline(order),
      deadlineSource: getOfficialDeadline(order) ? 'official' : null,
      paymentLinkSource: order.orderUrl ? 'order_url' : null,
    },
    transaction,
  });
  const officialDeadline = getOfficialDeadline(order);
  if (
    !created &&
    officialDeadline &&
    (!task.deadlineAt || new Date(task.deadlineAt).getTime() !== officialDeadline.getTime())
  ) {
    task.deadlineAt = officialDeadline;
    task.deadlineSource = 'official';
    task.eligibilityVerifiedAt = null;
    task.eligibilityValidUntil = null;
    task.eligibilityVerifiedBy = null;
    task.paymentLinkSource = order.orderUrl ? 'order_url' : null;
    task.version += 1;
    await task.save({ transaction });
  }
  if (created) {
    await PaymentTaskEvent.create(
      {
        paymentTaskId: task.id,
        eventType: 'enrolled',
        beforeStatus: null,
        afterStatus: 'pending',
        details: { officialTime: 'pending' },
      },
      { transaction }
    );
  }
  return task;
}

/**
 * 查询调度配置和人员容量概览。
 * @returns {Promise<Object>} 调度概览
 */
async function getDispatchOverview() {
  const settings = await getOrCreateSettings();
  const users = await User.findAll({
    attributes: ['id', 'username', 'role', 'status', 'nickname'],
    include: [
      { model: UserPermission, as: 'permissionGrants', attributes: ['permissionCode'] },
      { model: PaymentStaffSetting, as: 'paymentStaffSetting', required: false },
    ],
    order: [['id', 'ASC']],
  });
  const counts = await PaymentTask.findAll({
    where: {
      assigneeUserId: { [Op.ne]: null },
      processingStatus: { [Op.in]: ACTIVE_PAYMENT_TASK_STATUSES },
    },
    attributes: ['assigneeUserId', [fn('COUNT', col('id')), 'activeCount']],
    group: ['assigneeUserId'],
    raw: true,
  });
  const countByUser = new Map(
    counts.map(row => [Number(row.assigneeUserId), Number(row.activeCount)])
  );
  return {
    settings,
    staff: users.map(user => {
      const plain = user.toJSON();
      const permissions =
        user.role === 'admin'
          ? PAYMENT_EXECUTION_PERMISSIONS
          : plain.permissionGrants.map(row => row.permissionCode);
      const config = plain.paymentStaffSetting;
      const activeCount = countByUser.get(user.id) || 0;
      return {
        id: user.id,
        username: user.username,
        status: user.status,
        nickname: user.nickname || user.username,
        hasExecutionPermissions: PAYMENT_EXECUTION_PERMISSIONS.every(code =>
          permissions.includes(code)
        ),
        autoAssignEnabled: config?.autoAssignEnabled || false,
        maxActiveTasks: config?.maxActiveTasks || 0,
        activeCount,
        remainingCapacity: Math.max(0, (config?.maxActiveTasks || 0) - activeCount),
        lastAssignedAt: config?.lastAssignedAt || null,
        version: config?.version || 0,
      };
    }),
  };
}

/**
 * 乐观锁更新全局付款调度配置。
 * @param {Object} input - 配置
 * @param {number} actorUserId - 管理员 ID
 * @returns {Promise<Object>} 更新后配置
 */
async function updateDispatchSettings(input, actorUserId) {
  const expectedVersion = validateExpectedVersion(input.expectedVersion);
  return await sequelize.transaction(async transaction => {
    await lockDispatch(transaction);
    const settings = await getOrCreateSettings(transaction);
    await settings.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (settings.version !== expectedVersion) {
      throw ApiError.conflict(
        '调度配置已被更新',
        { currentVersion: settings.version },
        'CONCURRENT_MODIFICATION'
      );
    }
    if (input.mode !== undefined && !['manual', 'auto'].includes(input.mode)) {
      throw ApiError.badRequest('mode 必须是 manual 或 auto');
    }
    const wasEnabled = settings.enabled;
    if (input.enabled !== undefined) settings.enabled = Boolean(input.enabled);
    if (input.mode !== undefined) settings.mode = input.mode;
    if (!wasEnabled && settings.enabled) settings.scopeStartedAt = new Date();
    settings.updatedBy = actorUserId;
    settings.version += 1;
    await settings.save({ transaction });
    await PaymentDispatchEvent.create(
      {
        eventType: 'settings_updated',
        actorUserId,
        details: {
          enabled: settings.enabled,
          mode: settings.mode,
          scopeStartedAt: settings.scopeStartedAt,
        },
      },
      { transaction }
    );
    return settings;
  });
}

/**
 * 更新付款人员自动接单和容量。
 * @param {number} userId - 用户 ID
 * @param {Object} input - 配置
 * @param {number} actorUserId - 管理员 ID
 * @param {Object|null} transaction - 可选批量保存事务
 * @returns {Promise<Object>} 更新后配置
 */
async function updateStaffSettings(userId, input, actorUserId, transaction = null) {
  try {
    const expectedVersion = validateExpectedVersion(input.expectedVersion);
    const maxActiveTasks = Number(input.maxActiveTasks);
    if (!Number.isInteger(maxActiveTasks) || maxActiveTasks < 0 || maxActiveTasks > 1000) {
      throw ApiError.badRequest('maxActiveTasks 必须是 0-1000 的整数');
    }
    const apply = async transaction => {
      try {
        const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!user) throw ApiError.badRequest('付款执行人员不存在');
        const permissions = await getEffectivePermissions(user, { transaction });
        const hasFullSet = PAYMENT_EXECUTION_PERMISSIONS.every(code => permissions.includes(code));
        if (input.autoAssignEnabled && (!hasFullSet || user.status !== 'active')) {
          throw ApiError.badRequest('开启自动接单前必须具备完整付款权限、账号正常');
        }
        const [setting] = await PaymentStaffSetting.findOrCreate({
          where: { userId },
          defaults: { userId, maxActiveTasks: 0, autoAssignEnabled: false, updatedBy: actorUserId },
          transaction,
        });
        await setting.reload({ transaction, lock: transaction.LOCK.UPDATE });
        if (setting.version !== expectedVersion) {
          throw ApiError.conflict(
            '人员配置已被更新',
            { currentVersion: setting.version },
            'CONCURRENT_MODIFICATION'
          );
        }
        setting.autoAssignEnabled = Boolean(input.autoAssignEnabled);
        setting.maxActiveTasks = maxActiveTasks;
        setting.updatedBy = actorUserId;
        setting.version += 1;
        await setting.save({ transaction });
        await PaymentDispatchEvent.create(
          {
            eventType: 'staff_settings_updated',
            actorUserId,
            details: { userId, autoAssignEnabled: setting.autoAssignEnabled, maxActiveTasks },
          },
          { transaction }
        );
        return setting;
      } catch (error) {
        logger.error('更新人员配置失败', { userId, error: error.message });
        throw error;
      }
    };
    if (transaction) return await apply(transaction);
    return await sequelize.transaction(async currentTransaction => {
      try {
        await lockDispatch(currentTransaction);
        return await apply(currentTransaction);
      } catch (error) {
        logger.error('人员配置事务失败', { userId, error: error.message });
        throw error;
      }
    });
  } catch (error) {
    logger.error('保存人员配置失败', { userId, error: error.message });
    throw error;
  }
}

/**
 * 同一事务保存全部修改人员，版本冲突时全部回滚。
 * @param {Object[]} staff - 修改行
 * @param {number} actorUserId - 管理员 ID
 * @returns {Promise<Object>} 批量结果
 */
async function updateStaffSettingsBatch(staff, actorUserId) {
  try {
    if (!Array.isArray(staff) || !staff.length || staff.length > 1000)
      throw ApiError.badRequest('请选择 1–1000 个需要修改的人员');
    const ids = staff.map(row => row?.userId);
    if (ids.some(id => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length)
      throw ApiError.badRequest('人员 ID 无效或重复');
    if (staff.some(row => typeof row.autoAssignEnabled !== 'boolean'))
      throw ApiError.badRequest('自动接单必须为开或关');
    return await sequelize.transaction(async transaction => {
      try {
        await lockDispatch(transaction);
        const items = [];
        for (const row of [...staff].sort((a, b) => a.userId - b.userId)) {
          items.push(await updateStaffSettings(row.userId, row, actorUserId, transaction));
        }
        return { count: items.length, items };
      } catch (error) {
        logger.error('批量人员配置事务失败', { actorUserId, error: error.message });
        throw error;
      }
    });
  } catch (error) {
    logger.error('批量人员配置失败', { actorUserId, error: error.message });
    throw error;
  }
}

async function assertAssignableUser(userId, transaction, requireAuto = false) {
  const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!user || user.status !== 'active') {
    throw ApiError.badRequest('目标执行人员账号不可用');
  }
  const permissions = await getEffectivePermissions(user, { transaction });
  if (!PAYMENT_EXECUTION_PERMISSIONS.every(code => permissions.includes(code))) {
    throw ApiError.badRequest('目标用户缺少完整付款执行权限');
  }
  const setting = await PaymentStaffSetting.findOne({
    where: { userId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!setting || setting.maxActiveTasks <= 0 || (requireAuto && !setting.autoAssignEnabled)) {
    throw ApiError.badRequest('目标用户未开启有效的接单容量');
  }
  const activeCount = await PaymentTask.count({
    where: { assigneeUserId: userId, processingStatus: { [Op.in]: ACTIVE_PAYMENT_TASK_STATUSES } },
    transaction,
  });
  if (activeCount >= setting.maxActiveTasks) {
    throw ApiError.conflict(
      '目标用户接单容量已满',
      { activeCount, maxActiveTasks: setting.maxActiveTasks },
      'CAPACITY_EXCEEDED'
    );
  }
  return { user, setting, activeCount };
}

function normalizeAssignmentTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 100) {
    throw ApiError.badRequest('tasks 必须是 1-100 项的数组');
  }
  const normalized = tasks.map(item => ({
    id: Number(item?.id),
    expectedVersion: validateExpectedVersion(item?.expectedVersion),
  }));
  if (normalized.some(item => !Number.isInteger(item.id) || item.id <= 0)) {
    throw ApiError.badRequest('tasks 包含无效任务 ID');
  }
  if (new Set(normalized.map(item => item.id)).size !== normalized.length) {
    throw ApiError.badRequest('tasks 不能包含重复任务 ID');
  }
  return normalized.sort((left, right) => left.id - right.id);
}

function buildAssignmentEventKey(idempotencyKey, taskId) {
  return `${idempotencyKey.slice(0, 70)}:${taskId}`;
}

/**
 * 原子批量分配或转派付款任务。
 * @param {Object} input - 批量分配参数
 * @param {number} actorUserId - 管理员 ID
 * @returns {Promise<Object>} 分配结果
 */
async function assignTasks(input, actorUserId) {
  const assignments = normalizeAssignmentTasks(input.tasks);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const assigneeUserId = Number(input.assigneeUserId);
  if (!Number.isInteger(assigneeUserId) || assigneeUserId <= 0) {
    throw ApiError.badRequest('assigneeUserId 必须是正整数');
  }
  const reason = String(input.reason || '').trim();
  if (reason.length > 500) throw ApiError.badRequest('reason 不能超过 500 字');
  const taskIds = assignments.map(item => item.id);
  const eventKeys = taskIds.map(id => buildAssignmentEventKey(idempotencyKey, id));

  await sequelize.transaction(async transaction => {
    await lockDispatch(transaction);
    const replays = await PaymentTaskEvent.findAll({
      where: { actorUserId, idempotencyKey: { [Op.in]: eventKeys } },
      transaction,
    });
    if (replays.length > 0) {
      const replayMatches =
        replays.length === assignments.length &&
        replays.every(event => taskIds.includes(Number(event.paymentTaskId))) &&
        replays.every(event => Number(event.toUserId) === assigneeUserId);
      if (!replayMatches) {
        throw ApiError.conflict('幂等键已用于其他批量分配', undefined, 'IDEMPOTENCY_CONFLICT');
      }
      return;
    }

    const tasks = await PaymentTask.findAll({
      where: { id: { [Op.in]: taskIds } },
      include: [
        {
          model: Order,
          as: 'order',
          attributes: [
            'orderNumber',
            'orderUrl',
            'status',
            'paymentStatus',
            'orderDate',
            'officialOrderCreatedAt',
            'officialPaymentExpiresAt',
            'officialStatusNeedsReview',
            'officialAllItemsTerminal',
            'validationIssues',
          ],
        },
      ],
      order: [['id', 'ASC']],
      transaction,
      lock: { level: transaction.LOCK.UPDATE, of: PaymentTask },
    });
    if (tasks.length !== assignments.length) throw ApiError.notFound('部分付款任务不存在');

    const versionById = new Map(assignments.map(item => [item.id, item.expectedVersion]));
    const now = new Date();
    for (const task of tasks) {
      if (task.version !== versionById.get(Number(task.id))) {
        throw ApiError.conflict(
          '批量任务中存在已更新记录',
          { taskId: task.id, currentVersion: task.version },
          'CONCURRENT_MODIFICATION'
        );
      }
      if (task.processingStatus === 'completed') {
        throw ApiError.conflict('已完成任务必须先重开才能转派', undefined, 'INVALID_STATE');
      }
      const deadlineAt = getOfficialDeadline(task.order);
      if (!deadlineAt || isManualAssignmentBlocked(task.order)) {
        throw ApiError.conflict(
          '批量任务中存在付款截止时间未知，或已付款、取消、状态待核实等不允许分配的订单',
          { taskId: task.id },
          'PAYMENT_NOT_ELIGIBLE'
        );
      }
      validatePaymentOrderUrl(task.order.orderUrl, task.order.orderNumber);
    }

    const hasTransfer = tasks.some(
      task => task.assigneeUserId && Number(task.assigneeUserId) !== assigneeUserId
    );
    if (hasTransfer && !input.handoffConfirmed) {
      throw ApiError.badRequest('批量转派必须确认原执行方已停止处理');
    }
    const { setting, activeCount } = await assertAssignableUser(assigneeUserId, transaction, false);
    const addedCount = tasks.filter(task => Number(task.assigneeUserId) !== assigneeUserId).length;
    if (activeCount + addedCount > setting.maxActiveTasks) {
      throw ApiError.conflict(
        '批量分配后将超过目标用户接单容量',
        { activeCount, addedCount, maxActiveTasks: setting.maxActiveTasks },
        'CAPACITY_EXCEEDED'
      );
    }

    for (const task of tasks) {
      const fromUserId = task.assigneeUserId;
      const isTransfer = Boolean(fromUserId && Number(fromUserId) !== assigneeUserId);
      const changed = Number(fromUserId) !== assigneeUserId;
      if (changed) {
        task.assigneeUserId = assigneeUserId;
        task.assignedAt = now;
        task.deadlineAt = getOfficialDeadline(task.order);
        task.deadlineSource = 'official';
        task.eligibilityVerifiedAt = null;
        task.eligibilityValidUntil = null;
        task.eligibilityVerifiedBy = null;
        task.paymentLinkSource = 'order_url';
        task.version += 1;
        await task.save({ transaction });
      }
      await PaymentTaskEvent.create(
        {
          paymentTaskId: task.id,
          eventType: changed ? (isTransfer ? 'transferred' : 'assigned') : 'assignment_confirmed',
          actorUserId,
          fromUserId,
          toUserId: assigneeUserId,
          beforeStatus: task.processingStatus,
          afterStatus: task.processingStatus,
          details: {
            reason: reason || null,
            batchSize: tasks.length,
            expiredAtAssignment:
              task.order.status === 'payment_expired' || getOfficialDeadline(task.order) <= now,
          },
          idempotencyKey: buildAssignmentEventKey(idempotencyKey, task.id),
        },
        { transaction }
      );
    }
    if (addedCount > 0) {
      setting.lastAssignedAt = now;
      await setting.save({ transaction });
    }
  });

  const tasks = await PaymentTask.findAll({
    where: { id: { [Op.in]: taskIds } },
    include: [
      {
        model: Order,
        as: 'order',
        attributes: [
          'id',
          'orderNumber',
          'products',
          'status',
          'paymentStatus',
          'paymentMethod',
          'officialOrderAmount',
          'officialOrderAmountCurrency',
          'payerName',
          'payerVersion',
          'orderDate',
          'officialOrderCreatedAt',
          'officialPaymentExpiresAt',
          'officialStatusNeedsReview',
          'officialAllItemsTerminal',
          'validationIssues',
          'lastCrawledAt',
          'updatedAt',
        ],
      },
      { model: User, as: 'assignee', paranoid: false, attributes: ['id', 'username'] },
    ],
    order: [['id', 'ASC']],
  });
  return { count: tasks.length, items: tasks.map(task => serializeTask(task)) };
}

/**
 * 兼容单项分配入口。
 * @param {number} taskId - 任务 ID
 * @param {Object} input - 分配参数
 * @param {number} actorUserId - 管理员 ID
 * @returns {Promise<Object>} 分配后任务
 */
async function assignTask(taskId, input, actorUserId) {
  const result = await assignTasks(
    {
      ...input,
      tasks: [{ id: taskId, expectedVersion: input.expectedVersion }],
    },
    actorUserId
  );
  return result.items[0];
}

/**
 * 重开已完成任务为异常，保留原负责人。
 * @param {number} taskId - 任务 ID
 * @param {Object} input - 重开参数
 * @param {number} actorUserId - 管理员 ID
 * @returns {Promise<Object>} 重开后任务
 */
async function reopenTask(taskId, input, actorUserId) {
  const expectedVersion = validateExpectedVersion(input.expectedVersion);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const reason = String(input.reason || '').trim();
  if (!reason || reason.length > 500)
    throw ApiError.badRequest('重开 reason 长度必须在 1-500 之间');
  return await sequelize.transaction(async transaction => {
    await lockDispatch(transaction);
    const task = await PaymentTask.findByPk(taskId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!task) throw ApiError.notFound('付款任务不存在');
    if (task.version !== expectedVersion) {
      throw ApiError.conflict(
        '任务已被更新',
        { currentVersion: task.version },
        'CONCURRENT_MODIFICATION'
      );
    }
    if (task.processingStatus !== 'completed') {
      throw ApiError.conflict('只能重开已完成任务', undefined, 'INVALID_STATE');
    }
    const beforeNotes = task.processingNotes;
    task.processingStatus = 'exception';
    task.processingNotes = reason;
    task.completedAt = null;
    task.version += 1;
    await task.save({ transaction });
    await PaymentTaskEvent.create(
      {
        paymentTaskId: task.id,
        eventType: 'reopened',
        actorUserId,
        beforeStatus: 'completed',
        afterStatus: 'exception',
        details: { reason, beforeNotes },
        idempotencyKey,
      },
      { transaction }
    );
    return task;
  });
}

/** 查询管理员付款队列，先筛选再按稳定顺序分页。 */
async function listDispatchTasks(query = {}) {
  try {
    const where = {};
    const orderWhere = {};
    if (query.assignee === 'unassigned') where.assigneeUserId = null;
    else if (query.assignee) {
      const assigneeUserId = Number(query.assignee);
      if (!Number.isInteger(assigneeUserId) || assigneeUserId <= 0) {
        throw ApiError.badRequest('assignee 必须是正整数或 unassigned');
      }
      where.assigneeUserId = assigneeUserId;
    }
    if (query.processingStatus) {
      if (!['pending', 'processing', 'completed', 'exception'].includes(query.processingStatus)) {
        throw ApiError.badRequest('processingStatus 非法');
      }
      where.processingStatus = query.processingStatus;
    }
    const orderNumber = String(query.orderNumber || '').trim();
    if (orderNumber) {
      if (orderNumber.length > 20) throw ApiError.badRequest('orderNumber 过长');
      orderWhere.orderNumber = { [Op.iLike]: `%${orderNumber}%` };
    }
    const productKeyword = String(query.productKeyword || '').trim();
    if (productKeyword) {
      if (productKeyword.length > 100) throw ApiError.badRequest('productKeyword 过长');
      const pattern = sequelize.escape(`%${productKeyword}%`);
      orderWhere[Op.and] = [
        Sequelize.literal(
          'EXISTS (SELECT 1 FROM jsonb_array_elements("order"."products") AS item ' +
            `WHERE item->>'name' ILIKE ${pattern} OR item->>'model' ILIKE ${pattern})`
        ),
      ];
    }
    if (query.officialOrderStatus) {
      if (!ORDER_STATUSES.includes(query.officialOrderStatus)) {
        throw ApiError.badRequest('officialOrderStatus 非法');
      }
      orderWhere.status = query.officialOrderStatus;
    }
    const page = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isInteger(page) || page <= 0 || page > 100000) {
      throw ApiError.badRequest('page 必须是 1-100000 之间的整数');
    }
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
      throw ApiError.badRequest('limit 必须是 1-200 之间的整数');
    }
    const { count, rows } = await PaymentTask.findAndCountAll({
      where,
      include: [
        {
          model: Order,
          as: 'order',
          attributes: [
            'id',
            'orderNumber',
            'products',
            'status',
            'paymentStatus',
            'paymentMethod',
            'officialOrderAmount',
            'officialOrderAmountCurrency',
            'payerName',
            'payerVersion',
            'orderDate',
            'officialOrderCreatedAt',
            'officialPaymentExpiresAt',
            'officialStatusNeedsReview',
            'officialAllItemsTerminal',
            'validationIssues',
            'lastCrawledAt',
            'updatedAt',
          ],
          where: orderWhere,
        },
        { model: User, as: 'assignee', paranoid: false, attributes: ['id', 'username'] },
      ],
      order: [
        ['deadlineAt', 'ASC'],
        ['id', 'ASC'],
      ],
      distinct: true,
      limit,
      offset: (page - 1) * limit,
    });
    const serverTime = new Date();
    return {
      items: rows.map(task => serializeTask(task, serverTime)),
      pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
      serverTime,
    };
  } catch (error) {
    if (!(error instanceof ApiError))
      logger.error('查询付款调度列表失败', { error: error.message });
    throw error;
  }
}

function normalizeTaskIds(taskIds) {
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > 100) {
    throw ApiError.badRequest('taskIds 必须是 1-100 个任务 ID 的数组');
  }
  const normalized = [...new Set(taskIds.map(id => Number(id)))];
  if (normalized.some(id => !Number.isInteger(id) || id <= 0)) {
    throw ApiError.badRequest('taskIds 包含无效任务 ID');
  }
  return normalized;
}

/**
 * 为管理员选中的付款任务提交官网刷新队列。
 * @param {number[]} taskIds - 付款任务 ID
 * @param {number} actorUserId - 管理员 ID
 * @returns {Promise<Object>} 入队汇总
 */
async function refreshTasks(taskIds, actorUserId) {
  const normalizedIds = normalizeTaskIds(taskIds);
  const tasks = await PaymentTask.findAll({
    where: { id: { [Op.in]: normalizedIds } },
    attributes: ['id', 'orderId'],
    order: [['id', 'ASC']],
  });
  if (tasks.length !== normalizedIds.length) throw ApiError.notFound('部分付款任务不存在');
  return refreshJobService.enqueueMany(
    tasks.map(task => task.orderId),
    { trigger: 'manual_single', requestedBy: actorUserId }
  );
}

/**
 * 为单个付款任务提交官网刷新队列。
 * @param {number} taskId - 付款任务 ID
 * @param {number} actorUserId - 管理员 ID
 * @returns {Promise<Object>} 入队汇总
 */
async function refreshTask(taskId, actorUserId) {
  return await refreshTasks([taskId], actorUserId);
}

/**
 * 扫描新订单并在 auto 模式下按负载比自动分配。
 * @param {number} [limit=500] - 单次扫描上限
 * @returns {Promise<Object>} 扫描结果
 */
async function runDispatchScan(limit = 500) {
  return await sequelize.transaction(async transaction => {
    await lockDispatch(transaction);
    const settings = await getOrCreateSettings(transaction);
    await settings.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (!settings.enabled) return { enrolled: 0, assigned: 0, skipped: 'disabled' };
    const orders = await Order.findAll({
      where: {
        createdAt: { [Op.gte]: settings.scopeStartedAt },
        '$paymentTask.id$': null,
      },
      attributes: [
        'id',
        'createdAt',
        'status',
        'paymentStatus',
        'orderUrl',
        'orderDate',
        'officialOrderCreatedAt',
        'officialPaymentExpiresAt',
        'officialStatusNeedsReview',
        'officialAllItemsTerminal',
        'validationIssues',
      ],
      include: [{ model: PaymentTask, as: 'paymentTask', required: false, attributes: ['id'] }],
      order: [['id', 'ASC']],
      limit,
      subQuery: false,
      transaction,
    });
    let enrolled = 0;
    for (const order of orders) {
      if (!order.paymentTask && !isOrderExcluded(order)) {
        await enrollOrderInTransaction(order, transaction);
        enrolled += 1;
      }
    }
    if (settings.mode !== 'auto') {
      settings.lastScanAt = new Date();
      await settings.save({ transaction });
      return { enrolled, assigned: 0, skipped: 'manual_mode' };
    }

    const tasks = await PaymentTask.findAll({
      where: {
        assigneeUserId: null,
        processingStatus: 'pending',
        deadlineAt: { [Op.gt]: new Date() },
        paymentLinkSource: 'order_url',
      },
      include: [
        {
          model: Order,
          as: 'order',
          attributes: [
            'status',
            'paymentStatus',
            'orderDate',
            'officialOrderCreatedAt',
            'officialPaymentExpiresAt',
            'officialStatusNeedsReview',
            'officialAllItemsTerminal',
            'validationIssues',
          ],
          where: {
            [Op.or]: [
              { officialPaymentExpiresAt: { [Op.ne]: null } },
              { officialOrderCreatedAt: { [Op.ne]: null } },
            ],
          },
        },
      ],
      order: [
        ['deadlineAt', 'ASC'],
        ['id', 'ASC'],
      ],
      limit,
      transaction,
      lock: { level: transaction.LOCK.UPDATE, of: PaymentTask },
      skipLocked: true,
    });
    const staff = await PaymentStaffSetting.findAll({
      where: { autoAssignEnabled: true, maxActiveTasks: { [Op.gt]: 0 } },
      include: [
        {
          model: User,
          as: 'user',
          required: true,
          where: { status: 'active' },
          include: [
            { model: UserPermission, as: 'permissionGrants', attributes: ['permissionCode'] },
          ],
        },
      ],
      transaction,
      lock: { level: transaction.LOCK.UPDATE, of: PaymentStaffSetting },
    });
    const activeCounts = await PaymentTask.findAll({
      where: {
        assigneeUserId: { [Op.in]: staff.map(row => row.userId) },
        processingStatus: { [Op.in]: ACTIVE_PAYMENT_TASK_STATUSES },
      },
      attributes: ['assigneeUserId', [fn('COUNT', col('id')), 'activeCount']],
      group: ['assigneeUserId'],
      raw: true,
      transaction,
    });
    const counts = new Map(
      activeCounts.map(row => [Number(row.assigneeUserId), Number(row.activeCount)])
    );
    const candidates = staff
      .filter(
        row =>
          row.user.role === 'admin' ||
          PAYMENT_EXECUTION_PERMISSIONS.every(code =>
            row.user.permissionGrants.some(grant => grant.permissionCode === code)
          )
      )
      .map(row => ({ setting: row, activeCount: counts.get(row.userId) || 0 }));
    let assigned = 0;
    for (const task of tasks) {
      const currentDeadline = getOfficialDeadline(task.order);
      if (isOrderExcluded(task.order) || !currentDeadline || currentDeadline <= new Date())
        continue;
      candidates.sort((a, b) => {
        const ratioDifference =
          a.activeCount / a.setting.maxActiveTasks - b.activeCount / b.setting.maxActiveTasks;
        if (ratioDifference) return ratioDifference;
        const aTime = a.setting.lastAssignedAt ? new Date(a.setting.lastAssignedAt).getTime() : 0;
        const bTime = b.setting.lastAssignedAt ? new Date(b.setting.lastAssignedAt).getTime() : 0;
        return aTime - bTime || a.setting.userId - b.setting.userId;
      });
      const candidate = candidates.find(row => row.activeCount < row.setting.maxActiveTasks);
      if (!candidate) break;
      const now = new Date();
      task.assigneeUserId = candidate.setting.userId;
      task.assignedAt = now;
      task.version += 1;
      await task.save({ transaction });
      candidate.activeCount += 1;
      candidate.setting.lastAssignedAt = now;
      await candidate.setting.save({ transaction });
      await PaymentTaskEvent.create(
        {
          paymentTaskId: task.id,
          eventType: 'auto_assigned',
          toUserId: candidate.setting.userId,
          beforeStatus: 'pending',
          afterStatus: 'pending',
          details: { loadAfterAssignment: candidate.activeCount },
        },
        { transaction }
      );
      assigned += 1;
    }
    settings.lastScanAt = new Date();
    settings.lastErrorCode = null;
    await settings.save({ transaction });
    return { enrolled, assigned, scannedTasks: tasks.length };
  });
}

module.exports = {
  enrollOrderInTransaction,
  getDispatchOverview,
  updateDispatchSettings,
  updateStaffSettings,
  updateStaffSettingsBatch,
  assignTasks,
  assignTask,
  refreshTasks,
  refreshTask,
  reopenTask,
  listDispatchTasks,
  runDispatchScan,
};
