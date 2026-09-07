/**
 * 邮件处理持久化状态机、幂等、重试与人工处理服务。
 * @module services/emailProcessingService
 */

const crypto = require('crypto');
const { Op } = require('sequelize');

const { sequelize, EmailLog, EmailWorkerState, Order } = require('../models');
const logger = require('../utils/logger');
const {
  parseMimeEmail,
  parseOrderEmailFromParsed,
  extractEmailMetadataFromParsed,
} = require('./emailParser');
const { classifyEmailError, EMAIL_ERROR_CODES, EmailProcessingError } = require('./emailErrors');
const { validateManualOrderData } = require('./emailManualData');
const { saveOrderFromEmail } = require('./orderService');

const RETENTION_DAYS = 180;
const RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_COUNT = 3;
const TERMINAL_STATUSES = new Set(['ignored', 'manual_review', 'succeeded', 'superseded']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * 计算不暴露邮箱账号的稳定邮箱身份。
 * @param {Object} identity - 邮箱连接身份
 * @returns {string} SHA-256
 */
function createMailboxIdentityHash(identity) {
  const normalized = [identity.host, identity.user, identity.mailbox]
    .map(value =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .join('\n');
  return sha256(normalized);
}

function createRetentionExpiry(receivedAt = new Date()) {
  return new Date(receivedAt.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * 在解析前持久化 MIME 与稳定 IMAP 身份。
 * @param {Object} input - 接收信息
 * @returns {Promise<{ record: Object, created: boolean }>} 邮件记录
 */
async function receiveEmail(input) {
  const rawBuffer = Buffer.isBuffer(input.rawBuffer)
    ? input.rawBuffer
    : Buffer.from(input.rawBuffer || '', 'utf8');
  const mailboxIdentityHash = createMailboxIdentityHash(input.mailboxIdentity);
  const uidValidity = String(input.uidValidity || 'unknown');
  const emailUid = String(input.emailUid);
  const receivedAt = new Date();

  const [record, created] = await EmailLog.findOrCreate({
    where: { mailboxIdentityHash, uidValidity, emailUid },
    defaults: {
      mailboxIdentityHash,
      uidValidity,
      emailUid,
      mimeSha256: sha256(rawBuffer),
      rawContent: rawBuffer.toString('base64'),
      status: 'received',
      processed: false,
      success: null,
      receivedAt,
      retentionExpiresAt: createRetentionExpiry(receivedAt),
      imapAckStatus: 'pending',
      attemptHistory: [],
    },
  });
  return { record, created };
}

async function updateMetadata(record, metadata) {
  record.emailSubject = metadata.subject || '';
  record.emailFrom = metadata.from || '';
  record.emailDate = metadata.date || new Date();
  record.messageId = metadata.messageId || null;
  record.authenticationResults = metadata.authenticationResults
    ? String(metadata.authenticationResults)
    : null;
  await record.save();
}

function findDuplicateEvent(record) {
  const alternatives = [];
  if (record.messageId) {
    alternatives.push({ messageId: record.messageId });
  }
  if (record.mimeSha256) {
    alternatives.push({ mimeSha256: record.mimeSha256 });
  }
  if (alternatives.length === 0) {
    return null;
  }
  return EmailLog.findOne({
    where: {
      id: { [Op.ne]: record.id },
      status: { [Op.in]: ['retry_wait', 'manual_review', 'succeeded', 'superseded'] },
      [Op.or]: alternatives,
    },
    order: [['receivedAt', 'ASC']],
  });
}

/**
 * 保存元数据并识别 Message-ID/MIME 内容重复事件。
 * @param {Object} record - 当前邮件记录
 * @param {Object} metadata - MIME 元数据
 * @returns {Promise<Object|null>} 已存在的重复记录
 */
async function registerMetadata(record, metadata) {
  await updateMetadata(record, metadata);
  const duplicate = await findDuplicateEvent(record);
  if (!duplicate) {
    return null;
  }

  record.status = 'superseded';
  record.processed = true;
  record.processedAt = new Date();
  record.success = true;
  record.orderId = duplicate.orderId || null;
  record.orderNumber = duplicate.orderNumber || null;
  record.errorCode = EMAIL_ERROR_CODES.DUPLICATE_EVENT;
  record.errorMessage = '重复邮件事件已留痕';
  record.resolvedAt = new Date();
  record.resolutionType = 'duplicate_event';
  record.version += 1;
  await record.save();
  return duplicate;
}

/**
 * 将混合邮箱中的非订单邮件收敛为最小审计记录。
 * @param {Object} record - 邮件记录
 * @returns {Promise<Object>} 更新后的记录
 */
async function markIgnored(record) {
  record.status = 'ignored';
  record.processed = true;
  record.processedAt = new Date();
  record.success = true;
  record.rawContent = null;
  record.emailSubject = null;
  record.emailFrom = null;
  record.messageId = null;
  record.authenticationResults = null;
  record.parsedData = null;
  record.manualDraft = null;
  record.finalData = null;
  record.mimeSha256 = null;
  record.resolvedAt = new Date();
  record.resolutionType = 'non_order';
  record.version += 1;
  await record.save();
  return record;
}

function appendAttempt(record, classification, retryCount) {
  return [
    ...(record.attemptHistory || []),
    {
      at: new Date().toISOString(),
      event: 'attempt_failed',
      errorCode: classification.code,
      retryable: classification.retryable,
      retryCount,
    },
  ];
}

/**
 * 持久化失败分类并进入一分钟重试或人工处理。
 * @param {Object} record - 邮件记录
 * @param {Error} error - 处理异常
 * @param {Object} [options] - 失败选项
 * @param {boolean} [options.isRetry=false] - 本次是否为自动重试
 * @returns {Promise<Object>} 更新后的记录
 */
function markFailure(record, error, { isRetry = false } = {}) {
  const classification = classifyEmailError(error);
  return sequelize.transaction(async transaction => {
    const locked = await EmailLog.findByPk(record.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (TERMINAL_STATUSES.has(locked.status)) {
      return locked;
    }
    const retryCount = locked.retryCount + (isRetry ? 1 : 0);
    const shouldRetry = classification.retryable && retryCount < MAX_RETRY_COUNT;

    locked.status = shouldRetry ? 'retry_wait' : 'manual_review';
    locked.retryCount = retryCount;
    locked.nextRetryAt = shouldRetry ? new Date(Date.now() + RETRY_DELAY_MS) : null;
    locked.errorCode = classification.code;
    locked.errorMessage = classification.message;
    locked.attemptHistory = appendAttempt(locked, classification, retryCount);
    locked.processed = !shouldRetry;
    locked.processedAt = shouldRetry ? null : new Date();
    locked.success = false;
    locked.lastAttemptAt = new Date();
    locked.version += 1;
    await locked.save({ transaction });
    return locked;
  });
}

/**
 * 解析并入库一条已经持久化的订单邮件。
 * @param {Object} record - EmailLog 实例
 * @param {Object} options - 处理选项
 * @param {Object} [options.parsed] - 已解析 MIME
 * @param {Buffer} [options.rawBuffer] - MIME Buffer
 * @param {boolean} [options.isRetry=false] - 是否自动重试
 * @returns {Promise<{ status: string, order?: Object, record: Object }>} 处理结果
 */
async function processPersistedRecord(record, options = {}) {
  let rawBuffer = options.rawBuffer;
  let parsed = options.parsed;

  try {
    if (!rawBuffer) {
      if (!record.rawContent) {
        throw new EmailProcessingError(EMAIL_ERROR_CODES.BODY_MISSING, '原始邮件已过保留期');
      }
      rawBuffer = Buffer.from(record.rawContent, 'base64');
    }
    if (!parsed) {
      ({ parsed, rawBuffer } = await parseMimeEmail(rawBuffer, record.id));
    }

    record.status = 'parsing';
    record.lastAttemptAt = new Date();
    record.attemptHistory = [
      ...(record.attemptHistory || []),
      {
        at: record.lastAttemptAt.toISOString(),
        event: 'attempt_started',
        retryCount: record.retryCount,
        isRetry: Boolean(options.isRetry),
      },
    ];
    record.version += 1;
    await record.save();

    const orderData = parseOrderEmailFromParsed(parsed, rawBuffer, record.id);
    record.parsedData = orderData;
    record.status = 'processing';
    record.errorCode = null;
    record.errorMessage = null;
    record.version += 1;
    await record.save();

    const order = await saveOrderFromEmail(orderData, record.emailUid, {
      emailLogId: record.id,
    });
    await record.reload();
    return { status: record.status, order, record };
  } catch (error) {
    const failedRecord = await markFailure(record, error, { isRetry: options.isRetry });
    logger.warn('邮件处理进入失败状态', {
      emailRecordId: record.id,
      status: failedRecord.status,
      errorCode: failedRecord.errorCode,
      retryCount: failedRecord.retryCount,
    });
    return { status: failedRecord.status, record: failedRecord, error };
  }
}

/**
 * 领取到期重试记录；SKIP LOCKED 保证多 Worker 不重复领取。
 * @param {number} [limit=10] - 最大领取数
 * @returns {Promise<Array<Object>>} 已领取记录
 */
function claimDueRetries(limit = 10) {
  return sequelize.transaction(async transaction => {
    const records = await EmailLog.findAll({
      where: {
        status: 'retry_wait',
        nextRetryAt: { [Op.lte]: new Date() },
      },
      order: [['nextRetryAt', 'ASC']],
      limit,
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });
    for (const record of records) {
      record.status = 'parsing';
      record.nextRetryAt = null;
      record.lastAttemptAt = new Date();
      record.version += 1;
      await record.save({ transaction });
    }
    return records;
  });
}

/**
 * 执行一批到期的持久化重试。
 * @returns {Promise<Array<Object>>} 处理结果
 */
async function processDueRetries() {
  await recoverInterruptedRecords();
  const records = await claimDueRetries();
  return Promise.all(records.map(record => processPersistedRecord(record, { isRetry: true })));
}

/**
 * Worker 中断后把停留过久的解析/入库状态恢复到重试队列。
 * @returns {Promise<number>} 恢复数量
 */
function recoverInterruptedRecords() {
  return sequelize.transaction(async transaction => {
    const records = await EmailLog.findAll({
      where: {
        status: { [Op.in]: ['parsing', 'processing'] },
        lastAttemptAt: { [Op.lte]: new Date(Date.now() - 5 * 60_000) },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });
    for (const record of records) {
      const recoveredAt = new Date();
      record.status = 'retry_wait';
      record.nextRetryAt = recoveredAt;
      record.errorCode = EMAIL_ERROR_CODES.WORKER_INTERRUPTED;
      record.errorMessage = '上次处理被中断，等待恢复';
      record.attemptHistory = [
        ...(record.attemptHistory || []),
        {
          at: recoveredAt.toISOString(),
          event: 'attempt_interrupted',
          errorCode: EMAIL_ERROR_CODES.WORKER_INTERRUPTED,
          retryCount: record.retryCount,
        },
      ];
      record.version += 1;
      await record.save({ transaction });
    }
    return records.length;
  });
}

/**
 * 在邮件记录内追加不含业务明文的管理员操作审计。
 * @param {number} recordId - 邮件记录 ID
 * @param {string} action - 稳定操作名
 * @param {number} userId - 管理员 ID
 * @param {Object} [details] - 非敏感结果信息
 * @returns {Promise<Object>} 更新后的邮件记录
 */
function recordAuditAction(recordId, action, userId, details = {}) {
  return sequelize.transaction(async transaction => {
    const record = await EmailLog.findByPk(recordId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!record) {
      throw new EmailProcessingError(EMAIL_ERROR_CODES.INVALID_STATE, '邮件处理记录不存在');
    }
    record.auditHistory = [
      ...(record.auditHistory || []),
      {
        at: new Date().toISOString(),
        action,
        userId,
        ...details,
      },
    ];
    await record.save({ transaction, hooks: false });
    return record;
  });
}

/**
 * 使用当前解析器生成预览，不创建订单。
 * @param {Object} record - 邮件记录
 * @returns {Promise<Object>} 新解析预览
 */
async function reparsePreview(record) {
  if (!['manual_review', 'retry_wait'].includes(record.status)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.INVALID_STATE, '当前状态不允许重新解析');
  }
  if (!record.rawContent) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.BODY_MISSING, '原始邮件已过保留期');
  }
  const rawBuffer = Buffer.from(record.rawContent, 'base64');
  try {
    const { parsed } = await parseMimeEmail(rawBuffer, record.id);
    const preview = parseOrderEmailFromParsed(parsed, rawBuffer, record.id);
    record.parsedData = preview;
    record.status = 'manual_review';
    record.errorCode = null;
    record.errorMessage = null;
    record.version += 1;
    await record.save();
    return preview;
  } catch (error) {
    await markFailure(record, error);
    throw error;
  }
}

/**
 * 保存经过完整校验的人工草稿。
 * @param {Object} record - 邮件记录
 * @param {Object} draft - 草稿
 * @param {number} expectedVersion - 乐观锁版本
 * @returns {Promise<Object>} 更新记录
 */
function saveManualDraft(record, draft, expectedVersion) {
  const normalized = validateManualOrderData(draft);
  return sequelize.transaction(async transaction => {
    const locked = await EmailLog.findByPk(record.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (locked.version !== Number(expectedVersion)) {
      throw new EmailProcessingError(
        EMAIL_ERROR_CODES.CONCURRENT_MODIFICATION,
        '邮件处理记录已被其他操作更新'
      );
    }
    if (!['manual_review', 'retry_wait'].includes(locked.status)) {
      throw new EmailProcessingError(EMAIL_ERROR_CODES.INVALID_STATE, '当前状态不允许保存草稿');
    }
    locked.manualDraft = normalized;
    locked.version += 1;
    await locked.save({ transaction });
    return locked;
  });
}

/**
 * 校验并将人工草稿入库。
 * @param {Object} record - 邮件记录
 * @param {Object} draft - 草稿
 * @param {number} expectedVersion - 乐观锁版本
 * @param {number} userId - 管理员 ID
 * @returns {Promise<Object>} 订单
 */
function ingestManualDraft(record, draft, expectedVersion, userId) {
  const normalized = validateManualOrderData(draft);
  normalized.emailSubject = record.emailSubject || '';
  normalized.emailFrom = record.emailFrom || '';
  normalized.emailDate = record.emailDate || new Date();
  normalized.rawContent = record.rawContent;
  return saveOrderFromEmail(normalized, record.emailUid, {
    emailLogId: record.id,
    expectedVersion: Number(expectedVersion),
    resolvedBy: userId,
  });
}

/**
 * 人工标记忽略或关联已有订单。
 * @param {Object} record - 邮件记录
 * @param {Object} input - 决议
 * @param {number} userId - 管理员 ID
 * @returns {Promise<Object>} 更新后的记录
 */
function resolveRecord(record, input, userId) {
  if (!['ignored', 'existing_order'].includes(input.resolutionType)) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.INVALID_STATE, '人工处理类型无效');
  }
  const reason = String(input.reason || '').trim();
  if (!reason || reason.length > 500) {
    throw new EmailProcessingError(EMAIL_ERROR_CODES.INVALID_STATE, '处理原因必填且不超过 500 字');
  }

  return sequelize.transaction(async transaction => {
    const locked = await EmailLog.findByPk(record.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (locked.version !== Number(input.version)) {
      throw new EmailProcessingError(
        EMAIL_ERROR_CODES.CONCURRENT_MODIFICATION,
        '邮件处理记录已被其他操作更新'
      );
    }
    if (!['manual_review', 'retry_wait'].includes(locked.status)) {
      throw new EmailProcessingError(EMAIL_ERROR_CODES.INVALID_STATE, '当前状态不允许人工关闭');
    }

    let order = null;
    if (input.resolutionType === 'existing_order') {
      order = await Order.findOne({
        where: {
          orderNumber: String(input.orderNumber || '')
            .trim()
            .toUpperCase(),
        },
        transaction,
      });
      if (!order) {
        throw new EmailProcessingError(EMAIL_ERROR_CODES.ORDER_NUMBER_INVALID, '指定订单不存在');
      }
    }

    locked.status = input.resolutionType === 'ignored' ? 'ignored' : 'superseded';
    locked.processed = true;
    locked.processedAt = new Date();
    locked.success = true;
    locked.orderId = order?.id || null;
    locked.orderNumber = order?.orderNumber || locked.orderNumber;
    locked.resolvedAt = new Date();
    locked.resolutionType = input.resolutionType;
    locked.resolutionReason = reason;
    locked.resolvedBy = userId;
    locked.nextRetryAt = null;
    locked.version += 1;
    await locked.save({ transaction });
    return locked;
  });
}

/**
 * 清除超过 180 天的加密内容，保留状态与操作审计。
 * @returns {Promise<number>} 受影响记录数
 */
async function purgeExpiredContent() {
  const [count] = await EmailLog.update(
    {
      rawContent: null,
      parsedData: null,
      manualDraft: null,
      finalData: null,
    },
    {
      where: {
        retentionExpiresAt: { [Op.lte]: new Date() },
        [Op.or]: [
          { rawContent: { [Op.ne]: null } },
          { parsedData: { [Op.ne]: null } },
          { manualDraft: { [Op.ne]: null } },
          { finalData: { [Op.ne]: null } },
        ],
      },
    }
  );
  return count;
}

/**
 * 更新邮件 Worker 的跨进程心跳与连续失败指标。
 * @param {Object} updates - 状态变化
 * @returns {Promise<Object>} Worker 状态
 */
function updateWorkerState(updates = {}) {
  return sequelize.transaction(async transaction => {
    await EmailWorkerState.findOrCreate({
      where: { id: 1 },
      defaults: { id: 1 },
      transaction,
    });
    const state = await EmailWorkerState.findByPk(1, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    state.heartbeatAt = new Date();
    if (updates.mailboxIdentityHash !== undefined) {
      state.mailboxIdentityHash = updates.mailboxIdentityHash;
    }
    if (updates.workerId !== undefined) state.workerId = updates.workerId;
    if (updates.isConnected !== undefined) state.isConnected = updates.isConnected;
    if (updates.received) state.lastReceivedAt = new Date();
    if (updates.succeeded) {
      state.lastSucceededAt = new Date();
      state.consecutiveFailures = 0;
      state.lastErrorCode = null;
    }
    if (updates.errorCode) {
      state.consecutiveFailures += 1;
      state.lastErrorCode = updates.errorCode;
    }
    await state.save({ transaction });
    return state;
  });
}

/**
 * 查询邮件处理积压与最近时间指标。
 * @returns {Promise<Object>} 指标
 */
async function getMetrics() {
  const [counts, lastReceived, lastSucceeded, recentFailures, workerState] = await Promise.all([
    EmailLog.findAll({
      attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['status'],
      raw: true,
    }),
    EmailLog.max('receivedAt'),
    EmailLog.max('processedAt', { where: { status: 'succeeded' } }),
    EmailLog.count({
      where: {
        status: { [Op.in]: ['retry_wait', 'manual_review'] },
        updatedAt: { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    EmailWorkerState.findByPk(1),
  ]);
  const heartbeatAt = workerState?.heartbeatAt ? new Date(workerState.heartbeatAt) : null;
  let worker = null;
  if (workerState) {
    worker = {
      isConnected: workerState.isConnected,
      isRunning: heartbeatAt ? Date.now() - heartbeatAt.getTime() < 30_000 : false,
      heartbeatAt,
      lastReceivedAt: workerState.lastReceivedAt,
      lastSucceededAt: workerState.lastSucceededAt,
      consecutiveFailures: workerState.consecutiveFailures,
      lastErrorCode: workerState.lastErrorCode,
    };
  }
  return {
    counts: Object.fromEntries(counts.map(row => [row.status, Number(row.count)])),
    lastReceivedAt: lastReceived || null,
    lastSucceededAt: lastSucceeded || null,
    recentFailureCount: recentFailures,
    worker,
  };
}

module.exports = {
  RETENTION_DAYS,
  RETRY_DELAY_MS,
  MAX_RETRY_COUNT,
  TERMINAL_STATUSES,
  createMailboxIdentityHash,
  receiveEmail,
  registerMetadata,
  markIgnored,
  markFailure,
  processPersistedRecord,
  claimDueRetries,
  recoverInterruptedRecords,
  recordAuditAction,
  processDueRetries,
  reparsePreview,
  saveManualDraft,
  ingestManualDraft,
  resolveRecord,
  purgeExpiredContent,
  updateWorkerState,
  getMetrics,
  extractEmailMetadataFromParsed,
};
