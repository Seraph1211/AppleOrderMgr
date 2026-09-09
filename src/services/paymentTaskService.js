const { Op, Sequelize } = require('sequelize');
const {
  sequelize,
  PaymentTask,
  PaymentTaskEvent,
  OrderPayerEvent,
  OrderRefreshJob,
  Order,
  User,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { serializePublicProducts } = require('../utils/orderSerialization');
const { getOfficialDeadline } = require('./crawler/officialOrderData');
const refreshJobService = require('./crawler/refreshJobService');
const { normalizePayerName, updateLockedOrderPayer } = require('./payerService');

const PAYMENT_TASK_STATUSES = Object.freeze(['pending', 'processing', 'completed', 'exception']);
const ACTIVE_PAYMENT_TASK_STATUSES = Object.freeze(['pending', 'processing', 'exception']);
const STATUS_TRANSITIONS = Object.freeze({
  pending: ['processing', 'completed', 'exception'],
  processing: ['completed', 'exception'],
  exception: ['processing', 'completed'],
  completed: [],
});

function parsePositiveInteger(value, fieldName, defaultValue, maximum = 100000) {
  const number = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > maximum) {
    throw ApiError.badRequest(`${fieldName} 必须是 1-${maximum} 之间的整数`);
  }
  return number;
}

function validateNotes(value) {
  if (value === null || value === undefined) return null;
  const notes = String(value).trim();
  if (notes.length > 2000) throw ApiError.badRequest('processingNotes 不能超过 2000 字');
  return notes || null;
}

function taskAttributes() {
  return [
    'id',
    'orderId',
    'assigneeUserId',
    'processingStatus',
    'processingNotes',
    'deadlineAt',
    'deadlineSource',
    'eligibilityVerifiedAt',
    'eligibilityValidUntil',
    'paymentLinkSource',
    'assignedAt',
    'completedAt',
    'version',
    'createdAt',
    'updatedAt',
  ];
}

function includeTaskRelations() {
  return [
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
        'lastCrawledAt',
        'updatedAt',
      ],
    },
    { model: User, as: 'assignee', attributes: ['id', 'username'] },
  ];
}

function serializeTask(task, serverTime = new Date()) {
  const plain = task.toJSON();
  const deadline = getOfficialDeadline(plain.order);
  const remainingSeconds = deadline
    ? Math.floor((deadline.getTime() - serverTime.getTime()) / 1000)
    : null;
  const latestUpdatedAt = [plain.updatedAt, plain.order?.updatedAt]
    .filter(Boolean)
    .map(value => new Date(value))
    .sort((left, right) => right.getTime() - left.getTime())[0];
  return {
    id: plain.id,
    orderId: plain.orderId,
    orderNumber: plain.order?.orderNumber,
    products: serializePublicProducts(plain.order?.products),
    officialOrderStatus: plain.order?.status || null,
    officialPaymentStatus: plain.order?.paymentStatus || null,
    officialPaymentConfirmed: plain.order?.paymentStatus === 'paid',
    officialPaymentDiscrepancy:
      plain.order?.paymentStatus === 'paid' && plain.processingStatus !== 'completed',
    paymentMethod: plain.order?.paymentMethod || null,
    officialOrderAmount: plain.order?.officialOrderAmount ?? null,
    officialOrderAmountCurrency: plain.order?.officialOrderAmountCurrency || null,
    lastCrawledAt: plain.order?.lastCrawledAt || null,
    orderDate: plain.order?.orderDate || null,
    officialOrderCreatedAt: plain.order?.officialOrderCreatedAt || null,
    assignee: plain.assignee || null,
    processingStatus: plain.processingStatus,
    processingNotes: plain.processingNotes,
    payerName: plain.order?.payerName || null,
    payerVersion: plain.order?.payerVersion || 0,
    deadlineAt: deadline,
    deadlineSource: deadline ? 'official' : null,
    remainingSeconds,
    eligibilityVerifiedAt: plain.eligibilityVerifiedAt,
    eligibilityValidUntil: plain.eligibilityValidUntil,
    paymentLinkSource: plain.paymentLinkSource,
    assignedAt: plain.assignedAt,
    completedAt: plain.completedAt,
    version: plain.version,
    createdAt: plain.createdAt,
    updatedAt: latestUpdatedAt || plain.updatedAt,
  };
}

function buildProductCondition(query) {
  const keyword = String(query.productKeyword || '').trim();
  const model = String(query.productModel || '').trim();
  if (keyword.length > 100 || model.length > 50) {
    throw ApiError.badRequest('商品筛选条件过长');
  }
  if (!keyword && !model) return null;
  const clauses = [];
  if (keyword) {
    const pattern = sequelize.escape(`%${keyword}%`);
    clauses.push(`(item->>'name' ILIKE ${pattern} OR item->>'model' ILIKE ${pattern})`);
  }
  if (model) {
    clauses.push(`item->>'model' = ${sequelize.escape(model)}`);
  }
  return Sequelize.literal(
    `EXISTS (SELECT 1 FROM jsonb_array_elements("order"."products") AS item WHERE ${clauses.join(' AND ')})`
  );
}

/**
 * 查询当前用户的付款任务。
 * @param {number} userId - 用户 ID
 * @param {Object} query - 筛选条件
 * @returns {Promise<Object>} 分页任务
 */
async function listOwnTasks(userId, query = {}) {
  const page = parsePositiveInteger(query.page, 'page', 1);
  const limit = parsePositiveInteger(query.limit, 'limit', 20, 100);
  const where = { assigneeUserId: userId };
  if (query.processingStatus) {
    if (!PAYMENT_TASK_STATUSES.includes(query.processingStatus)) {
      throw ApiError.badRequest('processingStatus 非法');
    }
    where.processingStatus = query.processingStatus;
  } else {
    where.processingStatus = { [Op.in]: ACTIVE_PAYMENT_TASK_STATUSES };
  }
  const orderWhere = {};
  const orderNumber = String(query.orderNumber || '').trim();
  if (orderNumber) {
    if (orderNumber.length > 20) throw ApiError.badRequest('orderNumber 过长');
    orderWhere.orderNumber = { [Op.iLike]: `%${orderNumber}%` };
  }
  const productCondition = buildProductCondition(query);
  if (productCondition) orderWhere[Op.and] = [productCondition];

  const serverTime = new Date();
  const include = includeTaskRelations();
  include[0].where = orderWhere;
  const { count, rows } = await PaymentTask.findAndCountAll({
    where,
    attributes: taskAttributes(),
    include,
    distinct: true,
    order: [
      [Sequelize.literal('CASE WHEN "deadline_at" IS NULL THEN 1 ELSE 0 END'), 'ASC'],
      ['deadlineAt', 'ASC'],
      ['id', 'ASC'],
    ],
    limit,
    offset: (page - 1) * limit,
  });
  return {
    items: rows.map(row => serializeTask(row, serverTime)),
    pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
    serverTime,
  };
}

/**
 * 读取当前用户的任务详情。
 * @param {number} taskId - 任务 ID
 * @param {number} userId - 用户 ID
 * @returns {Promise<Object>} 任务详情
 */
async function getOwnTask(taskId, userId) {
  const task = await PaymentTask.findOne({
    where: { id: taskId, assigneeUserId: userId },
    attributes: taskAttributes(),
    include: includeTaskRelations(),
  });
  if (!task) throw ApiError.notFound('付款任务不存在或已转派');
  return serializeTask(task);
}

/**
 * 原子更新本人任务四态、备注和／或订单付款人。
 * @param {number} taskId - 任务 ID
 * @param {Object} input - 更新内容
 * @param {number} userId - 当前用户 ID
 * @param {Object} [capabilities] - 当前请求的动作权限
 * @param {boolean} [capabilities.canHandle=true] - 可更新状态与备注
 * @param {boolean} [capabilities.canEditPayer=true] - 可更新付款人
 * @returns {Promise<Object>} 更新后任务
 */
async function updateOwnTask(
  taskId,
  input,
  userId,
  capabilities = { canHandle: true, canEditPayer: true }
) {
  const hasInput = field => Object.prototype.hasOwnProperty.call(input, field);
  const updatesTask = hasInput('processingStatus') || hasInput('processingNotes');
  const updatesPayer = hasInput('payerName');
  if (!updatesTask && !updatesPayer) {
    throw ApiError.badRequest('至少提交一个实际修改字段');
  }
  if (updatesTask && !capabilities.canHandle) {
    throw new ApiError(403, 'FORBIDDEN', '当前账号无权修改处理状态或备注');
  }
  if (updatesPayer && !capabilities.canEditPayer) {
    throw new ApiError(403, 'FORBIDDEN', '当前账号无权修改付款人');
  }

  const expectedVersion = updatesTask ? Number(input.expectedVersion) : null;
  const expectedPayerVersion = updatesPayer ? Number(input.expectedPayerVersion) : null;
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (updatesTask && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
    throw ApiError.badRequest('expectedVersion 必须是非负整数');
  }
  if (updatesPayer && (!Number.isInteger(expectedPayerVersion) || expectedPayerVersion < 0)) {
    throw ApiError.badRequest('expectedPayerVersion 必须是非负整数');
  }
  if (!idempotencyKey || idempotencyKey.length > 100) {
    throw ApiError.badRequest('idempotencyKey 长度必须在 1-100 之间');
  }
  const targetStatus = input.processingStatus;
  if (targetStatus !== undefined && !PAYMENT_TASK_STATUSES.includes(targetStatus)) {
    throw ApiError.badRequest('processingStatus 非法');
  }
  const submittedNotes = hasInput('processingNotes')
    ? validateNotes(input.processingNotes)
    : undefined;
  const submittedPayerName = updatesPayer ? normalizePayerName(input.payerName) : undefined;

  await sequelize.transaction(async transaction => {
    const task = await PaymentTask.findOne({
      where: { id: taskId, assigneeUserId: userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!task) throw ApiError.notFound('付款任务不存在或已转派');

    const order = await Order.findByPk(task.orderId, {
      attributes: ['id', 'paymentStatus', 'payerName', 'payerVersion'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw ApiError.notFound('关联订单不存在');

    const taskReplay = await PaymentTaskEvent.findOne({
      where: { actorUserId: userId, idempotencyKey },
      transaction,
    });
    const payerReplay = await OrderPayerEvent.findOne({
      where: { actorUserId: userId, idempotencyKey },
      transaction,
    });
    const replayTaskFieldsMatch =
      !updatesTask ||
      (task.processingStatus === (targetStatus || task.processingStatus) &&
        task.processingNotes ===
          (submittedNotes === undefined ? task.processingNotes : submittedNotes));
    const replayPayerFieldMatches = !updatesPayer || order.payerName === submittedPayerName;
    if (taskReplay || payerReplay) {
      if (
        (taskReplay && Number(taskReplay.paymentTaskId) !== Number(taskId)) ||
        (payerReplay && Number(payerReplay.orderId) !== Number(task.orderId)) ||
        (updatesTask && !taskReplay && !replayTaskFieldsMatch) ||
        (updatesPayer && !payerReplay && !replayPayerFieldMatches)
      ) {
        throw ApiError.conflict('幂等键已用于其他任务', undefined, 'IDEMPOTENCY_CONFLICT');
      }
      return;
    }

    if (updatesTask && task.version !== expectedVersion) {
      throw ApiError.conflict(
        '任务已被更新',
        { currentVersion: task.version },
        'CONCURRENT_MODIFICATION'
      );
    }
    if (
      targetStatus !== undefined &&
      targetStatus !== task.processingStatus &&
      !STATUS_TRANSITIONS[task.processingStatus].includes(targetStatus)
    ) {
      throw ApiError.conflict(
        '任务状态迁移不允许',
        {
          from: task.processingStatus,
          to: targetStatus,
        },
        'INVALID_STATE'
      );
    }
    const nextStatus = targetStatus || task.processingStatus;
    const nextNotes = submittedNotes === undefined ? task.processingNotes : submittedNotes;
    if (
      updatesTask &&
      (nextStatus === 'exception' ||
        (task.processingStatus === 'exception' && nextStatus !== 'exception') ||
        (nextStatus === 'completed' && order.paymentStatus !== 'paid')) &&
      !nextNotes
    ) {
      throw ApiError.badRequest('异常、异常恢复或官网未确认时必须填写处理备注');
    }
    const beforeStatus = task.processingStatus;
    const beforeNotes = task.processingNotes;
    const taskChanged = updatesTask && (beforeStatus !== nextStatus || beforeNotes !== nextNotes);
    if (taskChanged) {
      task.processingStatus = nextStatus;
      task.processingNotes = nextNotes;
      task.completedAt = nextStatus === 'completed' ? task.completedAt || new Date() : null;
      task.version += 1;
      await task.save({ transaction });
      await PaymentTaskEvent.create(
        {
          paymentTaskId: task.id,
          eventType: beforeStatus === nextStatus ? 'notes_updated' : 'status_updated',
          actorUserId: userId,
          beforeStatus,
          afterStatus: nextStatus,
          details: { beforeNotes, afterNotes: task.processingNotes },
          idempotencyKey,
        },
        { transaction }
      );
    }

    if (updatesPayer) {
      await updateLockedOrderPayer(
        order,
        {
          payerName: submittedPayerName,
          expectedVersion: expectedPayerVersion,
          idempotencyKey,
          reason: input.payerReason,
        },
        userId,
        transaction
      );
    }
  });
  return getOwnTask(taskId, userId);
}

/**
 * 复制本人任务关联订单的订单链接。
 * @param {number} taskId - 任务 ID
 * @param {number} userId - 用户 ID
 * @returns {Promise<Object>} 订单链接和服务端时间
 */
async function getOwnPaymentLink(taskId, userId) {
  const task = await PaymentTask.findOne({
    where: { id: taskId, assigneeUserId: userId },
    include: [
      {
        model: Order,
        as: 'order',
        attributes: ['orderUrl'],
      },
    ],
  });
  if (!task) throw ApiError.notFound('付款任务不存在或已转派');
  if (!task.order?.orderUrl) throw ApiError.notFound('订单链接不存在');
  const now = new Date();
  const paymentUrl = task.order.orderUrl;
  await PaymentTaskEvent.create({
    paymentTaskId: task.id,
    eventType: 'payment_link_accessed',
    actorUserId: userId,
    beforeStatus: task.processingStatus,
    afterStatus: task.processingStatus,
    details: { accessedAt: now.toISOString() },
  });
  return { paymentUrl, serverTime: now, deadlineAt: task.deadlineAt };
}

/**
 * 为本人任务提交订单官网刷新队列。
 * @param {number} taskId - 任务 ID
 * @param {number} userId - 用户 ID
 * @returns {Promise<Object>} 入队结果
 */
async function refreshOwnTask(taskId, userId) {
  const task = await PaymentTask.findOne({ where: { id: taskId, assigneeUserId: userId } });
  if (!task) throw ApiError.notFound('付款任务不存在或已转派');
  const result = await refreshJobService.enqueueOrderRefresh(task.orderId, {
    trigger: 'manual_single',
    requestedBy: userId,
  });
  if (!result.job) throw ApiError.notFound('关联订单不存在');
  return {
    jobId: result.job.id,
    status: result.job.status,
    created: result.created,
    merged: !result.created,
  };
}

/**
 * 查询本人任务关联订单的刷新任务状态。
 * @param {number} taskId - 付款任务 ID
 * @param {number} jobId - 刷新任务 ID
 * @param {number} userId - 当前用户 ID
 * @returns {Promise<Object>} 非敏感刷新进度
 */
async function getOwnRefreshJob(taskId, jobId, userId) {
  const task = await PaymentTask.findOne({
    where: { id: taskId, assigneeUserId: userId },
    attributes: ['id', 'orderId'],
  });
  if (!task) throw ApiError.notFound('付款任务不存在或已转派');
  const job = await OrderRefreshJob.findOne({
    where: { id: jobId, orderId: task.orderId },
    include: [{ model: Order, as: 'order', attributes: ['lastCrawledAt'] }],
  });
  if (!job) throw ApiError.notFound('刷新任务不存在或不属于当前任务');
  return {
    id: job.id,
    status: job.status,
    attemptCount: job.attemptCount,
    lastErrorCode: job.lastErrorCode,
    lastErrorMessage: job.lastErrorMessage,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastCrawledAt: job.order?.lastCrawledAt || null,
  };
}

module.exports = {
  PAYMENT_TASK_STATUSES,
  ACTIVE_PAYMENT_TASK_STATUSES,
  serializeTask,
  listOwnTasks,
  getOwnTask,
  updateOwnTask,
  getOwnPaymentLink,
  refreshOwnTask,
  getOwnRefreshJob,
};
