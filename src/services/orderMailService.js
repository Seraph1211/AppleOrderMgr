const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  Order,
  OrderMailMessage,
  OrderMailDelivery,
  OrderMailState,
  OrderMailProcessingJob,
  OrderMailEvent,
  User,
} = require('../models');
const { PERMISSIONS } = require('../constants/business');
const { scopeOrderWhere } = require('./orderAccessService');
const { getEffectivePermissions } = require('./permissionService');
const { getOrderMailConfig, isOrderMailConfigured } = require('./orderMailConfig');
const {
  parseOrderMail,
  extractOrderNumber,
  isAllowedSender,
  mailMetadata,
  validateForwardInput,
} = require('./orderMailContent');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const RETENTION_MS = 180 * 86400000;
const MESSAGE_ATTRIBUTES = [
  'id',
  'metadata',
  'emailDate',
  'receivedAt',
  'expiresAt',
  'orderNumber',
  'createdAt',
];

/** 对每个邮件入口验证功能权限与精确订单TAG范围。 */
async function accessibleOrder(
  user,
  orderId,
  transaction,
  permission = PERMISSIONS.ORDER_MAIL_READ
) {
  try {
    if (
      !user.permissions?.includes(PERMISSIONS.ORDERS_READ) ||
      (!user.permissions.includes(PERMISSIONS.ORDER_MAIL_MANAGE) &&
        (!user.permissions.includes(PERMISSIONS.ORDER_MAIL_READ) ||
          !user.permissions.includes(permission)))
    )
      throw new ApiError(403, 'FORBIDDEN', '当前账号没有订单邮件权限');
    if (!/^[1-9][0-9]*$/.test(String(orderId)) || !Number.isSafeInteger(Number(orderId)))
      throw ApiError.badRequest('订单ID无效');
    const order = await Order.findOne({
      where: scopeOrderWhere(user, { id: Number(orderId) }),
      attributes: ['id', 'orderNumber', 'tag'],
      transaction,
    });
    if (!order) throw ApiError.notFound('订单不存在或不可访问');
    return order;
  } catch (error) {
    logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}

/** 在数据库重新加载授权，发送队列不能沿用排队时的权限快照。 */
async function currentActor(actorUserId) {
  try {
    const user = await User.findByPk(actorUserId);
    if (!user || user.status !== 'active') throw new ApiError(403, 'ACCESS_REVOKED', '权限已失效');
    return {
      id: user.id,
      role: user.role,
      orderAccess: user.orderAccess,
      permissions: await getEffectivePermissions(user),
    };
  } catch (error) {
    logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}

/** 查询属于当前订单的邮件；禁止凭猜测邮件ID越权。 */
async function accessibleMessage(
  user,
  orderId,
  messageId,
  { content = false, transaction, permission = PERMISSIONS.ORDER_MAIL_READ } = {}
) {
  try {
    const order = await accessibleOrder(user, orderId, transaction, permission);
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(String(messageId)))
      throw ApiError.notFound('邮件不存在或不可访问');
    const message = await OrderMailMessage.findOne({
      where: { id: messageId, orderNumber: order.orderNumber },
      attributes: content ? undefined : MESSAGE_ATTRIBUTES,
      transaction,
    });
    if (!message) throw ApiError.notFound('邮件不存在或不可访问');
    if (content && (!message.rawContent || message.expiresAt <= new Date()))
      throw new ApiError(410, 'ORDER_MAIL_EXPIRED', '邮件内容已过期');
    return message;
  } catch (error) {
    logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}

/** 脱敏同步状态，不向业务用户泄露账号和连接错误明文。 */
async function syncStatus() {
  try {
    const config = getOrderMailConfig();
    if (!isOrderMailConfigured(config)) return { status: 'disabled', lastSucceededAt: null };
    const state = await OrderMailState.findByPk(config.identity);
    const last = state?.lastScanSucceededAt;
    let status = 'pending';
    if (state?.lastScanErrorCode || (last && Date.now() - last.getTime() > 90000)) status = 'error';
    else if (
      state?.isConnected &&
      state.lastScanStartedAt &&
      (!last || state.lastScanStartedAt > last)
    )
      status = 'syncing';
    else if (last) status = state.isConnected ? 'ready' : 'error';
    return { status, lastSucceededAt: last || null };
  } catch (error) {
    logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}

/** 分页返回订单邮件元信息，原文不出现在列表中。 */
async function listMessages(user, orderId, query) {
  try {
    const order = await accessibleOrder(user, orderId);
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 20);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw ApiError.badRequest('分页参数无效');
    const { rows, count } = await OrderMailMessage.findAndCountAll({
      where: { orderNumber: order.orderNumber },
      attributes: MESSAGE_ATTRIBUTES,
      order: [
        ['emailDate', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
      offset: (page - 1) * limit,
    });
    const events = rows.length
      ? await OrderMailEvent.findAll({
        where: { messageId: { [Op.in]: rows.map(row => row.id) }, supersededAt: null },
        order: [
          ['revision', 'DESC'],
          ['source', 'ASC'],
        ],
      })
      : [];
    const eventByMessage = new Map();
    for (const event of events) {
      const current = eventByMessage.get(event.messageId);
      if (!current || (event.source === 'manual' && current.source !== 'manual')) {
        eventByMessage.set(event.messageId, event);
      }
    }
    return {
      items: rows.map(message => messageSummary(message, eventByMessage.get(message.id))),
      total: count,
      page,
      limit,
      sync: await syncStatus(),
    };
  } catch (error) {
    logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}

/** 对外邮件摘要。 */
function messageSummary(message, event = null) {
  const expired = message.expiresAt <= new Date();
  return {
    id: message.id,
    ...(expired ? {} : message.metadata),
    date: message.emailDate,
    receivedAt: message.receivedAt || message.createdAt,
    expired,
    lifecycle: event
      ? {
        templateType: event.templateType,
        authenticityStatus: event.authenticityStatus,
        orderStatus: event.orderStatus,
        paymentStatus: event.paymentStatus,
        pickupInfo: event.pickupInfo,
        needsReview: event.needsReview,
        reviewReasons: event.reviewReasons,
        ruleVersion: event.ruleVersion,
        source: event.source,
        parsedAt: event.parsedAt,
        appliedAt: event.appliedAt,
      }
      : null,
  };
}

/** 返回一封邮件当前有效的解析／人工核定结论。 */
async function messageLifecycle(messageId) {
  const events = await OrderMailEvent.findAll({
    where: { messageId, supersededAt: null },
    order: [
      ['revision', 'DESC'],
      ['source', 'ASC'],
    ],
  });
  const event = events.find(item => item.source === 'manual') || events[0] || null;
  return event
    ? messageSummary(
      {
        id: messageId,
        expiresAt: new Date(0),
        emailDate: null,
        receivedAt: null,
        createdAt: null,
        metadata: null,
      },
      event
    ).lifecycle
    : null;
}

/** 持久化一封匹配邮件；扫描游标只有此操作成功后才能推进。 */
async function receiveOrderMail(
  { rawBuffer, emailUid, receivedAt },
  identity,
  config = getOrderMailConfig()
) {
  try {
    let parsed;
    try {
      parsed = await parseOrderMail(rawBuffer);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
    const orderNumber =
      parsed && isAllowedSender(parsed, config.senderDomains) ? extractOrderNumber(parsed) : null;
    if (!orderNumber) {
      await OrderMailState.increment('ignoredCount', {
        where: { mailboxIdentityHash: config.identity },
      });
      return { created: false };
    }
    const created = await sequelize.transaction(async transaction => {
      const [message, wasCreated] = await OrderMailMessage.findOrCreate({
        where: {
          mailboxIdentityHash: identity.mailboxIdentityHash,
          mimeSha256: crypto.createHash('sha256').update(rawBuffer).digest('hex'),
        },
        defaults: {
          id: crypto.randomUUID(),
          ...identity,
          emailUid: String(emailUid),
          orderNumber,
          metadata: mailMetadata(parsed),
          rawContent: rawBuffer.toString('base64'),
          emailDate: parsed.date && Number.isFinite(parsed.date.getTime()) ? parsed.date : null,
          receivedAt:
            receivedAt instanceof Date && Number.isFinite(receivedAt.getTime())
              ? receivedAt
              : new Date(),
          expiresAt: new Date(Date.now() + RETENTION_MS),
        },
        transaction,
      });
      if (wasCreated) {
        await require('./orderMailLifecycleService').enqueueLifecycleJob(message.id, transaction);
        await OrderMailState.increment('receivedCount', {
          where: { mailboxIdentityHash: config.identity },
          transaction,
        });
      } else if (
        !(await OrderMailProcessingJob.findOne({ where: { messageId: message.id }, transaction }))
      ) {
        await require('./orderMailLifecycleService').enqueueLifecycleJob(message.id, transaction);
      }
      return wasCreated;
    });
    return { created };
  } catch (error) {
    logger.warn('订单邮件保存失败', { errorType: error.name });
    throw error;
  }
}

/** 只返回受控发送结果，不返回SMTP响应和凭据。 */
function deliverySummary(delivery) {
  return {
    id: delivery.id,
    actorUserId: delivery.actorUserId,
    recipient: delivery.payload.recipient,
    note: delivery.payload.note,
    status: delivery.status,
    errorCode: delivery.errorCode,
    createdAt: delivery.createdAt,
    sentAt: delivery.sentAt,
  };
}

/** 持久化幂等转发任务；重复请求必须与原始请求完全一致。 */
async function enqueueForward(user, orderId, messageId, body) {
  try {
    const input = validateForwardInput(body);
    return await sequelize.transaction(async transaction => {
      // 按操作人串行化幂等检查，保护并发双击和网络重试。
      await sequelize.query('SELECT pg_advisory_xact_lock(820421, :userId)', {
        replacements: { userId: user.id },
        transaction,
      });
      await accessibleMessage(user, orderId, messageId, {
        transaction,
        permission: PERMISSIONS.ORDER_MAIL_FORWARD,
      });
      const payload = { recipient: input.recipient, note: input.note };
      const previous = await OrderMailDelivery.findOne({
        where: { actorUserId: user.id, idempotencyKey: input.idempotencyKey },
        transaction,
      });
      if (previous) {
        if (
          previous.orderId !== Number(orderId) ||
          previous.messageId !== messageId ||
          JSON.stringify(previous.payload) !== JSON.stringify(payload)
        )
          throw ApiError.conflict('发送请求标识已用于其他内容', undefined, 'IDEMPOTENCY_CONFLICT');
        return deliverySummary(previous);
      }
      if (!isOrderMailConfigured())
        throw new ApiError(503, 'ORDER_MAIL_UNAVAILABLE', '订单邮件收发尚未配置');
      await accessibleMessage(user, orderId, messageId, {
        content: true,
        transaction,
        permission: PERMISSIONS.ORDER_MAIL_FORWARD,
      });
      const delivery = await OrderMailDelivery.create(
        {
          id: crypto.randomUUID(),
          orderId: Number(orderId),
          messageId,
          actorUserId: user.id,
          idempotencyKey: input.idempotencyKey,
          payload,
          notBefore: new Date(),
          status: 'queued',
        },
        { transaction }
      );
      return deliverySummary(delivery);
    });
  } catch (error) {
    logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}

/** 规范化批量目标；绑定完整请求以保护部分变更后的重试。 */
function validateBatchForward(body) {
  if (!Array.isArray(body?.recipients) || body.recipients.length < 1 || body.recipients.length > 50)
    throw ApiError.badRequest('请选择1至50个收件邮箱');
  if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(body.idempotencyKey))
    throw ApiError.badRequest('批量发送请求标识须为16至64位字母数字或连字符');
  const inputs = body.recipients.map(recipient => validateForwardInput({ ...body, recipient }));
  return {
    recipients: [...new Set(inputs.map(input => input.recipient.toLowerCase()))].sort(),
    note: inputs[0].note,
    idempotencyKey: body.idempotencyKey,
  };
}

/** 同一事务排队全部收件人；独立投递且重试不重复建任务。 */
async function enqueueBatchForward(user, orderId, messageId, body) {
  try {
    const input = validateBatchForward(body);
    const keys = input.recipients.map((_recipient, index) => input.idempotencyKey + '-' + index);
    const payloads = input.recipients.map(recipient => ({
      recipient,
      note: input.note,
      batchRecipients: input.recipients,
    }));
    return await sequelize.transaction(async transaction => {
      await sequelize.query('SELECT pg_advisory_xact_lock(820421, :userId)', {
        replacements: { userId: user.id },
        transaction,
      });
      await accessibleMessage(user, orderId, messageId, {
        transaction,
        permission: PERMISSIONS.ORDER_MAIL_FORWARD,
      });
      const previous = await OrderMailDelivery.findAll({
        where: { actorUserId: user.id, idempotencyKey: { [Op.in]: keys } },
        transaction,
      });
      if (previous.length) {
        const byKey = new Map(previous.map(item => [item.idempotencyKey, item]));
        if (
          previous.length !== keys.length ||
          keys.some((key, index) => {
            const item = byKey.get(key);
            return (
              !item ||
              item.orderId !== Number(orderId) ||
              item.messageId !== messageId ||
              JSON.stringify(item.payload) !== JSON.stringify(payloads[index])
            );
          })
        )
          throw ApiError.conflict('发送请求标识已用于其他内容', undefined, 'IDEMPOTENCY_CONFLICT');
        return { items: keys.map(key => deliverySummary(byKey.get(key))) };
      }
      if (!isOrderMailConfigured())
        throw new ApiError(503, 'ORDER_MAIL_UNAVAILABLE', '订单邮件收发尚未配置');
      await accessibleMessage(user, orderId, messageId, {
        content: true,
        transaction,
        permission: PERMISSIONS.ORDER_MAIL_FORWARD,
      });
      const deliveries = await OrderMailDelivery.bulkCreate(
        payloads.map((payload, index) => ({
          id: crypto.randomUUID(),
          orderId: Number(orderId),
          messageId,
          actorUserId: user.id,
          idempotencyKey: keys[index],
          payload,
          notBefore: new Date(),
          status: 'queued',
        })),
        { transaction, returning: true }
      );
      return { items: deliveries.map(deliverySummary) };
    });
  } catch (error) {
    logger.warn('订单邮件批量转发未完成', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}

/** 内容到期清除，保留关联与发送审计。 */
async function purgeOrderMail() {
  try {
    await OrderMailMessage.update(
      { rawContent: null, metadata: null },
      {
        where: { expiresAt: { [Op.lt]: new Date() }, rawContent: { [Op.ne]: null } },
      }
    );
  } catch (error) {
    logger.warn('订单邮件内容清理失败', { errorType: error.name });
    throw error;
  }
}

module.exports = {
  validateBatchForward,
  enqueueBatchForward,
  accessibleOrder,
  accessibleMessage,
  currentActor,
  syncStatus,
  listMessages,
  messageSummary,
  messageLifecycle,
  receiveOrderMail,
  enqueueForward,
  deliverySummary,
  purgeOrderMail,
};
