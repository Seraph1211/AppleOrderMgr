/**
 * IMAP 邮件监听、回溯、持久化处理与确认服务。
 * @module services/emailService
 */

const { Op } = require('sequelize');
const Imap = require('node-imap');
const os = require('os');

const { EmailLog } = require('../models');
const logger = require('../utils/logger');
const { config } = require('../utils/config');
const { parseMimeEmail, extractEmailMetadataFromParsed } = require('./emailParser');
const { EMAIL_ERROR_CODES } = require('./emailErrors');
const emailProcessingService = require('./emailProcessingService');

const RECONNECT_DELAY_MS = 30_000;
const RETRY_INTERVAL_MS = 60_000;
const BACKFILL_INTERVAL_MS = 10 * 60_000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const STARTUP_LOOKBACK_MS = 24 * 60 * 60_000;
const PERIODIC_LOOKBACK_MS = 30 * 60_000;

let imapConnection = null;
let isConnected = false;
let reconnectTimer = null;
let shouldReconnect = false;
let isProcessing = false;
let pendingMailCheck = false;
let currentUidValidity = null;
let retryTimer = null;
let backfillTimer = null;
let retentionTimer = null;
let heartbeatTimer = null;
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

/**
 * 判断是否为订单邮件。
 * @param {Object} metadata - MIME 元数据
 * @returns {boolean} 是否通过主题与 From 白名单
 */
function isOrderEmail(metadata) {
  const { subject = '', fromAddresses = [] } = metadata;
  const hasOrderKeyword =
    subject.includes('NULL') || subject.includes('预订助手') || subject.includes('预订成功');
  if (!hasOrderKeyword) {
    return false;
  }
  if (config.imap.allowedSenders.length === 0) {
    return config.app.env !== 'production';
  }
  return fromAddresses.some(address => config.imap.allowedSenders.includes(address));
}

async function updateAckFailure(record) {
  record.imapAckStatus = 'retry_wait';
  record.imapAckRetryCount += 1;
  record.imapAckNextRetryAt = new Date(Date.now() + RETRY_INTERVAL_MS);
  record.imapAckErrorCode = EMAIL_ERROR_CODES.IMAP_TEMPORARY;
  await record.save();
}

function addSeenFlag(uid) {
  return new Promise((resolve, reject) => {
    if (!imapConnection || !isConnected) {
      reject(new Error('IMAP 未连接'));
      return;
    }
    imapConnection.addFlags(uid, '\\Seen', error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function acknowledgeRecord(record) {
  if (!config.imap.markSeen) {
    record.imapAckStatus = 'not_required';
    record.imapAckNextRetryAt = null;
    record.imapAckErrorCode = null;
    await record.save();
    return;
  }
  try {
    await addSeenFlag(record.emailUid);
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
  if (!config.imap.markSeen || !isConnected || !currentUidValidity) {
    return;
  }
  const identityHash = emailProcessingService.createMailboxIdentityHash(mailboxIdentity());
  const records = await EmailLog.findAll({
    where: {
      mailboxIdentityHash: identityHash,
      uidValidity: String(currentUidValidity),
      imapAckStatus: 'retry_wait',
      imapAckNextRetryAt: { [Op.lte]: new Date() },
    },
    order: [['imapAckNextRetryAt', 'ASC']],
    limit: 20,
  });
  await Promise.all(records.map(acknowledgeRecord));
}

async function processReceivedMessage(rawBuffer, emailUid) {
  let record = null;
  try {
    const received = await emailProcessingService.receiveEmail({
      mailboxIdentity: mailboxIdentity(),
      uidValidity: currentUidValidity,
      emailUid,
      rawBuffer,
    });
    record = received.record;
    await emailProcessingService.updateWorkerState({ received: true });

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

    if (!isOrderEmail(metadata)) {
      await emailProcessingService.markIgnored(record);
      await acknowledgeRecord(record);
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

function readFetchedMessage(msg, seqno) {
  return new Promise((resolve, reject) => {
    let emailUid = null;
    const chunks = [];
    let streamError = null;

    msg.once('attributes', attrs => {
      emailUid = attrs.uid;
    });
    msg.on('body', stream => {
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.once('error', error => {
        streamError = error;
      });
    });
    msg.once('error', reject);
    msg.once('end', () => {
      if (streamError) {
        reject(streamError);
        return;
      }
      if (emailUid === null || emailUid === undefined) {
        reject(new Error(`邮件 ${seqno} 缺少 UID`));
        return;
      }
      resolve({ emailUid, rawBuffer: Buffer.concat(chunks) });
    });
  });
}

function fetchSearchResults(results) {
  return new Promise((resolve, reject) => {
    const messagePromises = [];
    const fetch = imapConnection.fetch(results, { bodies: '', markSeen: false });
    fetch.on('message', (msg, seqno) => {
      const promise = readFetchedMessage(msg, seqno)
        .then(({ emailUid, rawBuffer }) => processReceivedMessage(rawBuffer, emailUid))
        .catch(error => {
          logger.error('邮件正文流读取失败', {
            errorCode: EMAIL_ERROR_CODES.IMAP_TEMPORARY,
            sequenceNumber: seqno,
          });
          throw error;
        });
      messagePromises.push(track(promise));
    });
    fetch.once('error', reject);
    fetch.once('end', async () => {
      const settled = await Promise.allSettled(messagePromises);
      const failedCount = settled.filter(result => result.status === 'rejected').length;
      if (failedCount > 0) {
        logger.warn('邮件批次存在正文流失败', { failedCount, total: settled.length });
      }
      resolve();
    });
  });
}

/**
 * 按 IMAP 搜索条件处理邮件。
 * @param {Array} criteria - node-imap 搜索条件
 * @returns {Promise<void>}
 */
async function processEmails(criteria) {
  if (!imapConnection || !isConnected || !shouldReconnect) {
    return;
  }
  if (isProcessing) {
    pendingMailCheck = true;
    return;
  }

  isProcessing = true;
  try {
    const results = await new Promise((resolve, reject) => {
      imapConnection.search(criteria, (error, matches) => {
        if (error) {
          reject(error);
        } else {
          resolve(matches || []);
        }
      });
    });
    if (results.length > 0) {
      logger.info('开始处理邮件批次', { count: results.length });
      await fetchSearchResults(results);
    }
  } catch (_error) {
    logger.error('IMAP 邮件批次失败', { errorCode: EMAIL_ERROR_CODES.IMAP_TEMPORARY });
  } finally {
    isProcessing = false;
    if (pendingMailCheck && shouldReconnect) {
      pendingMailCheck = false;
      await processEmails(['UNSEEN']);
    }
  }
}

function clearBackgroundTimers() {
  for (const timer of [retryTimer, backfillTimer, retentionTimer, heartbeatTimer]) {
    if (timer) {
      clearInterval(timer);
    }
  }
  retryTimer = null;
  backfillTimer = null;
  retentionTimer = null;
  heartbeatTimer = null;
}

function startBackgroundTimers() {
  clearBackgroundTimers();
  retryTimer = setInterval(() => {
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
        .catch(error => {
          logger.error('邮件持久化重试批次失败', {
            errorCode: error.code || EMAIL_ERROR_CODES.DATABASE_TEMPORARY,
          });
        })
    );
  }, RETRY_INTERVAL_MS);
  backfillTimer = setInterval(() => {
    track(processEmails([['SINCE', new Date(Date.now() - PERIODIC_LOOKBACK_MS)]]));
  }, BACKFILL_INTERVAL_MS);
  retentionTimer = setInterval(() => {
    track(
      emailProcessingService.purgeExpiredContent().catch(error => {
        logger.error('邮件保留期限清理失败', {
          errorCode: error.code || EMAIL_ERROR_CODES.DATABASE_TEMPORARY,
        });
      })
    );
  }, RETENTION_INTERVAL_MS);
  heartbeatTimer = setInterval(() => {
    track(
      emailProcessingService
        .updateWorkerState({
          mailboxIdentityHash: emailProcessingService.createMailboxIdentityHash(mailboxIdentity()),
          workerId,
          isConnected,
        })
        .catch(() => {})
    );
  }, HEARTBEAT_INTERVAL_MS);
  retryTimer.unref?.();
  backfillTimer.unref?.();
  retentionTimer.unref?.();
  heartbeatTimer.unref?.();
}

function scheduleReconnect() {
  if (!shouldReconnect || reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!isConnected && shouldReconnect) {
      startEmailService();
    }
  }, RECONNECT_DELAY_MS);
  reconnectTimer.unref?.();
}

function openMailbox() {
  imapConnection.openBox(config.imap.mailbox, false, (error, box) => {
    if (error) {
      logger.error('打开邮箱失败', { errorCode: EMAIL_ERROR_CODES.IMAP_TEMPORARY });
      isConnected = false;
      imapConnection.end();
      scheduleReconnect();
      return;
    }
    currentUidValidity = String(box.uidvalidity || 'unknown');
    imapConnection.on('mail', count => {
      logger.info('收到新邮件事件', { count });
      track(processEmails(['UNSEEN']));
    });
    startBackgroundTimers();
    track(processEmails([['SINCE', new Date(Date.now() - STARTUP_LOOKBACK_MS)]]));
    track(emailProcessingService.processDueRetries().catch(() => []));
    track(emailProcessingService.purgeExpiredContent().catch(() => 0));
  });
}

function setupEventHandlers() {
  imapConnection.once('ready', () => {
    isConnected = true;
    track(
      emailProcessingService
        .updateWorkerState({
          mailboxIdentityHash: emailProcessingService.createMailboxIdentityHash(mailboxIdentity()),
          workerId,
          isConnected: true,
        })
        .catch(() => {})
    );
    try {
      imapConnection.id(
        {
          name: 'AppleOrderManager',
          version: '1.0.0',
          vendor: 'Seraph',
          'support-email': config.imap.user,
        },
        error => {
          if (error) {
            logger.warn('发送 IMAP ID 失败', { errorCode: EMAIL_ERROR_CODES.IMAP_TEMPORARY });
          }
          openMailbox();
        }
      );
    } catch (_error) {
      openMailbox();
    }
  });
  imapConnection.on('error', () => {
    isConnected = false;
    track(
      emailProcessingService
        .updateWorkerState({
          isConnected: false,
          errorCode: EMAIL_ERROR_CODES.IMAP_TEMPORARY,
        })
        .catch(() => {})
    );
    logger.error('IMAP 连接错误', { errorCode: EMAIL_ERROR_CODES.IMAP_TEMPORARY });
    scheduleReconnect();
  });
  imapConnection.once('end', () => {
    isConnected = false;
    track(emailProcessingService.updateWorkerState({ isConnected: false }).catch(() => {}));
    scheduleReconnect();
  });
  imapConnection.once('close', () => {
    isConnected = false;
    track(emailProcessingService.updateWorkerState({ isConnected: false }).catch(() => {}));
    scheduleReconnect();
  });
}

/**
 * 启动邮件监听服务。
 * @returns {void}
 */
function startEmailService() {
  shouldReconnect = true;
  imapConnection = new Imap({
    user: config.imap.user,
    password: config.imap.password,
    host: config.imap.host,
    port: config.imap.port,
    tls: config.imap.tls,
    tlsOptions: config.imap.tlsOptions,
    keepalive: true,
    connTimeout: 30_000,
    authTimeout: 10_000,
  });
  setupEventHandlers();
  imapConnection.connect();
  logger.info('IMAP 连接请求已发送', {
    host: config.imap.host,
    port: config.imap.port,
  });
}

/**
 * 停止领取新邮件并等待在途处理到达安全停止点。
 * @returns {Promise<void>}
 */
async function stopEmailService() {
  shouldReconnect = false;
  pendingMailCheck = false;
  clearBackgroundTimers();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
  if (imapConnection) {
    imapConnection.end();
  }
  imapConnection = null;
  isConnected = false;
  currentUidValidity = null;
  await emailProcessingService.updateWorkerState({ isConnected: false }).catch(() => {});
}

/**
 * 获取邮件 Worker 进程内连接状态。
 * @returns {Object} 状态
 */
function getServiceStatus() {
  return {
    isConnected,
    host: config.imap.host,
    port: config.imap.port,
    user: config.imap.user,
    mailbox: config.imap.mailbox,
    uidValidity: currentUidValidity,
    isProcessing,
    inFlightCount: inFlight.size,
  };
}

module.exports = {
  startEmailService,
  stopEmailService,
  getServiceStatus,
  isOrderEmail,
  processEmails,
};
