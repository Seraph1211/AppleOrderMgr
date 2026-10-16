const { getProductDisplayName, expandProductNameAliases } = require('../utils/productNaming');
const {
  recipientTagSql,
  recipientTagAttributes,
  getRecipientTag,
  getRecipientTagState,
  getRecipientTagSource,
  getOrderRecipientName,
} = require('./recipientTagService');
const { scopeOrderWhere, assertCurrentOrderAccess } = require('./orderAccessService');
const { getSourcePaymentMethod } = require('../utils/paymentMethod');
const { parseProductKeys, productKeySql } = require('../utils/productFilterQuery');
const { collectOfficialStatusOptions } = require('../utils/officialStatusFilter');
const { collectProductOptions } = require('../utils/productFilter');
const { buildOrderDateCondition } = require('../utils/orderDateFilter');
const logger = require('../utils/logger');
const {
  buildEmailStatusCondition,
  buildPaymentOfficialStatusCondition,
} = require('./paymentStatusFilter');
const { Op, Sequelize } = require('sequelize');
const {
  sequelize,
  PaymentTask,
  PaymentTaskEvent,
  OrderPayerEvent,
  Order,
  User,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { serializePublicProducts, serializeOrderPricing } = require('../utils/orderSerialization');
const { getPaymentDeadline } = require('./paymentEligibility');
const { normalizePayerName, updateLockedOrderPayer } = require('./payerService');

const PAYMENT_TASK_STATUSES = Object.freeze(['pending', 'processing', 'completed', 'exception']);
const ACTIVE_PAYMENT_TASK_STATUSES = Object.freeze(['pending', 'processing', 'exception']);
const RECIPIENT_TAG_EXPRESSION = recipientTagSql('order');
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
    [
      Sequelize.literal(`(SELECT j.state FROM official_order_refresh_jobs j
      WHERE j.order_id="PaymentTask".order_id AND j.state IN ('queued','running')
      ORDER BY j.created_at LIMIT 1)`),
      'officialRefreshState',
    ],
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
        'ingestionSource',
        'sourceRecipientTag',
        ...recipientTagAttributes(),
        'tag',
        'products',
        'productFilterItems',
        'officialRawStatus',
        'officialStatusObservedAt',
        'emailOrderStatus',
        'emailPaymentStatus',
        'emailStatusNeedsReview',
        'emailStatusEvidenceAt',
        'emailLifecycleUpdatedAt',
        'emailPickupInfo',
        'paymentAssignmentHoldReason',
        'paymentMethod',
        'sourceSnapshot',
        'orderAmount',
        'orderAmountPriceVersion',
        'payerName',
        'payerVersion',
        'orderDate',
        'updatedAt',
      ],
    },
    { model: User, as: 'assignee', paranoid: false, attributes: ['id', 'username', 'nickname'] },
  ];
}

/**
 * 构造当前取机人 TAG 的精确筛选条件。
 * @param {*} value - 查询参数中的单个 TAG 或 TAG 数组 JSON
 * @returns {Object|null} Sequelize where 条件
 */
function buildRecipientTagCondition(value) {
  if (value === null || value === undefined || value === '') return null;
  let values = value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      values = JSON.parse(value);
    } catch (_error) {
      throw ApiError.badRequest('recipientTags 必须是合法数组');
    }
  }
  if (!Array.isArray(values)) values = [values];
  if (values.length > 100) throw ApiError.badRequest('recipientTags 最多选择 100 项');
  if (values.some(item => typeof item !== 'string'))
    throw ApiError.badRequest('recipientTags 每项必须是字符串');
  const recipientTags = [
    ...new Set(values.filter(item => typeof item === 'string' && item.trim())),
  ];
  if (recipientTags.some(item => item.length > 500)) {
    throw ApiError.badRequest('recipientTags 每项不能超过 500 字符');
  }
  if (recipientTags.length === 0) return null;
  return Sequelize.where(Sequelize.literal(RECIPIENT_TAG_EXPRESSION), {
    [Op.in]: recipientTags,
  });
}

/**
 * 查询当前筛选范围内可用的订单 TAG，不受已选 TAG 限制。
 * @param {Object} taskWhere - 付款任务条件
 * @param {Object} orderWhere - 订单条件
 * @returns {Promise<string[]>} 去重排序后的 TAG
 */
async function listRecipientTagOptions(taskWhere, orderWhere) {
  const rows = await PaymentTask.findAll({
    where: taskWhere,
    attributes: [[Sequelize.literal(RECIPIENT_TAG_EXPRESSION), 'recipientTag']],
    include: [{ model: Order, as: 'order', attributes: [], where: orderWhere, required: true }],
    group: [Sequelize.literal(RECIPIENT_TAG_EXPRESSION)],
    order: [[Sequelize.literal(RECIPIENT_TAG_EXPRESSION), 'ASC']],
    raw: true,
  });
  return rows.map(row => row.recipientTag).filter(Boolean);
}

/** 读取完整本人／调度任务范围内的官网状态候选，忽略当前状态选择与分页。 */
async function listOfficialStatusOptions(taskWhere, orderWhere) {
  try {
    const rows = await PaymentTask.findAll({
      where: taskWhere,
      attributes: [[Sequelize.col('order.official_raw_status'), 'officialRawStatus']],
      include: [{ model: Order, as: 'order', attributes: [], where: orderWhere, required: true }],
      group: [Sequelize.col('order.official_raw_status')],
      raw: true,
    });
    return collectOfficialStatusOptions(rows);
  } catch (error) {
    logger.error('查询付款官网状态候选失败', { errorType: error.name });
    throw error;
  }
}

/**
 * 查询当前筛选范围内可用的完整商品名称，不受已选商品限制。
 * @param {Object} taskWhere - 付款任务条件
 * @param {Object} orderWhere - 不含商品条件的订单条件
 * @param {boolean} detailed 是否同时返回稳定候选及旧名称
 * @returns {Promise<Array|Object>} 权限范围内的候选
 */
async function listProductNameOptions(taskWhere, orderWhere, detailed = false) {
  try {
    const rows = await PaymentTask.findAll({
      where: taskWhere,
      attributes: ['id'],
      include: [
        {
          model: Order,
          as: 'order',
          attributes: ['products', 'productFilterItems'],
          where: orderWhere,
          required: true,
        },
      ],
    });
    const productNames = new Set();
    for (const row of rows) {
      for (const product of Array.isArray(row.order?.products) ? row.order.products : []) {
        const name = getProductDisplayName(product);
        if (name) productNames.add(name);
      }
    }
    const names = [...productNames].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    if (detailed)
      return {
        productOptions: collectProductOptions(rows.map(row => row.order)),
        productNameOptions: names,
      };
    return names;
  } catch (error) {
    logger.error('查询商品筛选候选失败', { error: error.message });
    throw error;
  }
}

function serializeTask(task, serverTime = new Date()) {
  const plain = task.toJSON();
  const deadline = getPaymentDeadline(plain.order);
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
    recipientName: getOrderRecipientName(plain.order),
    recipientTag: getRecipientTag(plain.order),
    recipientTagState: getRecipientTagState(plain.order),
    recipientTagSource: getRecipientTagSource(plain.order),
    products: serializePublicProducts(plain.order?.products, plain.order?.productFilterItems),
    officialRefreshState: plain.officialRefreshState || null,
    officialRawStatus: plain.order?.officialRawStatus || null,
    officialStatusObservedAt: plain.order?.officialStatusObservedAt || null,
    emailOrderStatus: plain.order?.emailOrderStatus || 'unknown',
    emailPaymentStatus: plain.order?.emailPaymentStatus || 'unknown',
    emailPaymentConfirmed: plain.order?.emailPaymentStatus === 'paid',
    emailStatusNeedsReview: Boolean(plain.order?.emailStatusNeedsReview),
    emailStatusEvidenceAt: plain.order?.emailStatusEvidenceAt || null,
    emailLifecycleUpdatedAt: plain.order?.emailLifecycleUpdatedAt || null,
    emailPickupInfo: plain.order?.emailPickupInfo || null,
    paymentAssignmentHoldReason: plain.order?.paymentAssignmentHoldReason || null,
    paymentMethod: getSourcePaymentMethod(plain.order),
    ...serializeOrderPricing(plain.order),
    orderDate: plain.order?.orderDate || null,
    assignee: plain.assignee || null,
    processingStatus: plain.processingStatus,
    processingNotes: plain.processingNotes,
    payerName: plain.order?.payerName || null,
    payerVersion: plain.order?.payerVersion || 0,
    deadlineAt: deadline,
    deadlineSource: deadline ? 'source_order' : null,
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

function parseProductNames(value) {
  if (value === null || value === undefined || value === '') return [];
  let values = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        values = JSON.parse(trimmed);
      } catch (_error) {
        throw ApiError.badRequest('productNames 必须是合法数组');
      }
    } else {
      values = [trimmed];
    }
  }
  if (!Array.isArray(values)) throw ApiError.badRequest('productNames 必须是合法数组');
  if (values.length > 100) throw ApiError.badRequest('productNames 最多选择 100 项');
  if (values.some(item => typeof item !== 'string')) {
    throw ApiError.badRequest('productNames 每项必须是字符串');
  }
  const normalized = [...new Set(values.map(item => item.trim()).filter(Boolean))];
  if (normalized.some(item => item.length > 500)) {
    throw ApiError.badRequest('productNames 每项不能超过 500 字符');
  }
  return normalized;
}

/**
 * 构造兼容完整商品名称多选、旧关键词和旧型号的同商品项筛选条件。
 * @param {Object} query - 付款任务或调度列表查询参数
 * @returns {Object|null} Sequelize 商品筛选条件
 */
function buildProductCondition(query) {
  const keys = parseProductKeys(query.productKeys);
  const productNames = parseProductNames(query.productNames);
  const keyword = String(query.productKeyword || '').trim();
  const model = String(query.productModel || '').trim();
  if (keyword.length > 100 || model.length > 50) {
    throw ApiError.badRequest('商品筛选条件过长');
  }
  if (keys.length === 0 && productNames.length === 0 && !keyword && !model) return null;
  const clauses = [];
  if (keys.length)
    clauses.push(
      productKeySql(
        keys,
        '"order"."product_filter_items"',
        value => sequelize.escape(value),
        'ordinality - 1'
      )
    );
  if (productNames.length > 0) {
    const escapedNames = expandProductNameAliases(productNames)
      .map(name => sequelize.escape(name))
      .join(', ');
    clauses.push(`item->>'name' IN (${escapedNames})`);
  }
  if (keyword) {
    const patterns = expandProductNameAliases([keyword]).map(alias => {
      const pattern = sequelize.escape(`%${alias}%`);
      return `(item->>'name' ILIKE ${pattern} OR item->>'model' ILIKE ${pattern})`;
    });
    clauses.push(`(${patterns.join(' OR ')})`);
  }
  if (model) {
    clauses.push(`item->>'model' = ${sequelize.escape(model)}`);
  }
  return Sequelize.literal(
    `EXISTS (SELECT 1 FROM jsonb_array_elements("order"."products") WITH ORDINALITY AS p(item, ordinality) WHERE ${clauses.join(' AND ')})`
  );
}

/**
 * 查询当前用户的付款任务。
 * @param {number} userId - 用户 ID
 * @param {Object} query - 筛选条件
 * @returns {Promise<Object>} 分页任务
 */
async function listOwnTasks(userId, query = {}) {
  try {
    const page = parsePositiveInteger(query.page, 'page', 1);
    const limit = parsePositiveInteger(query.limit, 'limit', 20, 100);
    const where = { assigneeUserId: userId };
    if (query.processingStatus) {
      if (!PAYMENT_TASK_STATUSES.includes(query.processingStatus)) {
        throw ApiError.badRequest('processingStatus 非法');
      }
      where.processingStatus = query.processingStatus;
    }
    const user = await User.findByPk(userId);
    if (!user || user.status !== 'active') throw ApiError.notFound('账号不可访问');
    const accessCondition = scopeOrderWhere(user, {}, 'order');
    const orderWhere = Reflect.ownKeys(accessCondition).length
      ? { [Op.or]: [accessCondition] }
      : {};
    const orderNumber = String(query.orderNumber || '').trim();
    if (orderNumber) {
      if (orderNumber.length > 20) throw ApiError.badRequest('orderNumber 过长');
      orderWhere.orderNumber = { [Op.iLike]: `%${orderNumber}%` };
    }
    const productCondition = buildProductCondition(query);
    const emailStatusCondition = buildEmailStatusCondition(query);
    if (emailStatusCondition) orderWhere.emailOrderStatus = emailStatusCondition;
    const orderDateCondition = buildOrderDateCondition(query);
    if (orderDateCondition) orderWhere.orderDate = orderDateCondition;
    const recipientTagCondition = buildRecipientTagCondition(
      query.recipientTags ?? query.recipientTag
    );
    const officialCondition = buildPaymentOfficialStatusCondition(query, sequelize, Sequelize);
    const officialOptionOrderWhere = { ...orderWhere };
    officialOptionOrderWhere[Op.and] = [productCondition, recipientTagCondition].filter(Boolean);
    const tagOptionOrderWhere = { ...orderWhere };
    tagOptionOrderWhere[Op.and] = [productCondition, officialCondition].filter(Boolean);
    const productOptionOrderWhere = { ...orderWhere };
    productOptionOrderWhere[Op.and] = [recipientTagCondition, officialCondition].filter(Boolean);
    const orderConditions = [productCondition, recipientTagCondition, officialCondition].filter(
      Boolean
    );
    if (orderConditions.length > 0) orderWhere[Op.and] = orderConditions;

    const serverTime = new Date();
    const include = includeTaskRelations();
    include[0].where = orderWhere;
    const [{ count, rows }, productCandidates, recipientTagOptions, officialOrderStatuses] =
      await Promise.all([
        PaymentTask.findAndCountAll({
          where,
          attributes: taskAttributes(),
          include,
          distinct: true,
          order: [
            [Sequelize.literal('CASE WHEN "order"."order_date" IS NULL THEN 1 ELSE 0 END'), 'ASC'],
            [Sequelize.literal('"order"."order_date"'), 'DESC'],
            ['id', 'DESC'],
          ],
          limit,
          offset: (page - 1) * limit,
        }),
        listProductNameOptions(where, productOptionOrderWhere, true),
        listRecipientTagOptions(where, tagOptionOrderWhere),
        listOfficialStatusOptions(where, officialOptionOrderWhere),
      ]);
    return {
      items: rows.map(row => serializeTask(row, serverTime)),
      ...productCandidates,
      recipientTagOptions,
      officialOrderStatuses,
      pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
      serverTime,
    };
  } catch (error) {
    logger.error('查询本人付款任务失败', { userId, error: error.message });
    throw error;
  }
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
  await assertCurrentOrderAccess(userId, [task.orderId]);
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
    await assertCurrentOrderAccess(userId, [task.orderId], { transaction });

    const order = await Order.findByPk(task.orderId, {
      attributes: ['id', 'payerName', 'payerVersion'],
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
        attributes: ['orderUrl', 'orderDate'],
      },
    ],
  });
  if (!task) throw ApiError.notFound('付款任务不存在或已转派');
  await assertCurrentOrderAccess(userId, [task.orderId]);
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
  return { paymentUrl, serverTime: now, deadlineAt: getPaymentDeadline(task.order) };
}

module.exports = {
  PAYMENT_TASK_STATUSES,
  ACTIVE_PAYMENT_TASK_STATUSES,
  buildRecipientTagCondition,
  buildProductCondition,
  listProductNameOptions,
  listRecipientTagOptions,
  listOfficialStatusOptions,
  serializeTask,
  listOwnTasks,
  getOwnTask,
  updateOwnTask,
  getOwnPaymentLink,
};
