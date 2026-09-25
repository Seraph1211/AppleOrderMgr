const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  Order,
  OrderMailMessage,
  OrderMailProcessingJob,
  OrderMailEvent,
  PaymentTask,
  PaymentTaskEvent,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { EMAIL_ORDER_STATUSES, PERMISSIONS } = require('../constants/business');
const logger = require('../utils/logger');
const { scopeOrderWhere } = require('./orderAccessService');
const { parseOrderMail } = require('./orderMailContent');
const { getOrderMailConfig } = require('./orderMailConfig');
const {
  RULE_VERSION,
  TEMPLATE_TYPES,
  evaluateProductScope,
  parseOrderMailLifecycle,
} = require('./orderMailLifecycleParser');

const MAX_ATTEMPTS = 5;
const MAX_REPLAY_ORDER_COUNT = 100;
const LEASE_MS = 60_000;
const RETRY_MS = 30_000;
const HTTP_FORBIDDEN = 403;
const ORDER_STATUS_SEQUENCE = Object.freeze([
  'unknown',
  'confirmed',
  'processing',
  'ready_for_pickup',
  'picked_up',
]);
const orderStatusRank = status => Math.max(0, ORDER_STATUS_SEQUENCE.indexOf(status));

/**
 * 以归档、解析及系统订单的完整订单号精确一致作为生命周期邮件来源条件。
 * @param {Object} message 归档邮件
 * @param {Object} parsedResult 生命周期解析结果
 * @param {Object|null} order 系统订单
 * @returns {Object} 订单号核对结论
 */
function verifyOrderNumberMatch(message, parsedResult, order) {
  const archivedOrderNumber = String(message?.orderNumber || '').trim();
  const parsedOrderNumber = String(parsedResult?.orderNumber || '').trim();
  const systemOrderNumber = String(order?.orderNumber || '').trim();
  const evidence = { method: 'order_number_match' };
  if (!archivedOrderNumber || !parsedOrderNumber || archivedOrderNumber !== parsedOrderNumber) {
    return { status: 'failed', reason: 'ORDER_NUMBER_MISMATCH', evidence };
  }
  if (!order) return { status: 'not_checked', reason: 'ORDER_NOT_AVAILABLE', evidence };
  if (systemOrderNumber !== parsedOrderNumber) {
    return { status: 'failed', reason: 'ORDER_NUMBER_MISMATCH', evidence };
  }
  return { status: 'verified', reason: null, evidence: { ...evidence, matched: true } };
}

function normalizeReplayOrderIds(orderIds) {
  if (
    !Array.isArray(orderIds) ||
    orderIds.length === 0 ||
    orderIds.length > MAX_REPLAY_ORDER_COUNT
  ) {
    throw ApiError.badRequest(`orderIds 必须是 1-${MAX_REPLAY_ORDER_COUNT} 个订单 ID 的数组`);
  }
  if (
    orderIds.some(
      id =>
        !/^[1-9][0-9]*$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0
    )
  ) {
    throw ApiError.badRequest('orderIds 包含无效订单 ID');
  }
  return [...new Set(orderIds.map(Number))];
}

/** 辅导邀请仅以精确订单号作为整单履约证据，其他模板继续核对商品范围。 */
function evaluateLifecycleScope(templateType, mailProducts, orderProducts) {
  if (templateType === TEMPLATE_TYPES.PERSONAL_SETUP) {
    return { matched: true, reason: null, evidence: 'not_required_personal_setup' };
  }
  const scope = evaluateProductScope(mailProducts, orderProducts);
  return { ...scope, evidence: scope.matched ? 'matched' : scope.reason };
}

/** 为新归档邮件幂等登记解析任务。 */
async function enqueueLifecycleJob(messageId, transaction) {
  try {
    return await OrderMailProcessingJob.findOrCreate({
      where: { messageId },
      defaults: {
        id: crypto.randomUUID(),
        messageId,
        status: 'pending',
        notBefore: new Date(),
      },
      transaction,
    });
  } catch (error) {
    logger.warn('订单邮件解析任务登记失败', { errorType: error.name });
    throw error;
  }
}

function claimLifecycleJob(config) {
  return sequelize.transaction(async transaction => {
    const now = new Date();
    const claimable = [{ status: 'pending', notBefore: { [Op.lte]: now } }];
    if (config.lifecycle.applyEnabled) claimable.push({ status: 'parsed' });
    if (config.lifecycle.paymentTaskApplyEnabled)
      claimable.push({ status: 'applied_pending_payment' });
    const job = await OrderMailProcessingJob.findOne({
      where: {
        [Op.or]: [...claimable, { status: 'processing', leaseExpiresAt: { [Op.lt]: now } }],
      },
      order: [['createdAt', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });
    if (!job) return null;
    job.status = 'processing';
    job.attempts += 1;
    job.leaseExpiresAt = new Date(Date.now() + LEASE_MS);
    job.lastErrorCode = null;
    job.completedAt = null;
    await job.save({ transaction });
    return job.toJSON();
  });
}

async function appendParserEvent(message, order, parsedResult, authentication, transaction) {
  const previous = await OrderMailEvent.max('revision', {
    where: { messageId: message.id },
    transaction,
  });
  const now = new Date();
  await OrderMailEvent.update(
    { supersededAt: now },
    {
      where: { messageId: message.id, source: 'parser', supersededAt: null },
      transaction,
    }
  );
  const scope = order
    ? evaluateLifecycleScope(parsedResult.templateType, parsedResult.products, order.products)
    : { matched: false, reason: 'ORDER_NOT_AVAILABLE' };
  const reviewReasons = [...parsedResult.reviewReasons];
  if (authentication.status === 'failed') reviewReasons.push(authentication.reason);
  if (order && parsedResult.templateType !== TEMPLATE_TYPES.EXCLUDED && !scope.matched)
    reviewReasons.push(scope.reason);
  const event = await OrderMailEvent.create(
    {
      id: crypto.randomUUID(),
      messageId: message.id,
      orderId: order?.id || null,
      revision: Number(previous || 0) + 1,
      source: 'parser',
      templateType: parsedResult.templateType,
      authenticityStatus: authentication.status,
      orderStatus: parsedResult.orderStatus,
      paymentStatus: parsedResult.paymentStatus,
      pickupInfo: parsedResult.pickupInfo,
      products: parsedResult.products,
      evidence: {
        ...parsedResult.evidence,
        authentication: authentication.evidence,
        productScope: scope.evidence || scope.reason,
        messageEmailDate: message.emailDate,
        messageReceivedAt: message.receivedAt || message.createdAt,
      },
      needsReview: parsedResult.needsReview || reviewReasons.length > 0,
      reviewReasons: [...new Set(reviewReasons.filter(Boolean))],
      ruleVersion: RULE_VERSION,
      parsedAt: now,
    },
    { transaction }
  );
  return event;
}

function pickEffectiveEvents(events) {
  const byMessage = new Map();
  for (const event of events) {
    const current = byMessage.get(event.messageId);
    if (!current || (event.source === 'manual' && current.source !== 'manual')) {
      byMessage.set(event.messageId, event);
    } else if (event.source === current.source && event.revision > current.revision) {
      byMessage.set(event.messageId, event);
    }
  }
  return [...byMessage.values()];
}

/** 按订单号、商品范围和状态单调性归并同一订单的当前有效事件。 */
function aggregateOrderLifecycle(order, events) {
  const effective = pickEffectiveEvents(events);
  let orderStatus = 'unknown';
  let paymentStatus = 'unknown';
  const reviewReasons = new Set();
  let evidenceAt = null;
  const applicable = [];

  for (const event of effective) {
    if (event.templateType === TEMPLATE_TYPES.EXCLUDED) continue;
    const orderNumberMatched = event.message?.orderNumber === order.orderNumber;
    const scope = evaluateLifecycleScope(event.templateType, event.products, order.products);
    if (!orderNumberMatched) reviewReasons.add('ORDER_NUMBER_MISMATCH');
    if (!scope.matched) reviewReasons.add(scope.reason);
    for (const reason of event.reviewReasons || []) reviewReasons.add(reason);
    if (event.needsReview)
      for (const reason of event.reviewReasons || []) reviewReasons.add(reason);
    if (!orderNumberMatched || !scope.matched || event.needsReview) continue;
    applicable.push(event);
    if (orderStatusRank(event.orderStatus) > orderStatusRank(orderStatus)) {
      orderStatus = event.orderStatus;
    }
    if (event.paymentStatus === 'paid') paymentStatus = 'paid';
    const emailDate = event.message?.emailDate;
    if (emailDate && (!evidenceAt || emailDate > evidenceAt)) evidenceAt = emailDate;
  }

  const pickupCandidates = applicable
    .filter(event => event.pickupInfo)
    .sort((left, right) => {
      const formalDifference =
        Number(
          [TEMPLATE_TYPES.READY_UPDATE, TEMPLATE_TYPES.READY_INFO].includes(right.templateType)
        ) -
        Number(
          [TEMPLATE_TYPES.READY_UPDATE, TEMPLATE_TYPES.READY_INFO].includes(left.templateType)
        );
      if (formalDifference) return formalDifference;
      return (
        new Date(right.message?.emailDate || right.parsedAt) -
        new Date(left.message?.emailDate || left.parsedAt)
      );
    });
  const pickupEvent = pickupCandidates[0] || null;
  const pickupInfo = pickupEvent
    ? {
      ...pickupEvent.pickupInfo,
      evidence: {
        messageId: pickupEvent.messageId,
        emailDate: pickupEvent.message?.emailDate || null,
        receivedAt: pickupEvent.message?.receivedAt || pickupEvent.message?.createdAt || null,
        parsedAt: pickupEvent.parsedAt,
        ruleVersion: pickupEvent.ruleVersion,
      },
    }
    : null;
  if (pickupInfo) {
    for (const candidate of pickupCandidates.slice(1)) {
      for (const [field, value] of Object.entries(candidate.pickupInfo)) {
        if (
          (pickupInfo[field] === null || pickupInfo[field] === '') &&
          value !== null &&
          value !== ''
        )
          pickupInfo[field] = value;
      }
    }
  }
  return {
    orderStatus,
    paymentStatus,
    pickupInfo,
    evidenceAt,
    needsReview: reviewReasons.size > 0,
    reviewReasons: [...reviewReasons].sort(),
    applicable,
  };
}

async function completePaymentTaskFromMail(order, aggregate, transaction) {
  if (aggregate.paymentStatus !== 'paid' || aggregate.needsReview) return false;
  const task = await PaymentTask.findOne({
    where: { orderId: order.id },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!task || task.processingStatus === 'completed') return false;
  const beforeStatus = task.processingStatus;
  const completedAt = new Date();
  task.processingStatus = 'completed';
  task.completedAt = completedAt;
  task.version += 1;
  await task.save({ transaction });
  await PaymentTaskEvent.create(
    {
      paymentTaskId: task.id,
      eventType: 'mail_payment_confirmed',
      actorUserId: null,
      beforeStatus,
      afterStatus: 'completed',
      details: {
        source: 'official_order_mail',
        messageIds: aggregate.applicable
          .filter(event => event.paymentStatus === 'paid')
          .map(event => event.messageId),
        ruleVersion: RULE_VERSION,
        systemCompletedAt: completedAt.toISOString(),
        actualPaymentAt: null,
      },
    },
    { transaction }
  );
  return true;
}

/** 在一个事务中归并同一订单全部有效邮件，并按开关更新订单及付款任务。 */
function applyOrderLifecycle(orderId, transaction, config = getOrderMailConfig()) {
  const apply = async currentTransaction => {
    const order = await Order.findByPk(orderId, {
      transaction: currentTransaction,
      lock: currentTransaction.LOCK.UPDATE,
    });
    if (!order) return { status: 'waiting_order' };
    const events = await OrderMailEvent.findAll({
      where: { orderId: order.id, supersededAt: null },
      include: [
        {
          model: OrderMailMessage,
          as: 'message',
          attributes: ['id', 'orderNumber', 'emailDate', 'receivedAt', 'createdAt'],
        },
      ],
      transaction: currentTransaction,
    });
    const aggregate = aggregateOrderLifecycle(order, events);
    if (!config.lifecycle.applyEnabled)
      return { status: 'parsed', aggregate, version: order.emailStatusVersion };
    const currentOrderRank = orderStatusRank(order.emailOrderStatus);
    const nextOrderStatus =
      orderStatusRank(aggregate.orderStatus) >= currentOrderRank
        ? aggregate.orderStatus
        : order.emailOrderStatus;
    const nextPaymentStatus =
      order.emailPaymentStatus === 'paid' ? 'paid' : aggregate.paymentStatus;
    await order.update(
      {
        emailOrderStatus: nextOrderStatus,
        emailPaymentStatus: nextPaymentStatus,
        emailStatusNeedsReview: aggregate.needsReview,
        emailStatusReviewReasons: aggregate.reviewReasons,
        emailStatusVersion: order.emailStatusVersion + 1,
        emailStatusEvidenceAt: aggregate.evidenceAt || order.emailStatusEvidenceAt,
        emailPickupInfo: aggregate.pickupInfo || order.emailPickupInfo,
        emailPickupDate: aggregate.pickupInfo?.pickupDate || order.emailPickupDate,
        emailLifecycleUpdatedAt: new Date(),
      },
      { transaction: currentTransaction }
    );
    if (config.lifecycle.paymentTaskApplyEnabled) {
      await completePaymentTaskFromMail(
        order,
        { ...aggregate, paymentStatus: nextPaymentStatus },
        currentTransaction
      );
    }
    const eventIds = aggregate.applicable.map(event => event.id);
    if (eventIds.length)
      await OrderMailEvent.update(
        { appliedAt: new Date() },
        { where: { id: { [Op.in]: eventIds } }, transaction: currentTransaction }
      );
    const status = aggregate.needsReview
      ? 'needs_review'
      : nextPaymentStatus === 'paid' && !config.lifecycle.paymentTaskApplyEnabled
        ? 'applied_pending_payment'
        : 'applied';
    return {
      status,
      aggregate,
      version: order.emailStatusVersion,
    };
  };
  return transaction ? apply(transaction) : sequelize.transaction(apply);
}

async function processClaimedJob(job, config) {
  try {
    return await sequelize.transaction(async transaction => {
      const lockedJob = await OrderMailProcessingJob.findByPk(job.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!lockedJob || lockedJob.status !== 'processing') return false;
      const message = await OrderMailMessage.findByPk(lockedJob.messageId, { transaction });
      if (!message?.rawContent) {
        lockedJob.status = 'failed';
        lockedJob.lastErrorCode = 'MAIL_CONTENT_EXPIRED';
        lockedJob.completedAt = new Date();
        lockedJob.leaseExpiresAt = null;
        await lockedJob.save({ transaction });
        return true;
      }
      const rawBuffer = Buffer.from(message.rawContent, 'base64');
      const parsed = await parseOrderMail(rawBuffer);
      const parsedResult = parseOrderMailLifecycle(parsed);
      const order = parsedResult.orderNumber
        ? await Order.findOne({ where: { orderNumber: parsedResult.orderNumber }, transaction })
        : null;
      let authentication = { status: 'not_checked', reason: null, evidence: {} };
      if (parsedResult.templateType !== TEMPLATE_TYPES.EXCLUDED) {
        authentication = verifyOrderNumberMatch(message, parsedResult, order);
      }
      const event = await appendParserEvent(
        message,
        order,
        parsedResult,
        authentication,
        transaction
      );
      let outcome = {
        status: parsedResult.templateType === TEMPLATE_TYPES.EXCLUDED ? 'ignored' : 'parsed',
      };
      if (order) outcome = await applyOrderLifecycle(order.id, transaction, config);
      else if (parsedResult.templateType !== TEMPLATE_TYPES.EXCLUDED)
        outcome = { status: 'waiting_order' };
      lockedJob.status = outcome.status;
      lockedJob.attempts = 0;
      lockedJob.completedAt = new Date();
      lockedJob.leaseExpiresAt = null;
      lockedJob.lastErrorCode = null;
      await lockedJob.save({ transaction });
      logger.info('订单邮件生命周期解析完成', {
        messageId: message.id,
        orderId: order?.id || null,
        templateType: event.templateType,
        result: lockedJob.status,
      });
      return true;
    });
  } catch (error) {
    await OrderMailProcessingJob.update(
      {
        status: job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        notBefore: new Date(Date.now() + RETRY_MS * Math.max(1, job.attempts)),
        leaseExpiresAt: null,
        lastErrorCode: error.code || 'MAIL_LIFECYCLE_FAILED',
        completedAt: job.attempts >= MAX_ATTEMPTS ? new Date() : null,
      },
      { where: { id: job.id } }
    );
    logger.warn('订单邮件生命周期解析失败', {
      jobId: job.id,
      errorType: error.name,
      errorCode: error.code || 'MAIL_LIFECYCLE_FAILED',
      attempts: job.attempts,
    });
    return true;
  }
}

/** 处理下一封邮件；解析关闭时不领取任务。 */
async function processNextLifecycleJob(options = {}) {
  const config = options.config || getOrderMailConfig();
  if (!config.lifecycle.parseEnabled) return false;
  const job = await claimLifecycleJob(config);
  if (!job) return false;
  return processClaimedJob(job, config);
}

/** 订单晚于邮件创建时，在订单创建事务内关联并应用已有解析结论。 */
async function applyWaitingOrderLifecycle(order, transaction, config = getOrderMailConfig()) {
  const events = await OrderMailEvent.findAll({
    include: [
      {
        model: OrderMailMessage,
        as: 'message',
        attributes: [],
        where: { orderNumber: order.orderNumber },
        required: true,
      },
    ],
    where: { orderId: null, supersededAt: null },
    transaction,
  });
  if (!events.length) return { status: 'none' };
  const eventIds = events.map(event => event.id);
  const messageIds = [...new Set(events.map(event => event.messageId))];
  await OrderMailEvent.update(
    { orderId: order.id, authenticityStatus: 'verified' },
    { where: { id: { [Op.in]: eventIds } }, transaction }
  );
  const result = await applyOrderLifecycle(order.id, transaction, config);
  await OrderMailProcessingJob.update(
    { status: result.status, completedAt: new Date(), lastErrorCode: null },
    { where: { messageId: { [Op.in]: messageIds } }, transaction }
  );
  return result;
}

/** 获授权用户重放一封邮件；只重置解析任务，不绕过应用开关。 */
async function enqueueReplay(user, orderId, messageId) {
  const { accessibleMessage } = require('./orderMailService');
  const message = await accessibleMessage(user, orderId, messageId, {
    content: true,
    permission: PERMISSIONS.ORDER_MAIL_MANAGE,
  });
  const [job] = await enqueueLifecycleJob(message.id);
  await job.update({
    status: 'pending',
    attempts: 0,
    notBefore: new Date(),
    leaseExpiresAt: null,
    lastErrorCode: null,
    completedAt: null,
  });
  return { messageId: message.id, status: job.status };
}

/** 按订单重新排队全部关联邮件；活动任务保持不变，终态任务从头解析。 */
async function enqueueOrderReplay(user, orderIds) {
  if (
    ![PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDER_MAIL_MANAGE].every(code =>
      user?.permissions?.includes(code)
    )
  ) {
    throw new ApiError(HTTP_FORBIDDEN, 'FORBIDDEN', '当前账号没有订单邮件权限');
  }
  const normalizedIds = normalizeReplayOrderIds(orderIds);
  return await sequelize.transaction(async transaction => {
    const orders = await Order.findAll({
      where: scopeOrderWhere(user, { id: { [Op.in]: normalizedIds } }),
      attributes: ['id', 'orderNumber'],
      transaction,
    });
    if (orders.length !== normalizedIds.length) {
      throw ApiError.notFound('订单不存在或不可访问');
    }
    const orderByNumber = new Map(orders.map(order => [order.orderNumber, order]));
    const messages = await OrderMailMessage.findAll({
      where: { orderNumber: { [Op.in]: [...orderByNumber.keys()] } },
      attributes: ['id', 'orderNumber', 'rawContent'],
      order: [
        ['orderNumber', 'ASC'],
        ['emailDate', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    });
    const messageIds = messages.map(message => message.id);
    const jobs = messageIds.length
      ? await OrderMailProcessingJob.findAll({
        where: { messageId: { [Op.in]: messageIds } },
        transaction,
        lock: transaction.LOCK.UPDATE,
      })
      : [];
    const jobByMessage = new Map(jobs.map(job => [job.messageId, job]));
    const resultByOrder = new Map(
      orders.map(order => [
        order.id,
        { orderId: order.id, messageCount: 0, enqueued: 0, active: 0, expired: 0 },
      ])
    );
    for (const message of messages) {
      const order = orderByNumber.get(message.orderNumber);
      const result = resultByOrder.get(order.id);
      result.messageCount += 1;
      if (!message.rawContent) {
        result.expired += 1;
        continue;
      }
      const job = jobByMessage.get(message.id);
      if (job && ['pending', 'processing'].includes(job.status)) {
        result.active += 1;
        continue;
      }
      if (job) {
        await job.update(
          {
            status: 'pending',
            attempts: 0,
            notBefore: new Date(),
            leaseExpiresAt: null,
            lastErrorCode: null,
            completedAt: null,
          },
          { transaction }
        );
      } else {
        await enqueueLifecycleJob(message.id, transaction);
      }
      result.enqueued += 1;
    }
    const config = getOrderMailConfig();
    const results = normalizedIds.map(id => resultByOrder.get(id));
    return {
      results,
      totals: results.reduce(
        (totals, result) => ({
          orders: totals.orders + 1,
          messages: totals.messages + result.messageCount,
          enqueued: totals.enqueued + result.enqueued,
          active: totals.active + result.active,
          expired: totals.expired + result.expired,
          withoutMail: totals.withoutMail + Number(result.messageCount === 0),
        }),
        { orders: 0, messages: 0, enqueued: 0, active: 0, expired: 0, withoutMail: 0 }
      ),
      mode: config.lifecycle.applyEnabled ? 'apply' : 'shadow',
    };
  });
}

/** 基于已关联官方邮件追加人工核定事件，并使用订单邮件版本保护并发。 */
function reviewLifecycleEvent(user, orderId, messageId, input) {
  const { accessibleMessage } = require('./orderMailService');
  const reason = String(input.reason || '').trim();
  const expectedVersion = Number(input.expectedVersion);
  if (reason.length < 5 || reason.length > 500) throw ApiError.badRequest('核定原因须为 5-500 字');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0)
    throw ApiError.badRequest('expectedVersion 必须是非负整数');
  if (input.orderStatus !== undefined && !EMAIL_ORDER_STATUSES.includes(input.orderStatus))
    throw ApiError.badRequest('orderStatus 非法');
  if (input.paymentStatus !== undefined && !['unknown', 'paid'].includes(input.paymentStatus))
    throw ApiError.badRequest('paymentStatus 非法');
  let pickupInfo;
  if (input.pickupInfo !== undefined) {
    if (
      input.pickupInfo !== null &&
      (typeof input.pickupInfo !== 'object' || Array.isArray(input.pickupInfo))
    )
      throw ApiError.badRequest('pickupInfo 非法');
    if (input.pickupInfo === null) pickupInfo = null;
    else {
      const value = input.pickupInfo;
      const limitedText = (field, maximum) => {
        if (value[field] === null || value[field] === undefined) return null;
        if (typeof value[field] !== 'string' || value[field].length > maximum)
          throw ApiError.badRequest(`pickupInfo.${field} 非法`);
        return value[field].trim() || null;
      };
      pickupInfo = {
        storeName: limitedText('storeName', 255),
        storeAddress: limitedText('storeAddress', 1000),
        pickupDate: limitedText('pickupDate', 10),
        startTime: limitedText('startTime', 5),
        endTime: limitedText('endTime', 5),
        appointmentMode: limitedText('appointmentMode', 30),
        timeZone: limitedText('timeZone', 50),
        retentionText: limitedText('retentionText', 300),
        rawTimeRange: limitedText('rawTimeRange', 100),
      };
      if (pickupInfo.pickupDate && !/^20\d{2}-\d{2}-\d{2}$/.test(pickupInfo.pickupDate))
        throw ApiError.badRequest('pickupInfo.pickupDate 非法');
      for (const field of ['startTime', 'endTime'])
        if (pickupInfo[field] && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(pickupInfo[field]))
          throw ApiError.badRequest(`pickupInfo.${field} 非法`);
      if (
        pickupInfo.appointmentMode &&
        !['scheduled', 'business_hours', 'unknown'].includes(pickupInfo.appointmentMode)
      )
        throw ApiError.badRequest('pickupInfo.appointmentMode 非法');
      if (pickupInfo.timeZone && pickupInfo.timeZone !== 'Asia/Shanghai')
        throw ApiError.badRequest('pickupInfo.timeZone 非法');
    }
  }

  return sequelize.transaction(async transaction => {
    const message = await accessibleMessage(user, orderId, messageId, {
      transaction,
      permission: PERMISSIONS.ORDER_MAIL_MANAGE,
    });
    const order = await Order.findByPk(Number(orderId), {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (order.emailStatusVersion !== expectedVersion)
      throw ApiError.conflict(
        '订单邮件状态已更新',
        { currentVersion: order.emailStatusVersion },
        'CONCURRENT_MODIFICATION'
      );
    const current = await OrderMailEvent.findOne({
      where: { messageId: message.id, supersededAt: null },
      order: [
        ['source', 'ASC'],
        ['revision', 'DESC'],
      ],
      transaction,
    });
    if (!current) throw ApiError.conflict('邮件尚未完成解析', undefined, 'MAIL_NOT_PARSED');
    const revision = Number(
      (await OrderMailEvent.max('revision', { where: { messageId: message.id }, transaction })) || 0
    );
    await OrderMailEvent.update(
      { supersededAt: new Date() },
      { where: { messageId: message.id, source: 'manual', supersededAt: null }, transaction }
    );
    await OrderMailEvent.create(
      {
        id: crypto.randomUUID(),
        messageId: message.id,
        orderId: order.id,
        revision: revision + 1,
        source: 'manual',
        actorUserId: user.id,
        templateType: current.templateType,
        authenticityStatus: 'manually_verified',
        orderStatus: input.orderStatus ?? current.orderStatus,
        paymentStatus: input.paymentStatus ?? current.paymentStatus,
        pickupInfo: input.pickupInfo === undefined ? current.pickupInfo : pickupInfo,
        products: current.products,
        evidence: { ...current.evidence, manuallyReviewedAt: new Date() },
        needsReview: false,
        reviewReasons: [],
        reason,
        ruleVersion: current.ruleVersion,
        parsedAt: new Date(),
      },
      { transaction }
    );
    const config = getOrderMailConfig();
    if (!config.lifecycle.applyEnabled) {
      order.emailStatusVersion += 1;
      await order.save({ fields: ['emailStatusVersion'], transaction });
      return { status: 'parsed', version: order.emailStatusVersion };
    }
    const result = await applyOrderLifecycle(order.id, transaction, config);
    return { status: result.status, version: result.version };
  });
}

module.exports = {
  enqueueLifecycleJob,
  aggregateOrderLifecycle,
  applyOrderLifecycle,
  processNextLifecycleJob,
  applyWaitingOrderLifecycle,
  enqueueReplay,
  enqueueOrderReplay,
  reviewLifecycleEvent,
  verifyOrderNumberMatch,
};
