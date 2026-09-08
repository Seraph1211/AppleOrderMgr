/**
 * IMAP 邮件监听、回溯、持久化处理与确认服务。
 * @module services/emailService
 */

const { Op } = require('sequelize');
const os = require('os');

const { EmailLog } = require('../models');
const logger = require('../utils/logger');
const { config } = require('../utils/config');
const { parseMimeEmail, extractEmailMetadataFromParsed } = require('./emailParser');
const { EMAIL_ERROR_CODES } = require('./emailErrors');
const emailProcessingService = require('./emailProcessingService');

const { createEmailScanner } = require('./emailScanner');
const emailScanProgress = require('./emailScanProgress');
const RETRY_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
let scanner = null;
let retryTimer = null;
let retentionTimer = null;
let heartbeatTimer = null;
let retryRunning = false;
const inFlight = new Set();
const workerId = `${os.hostname()}:${process.pid}`;

function mailboxIdentity() {
  return {
    host: config.imap.host,
    user: config.imap.user,
    mailbox: config.imap.mailbox,
  };
}

function track(promise) {
  inFlight.add(promise);
  promise.then(
    () => inFlight.delete(promise),
    () => inFlight.delete(promise)
  );
  return promise;
}

const { classifyOrderEmailSource, isOrderEmail } = require('./emailSourcePolicy');

async function updateAckFailure(record) {
  record.imapAckStatus = 'retry_wait';
  record.imapAckRetryCount += 1;
  record.imapAckNextRetryAt = new Date(Date.now() + RETRY_INTERVAL_MS);
  record.imapAckErrorCode = EMAIL_ERROR_CODES.IMAP_TEMPORARY;
  await record.save();
}

async function acknowledgeRecord(record) {
  if (['succeeded', 'not_required'].includes(record.imapAckStatus)) return;
  if (!config.imap.markSeen) {
    record.imapAckStatus = 'not_required';
    record.imapAckNextRetryAt = null;
    record.imapAckErrorCode = null;
    await record.save();
    return;
  }
  try {
    await scanner.addSeenFlag(record);
    record.imapAckStatus = 'succeeded';
    record.imapAckNextRetryAt = null;
    record.imapAckErrorCode = null;
    await record.save();
  } catch (_error) {
    await updateAckFailure(record);
    logger.warn('IMAP 已读确认等待重试', {
      emailRecordId: record.id,
      errorCode: EMAIL_ERROR_CODES.IMAP_TEMPORARY,
    });
  }
}

async function retryPendingAcknowledgements() {
  const status = scanner?.getStatus();
  if (!config.imap.markSeen || !status?.isConnected || !status.uidValidity) {
    return;
  }
  const identityHash = emailProcessingService.createMailboxIdentityHash(mailboxIdentity());
  const records = await EmailLog.findAll({
    where: {
      mailboxIdentityHash: identityHash,
      uidValidity: String(status.uidValidity),
      imapAckStatus: 'retry_wait',
      imapAckNextRetryAt: { [Op.lte]: new Date() },
    },
    order: [['imapAckNextRetryAt', 'ASC']],
    limit: 20,
  });
  await Promise.all(records.map(acknowledgeRecord));
}

async function processReceivedMessage(received, rawBuffer) {
  const record = received.record;
  try {
    if (!received.created) {
      if (emailProcessingService.TERMINAL_STATUSES.has(record.status)) {
        await acknowledgeRecord(record);
      }
      return;
    }

    let parsed;
    try {
      ({ parsed } = await parseMimeEmail(rawBuffer, record.id));
    } catch (error) {
      const failed = await emailProcessingService.markFailure(record, error);
      if (emailProcessingService.TERMINAL_STATUSES.has(failed.status)) {
        await acknowledgeRecord(failed);
      }
      return;
    }

    const metadata = extractEmailMetadataFromParsed(parsed);
    const duplicate = await emailProcessingService.registerMetadata(record, metadata);
    if (duplicate) {
      await record.reload();
      await acknowledgeRecord(record);
      return;
    }

    const sourceDecision = classifyOrderEmailSource(metadata);
    if (!sourceDecision.accepted) {
      const rejectedRecord = await emailProcessingService.rejectSourceEmail(
        record,
        sourceDecision.errorCode
      );
      logger.warn('邮件来源过滤未通过', {
        emailRecordId: rejectedRecord.id,
        errorCode: sourceDecision.errorCode,
        status: rejectedRecord.status,
      });
      await acknowledgeRecord(rejectedRecord);
      return;
    }

    const result = await emailProcessingService.processPersistedRecord(record, {
      parsed,
      rawBuffer,
    });
    if (result.record.status === 'succeeded' || result.record.status === 'superseded') {
      await emailProcessingService.updateWorkerState({ succeeded: true });
    } else if (result.record.errorCode) {
      await emailProcessingService.updateWorkerState({ errorCode: result.record.errorCode });
    }
    if (emailProcessingService.TERMINAL_STATUSES.has(result.record.status)) {
      await acknowledgeRecord(result.record);
    }
  } catch (error) {
    if (record && !emailProcessingService.TERMINAL_STATUSES.has(record.status)) {
      await emailProcessingService.markFailure(record, error).catch(() => {});
    }
    logger.error('邮件接收处理失败', {
      emailRecordId: record?.id || null,
      errorCode: error.code || EMAIL_ERROR_CODES.DATABASE_TEMPORARY,
    });
    await emailProcessingService
      .updateWorkerState({ errorCode: error.code || EMAIL_ERROR_CODES.DATABASE_TEMPORARY })
      .catch(() => {});
  }
}

async function receiveMessage({ rawBuffer, emailUid }, identity) {
  try {
    const received = await emailProcessingService.receiveEmail({
      mailboxIdentity: mailboxIdentity(),
      uidValidity: identity.uidValidity,
      emailUid,
      rawBuffer,
    });
    if (received.created) {
      await emailProcessingService.updateWorkerState({ received: true }).catch(() => {});
    }
    // 接收进度只依赖原文可靠入库；订单处理和 IMAP 确认不占用网络扫描。
    track(processReceivedMessage(received, rawBuffer));
    return { created: received.created };
  } catch (error) {
    logger.error('邮件原文持久化失败', { errorCode: EMAIL_ERROR_CODES.DATABASE_TEMPORARY });
    throw error;
  }
}

function clearBackgroundTimers() {
  for (const timer of [retryTimer, retentionTimer, heartbeatTimer]) clearInterval(timer);
  retryTimer = retentionTimer = heartbeatTimer = null;
}

function startBackgroundTimers() {
  if (heartbeatTimer) return;
  retryTimer = setInterval(() => {
    if (retryRunning) return;
    retryRunning = true;
    track(
      emailProcessingService
        .processDueRetries()
        .then(results =>
          Promise.all(
            results
              .filter(result => emailProcessingService.TERMINAL_STATUSES.has(result.record.status))
              .map(result => acknowledgeRecord(result.record))
          )
        )
        .then(retryPendingAcknowledgements)
        .catch(() =>
          logger.error('邮件持久化重试批次失败', {
            errorCode: EMAIL_ERROR_CODES.DATABASE_TEMPORARY,
          })
        )
        .finally(() => {
          retryRunning = false;
        })
    );
  }, RETRY_INTERVAL_MS);
  retentionTimer = setInterval(() => {
    track(
      emailProcessingService.purgeExpiredContent().catch(() => {
        logger.error('邮件保留期限清理失败', { errorCode: EMAIL_ERROR_CODES.DATABASE_TEMPORARY });
      })
    );
  }, RETENTION_INTERVAL_MS);
  heartbeatTimer = setInterval(() => {
    track(
      emailProcessingService
        .updateWorkerState({
          workerId,
        })
        .catch(() => {})
    );
  }, HEARTBEAT_INTERVAL_MS);
  for (const timer of [retryTimer, retentionTimer, heartbeatTimer]) timer.unref?.();
}

/**
 * 启动 UID 扫描和持久化处理重试，重复启动不会建立额外连接。
 * @returns {void}
 */
function startEmailService() {
  if (scanner) return;
  scanner = createEmailScanner({
    imapConfig: config.imap,
    mailboxIdentityHash: emailProcessingService.createMailboxIdentityHash(mailboxIdentity()),
    loadCursor: emailScanProgress.loadCursor,
    advanceCursor: emailScanProgress.advanceCursor,
    receive: receiveMessage,
    onState: updates => emailProcessingService.updateWorkerState({ ...updates, workerId }),
  });
  startBackgroundTimers();
  scanner.start();
  track(emailProcessingService.processDueRetries().catch(() => []));
}

/**
 * 取消网络等待并有界等待可靠处理，未完成记录由持久化重试恢复。
 * @returns {Promise<void>}
 */
async function stopEmailService() {
  try {
    clearBackgroundTimers();
    const activeScanner = scanner;
    let timer;
    await Promise.race([
      Promise.allSettled([
        activeScanner?.stop(),
        ...inFlight,
        emailProcessingService.updateWorkerState({ isConnected: false }).catch(() => {}),
      ]),
      new Promise(resolve => {
        timer = setTimeout(resolve, STOP_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    scanner = null;
  } catch (_error) {
    logger.warn('邮件服务停止未完整收敛', { errorCode: EMAIL_ERROR_CODES.IMAP_TEMPORARY });
  }
}

/**
 * 获取本进程扫描状态；API 应使用跨进程指标。
 * @returns {Object} 连接和扫描状态
 */
function getServiceStatus() {
  return {
    ...scanner?.getStatus(),
    inFlightCount: inFlight.size,
    host: config.imap.host,
    mailbox: config.imap.mailbox,
  };
}

module.exports = {
  startEmailService,
  stopEmailService,
  getServiceStatus,
  classifyOrderEmailSource,
  isOrderEmail,
};
