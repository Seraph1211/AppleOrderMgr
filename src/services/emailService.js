/**
 * 邮件监听服务
 * @description 使用 IMAP IDLE 监听邮箱，实时接收订单通知邮件
 * @author Seraph
 * @date 2026-07-07
 */

const Imap = require('node-imap');
const logger = require('../utils/logger');
const { config } = require('../utils/config');
const { parseOrderEmail, extractEmailMetadata } = require('./emailParser');
const { saveOrderFromEmail } = require('./orderService');

// IMAP 连接实例
let imapConnection = null;
let isConnected = false;
let reconnectTimer = null;

// 并发控制标志
let isProcessing = false;

// 邮件重试计数器 (uid -> retryCount)
const emailRetryCount = new Map();

/**
 * 启动邮件监听服务
 */
function startEmailService() {
  try {
    logger.info('启动邮件监听服务...');

    // 创建 IMAP 连接
    imapConnection = new Imap({
      user: config.imap.user,
      password: config.imap.password,
      host: config.imap.host,
      port: config.imap.port,
      tls: config.imap.tls,
      tlsOptions: { rejectUnauthorized: false },
      keepalive: true,
      connTimeout: 30000, // 连接超时 30秒
      authTimeout: 10000  // 认证超时 10秒
    });

    // 绑定事件监听器
    setupEventHandlers();

    // 连接到邮箱
    imapConnection.connect();

    logger.info('IMAP 连接请求已发送', {
      host: config.imap.host,
      port: config.imap.port,
      user: config.imap.user
    });
  } catch (error) {
    logger.error('启动邮件服务失败', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * 停止邮件监听服务
 */
function stopEmailService() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (imapConnection) {
    logger.info('正在关闭 IMAP 连接...');
    imapConnection.end();
    imapConnection = null;
    isConnected = false;
  }
}

/**
 * 设置 IMAP 事件处理器
 */
function setupEventHandlers() {
  // 连接就绪事件
  imapConnection.once('ready', onConnectionReady);

  // 连接错误事件
  imapConnection.on('error', onConnectionError);

  // 连接结束事件
  imapConnection.once('end', onConnectionEnd);

  // 连接关闭事件
  imapConnection.once('close', onConnectionClose);
}

/**
 * 连接就绪处理器
 */
function onConnectionReady() {
  logger.info('✅ IMAP 连接成功');
  isConnected = true;

  // 发送 IMAP ID 信息（163 邮箱要求）
  try {
    const clientId = {
      name: 'AppleOrderManager',
      version: '1.0.0',
      vendor: 'Seraph',
      'support-email': config.imap.user
    };

    // 使用 id() 方法发送 ID 命令
    imapConnection.id(clientId, (err) => {
      if (err) {
        logger.warn('发送 IMAP ID 失败', { error: err.message });
      } else {
        logger.debug('✅ IMAP ID 已发送', clientId);
      }

      // 继续打开邮箱
      openMailbox();
    });
  } catch (error) {
    logger.error('IMAP ID 发送异常', { error: error.message });
    // 即使失败也尝试打开邮箱
    openMailbox();
  }
}

/**
 * 打开邮箱
 */
function openMailbox() {
  imapConnection.openBox(config.imap.mailbox, false, (err, box) => {
    if (err) {
      logger.error('打开邮箱失败', { error: err.message });
      return;
    }

    logger.info('✅ 邮箱已打开', {
      mailbox: config.imap.mailbox,
      totalMessages: box.messages.total,
      newMessages: box.messages.new
    });

    // 监听新邮件
    imapConnection.on('mail', onNewMail);

    // 处理现有未读邮件
    processUnreadEmails();
  });
}

/**
 * 连接错误处理器
 */
function onConnectionError(err) {
  logger.error('IMAP 连接错误', {
    error: err.message,
    code: err.code,
    stack: err.stack
  });

  // 连接失败后尝试重连
  scheduleReconnect();
}

/**
 * 连接结束处理器
 */
function onConnectionEnd() {
  logger.warn('IMAP 连接已结束');
  isConnected = false;
}

/**
 * 连接关闭处理器
 */
function onConnectionClose(hadError) {
  logger.warn('IMAP 连接已关闭', { hadError });
  isConnected = false;

  if (hadError) {
    scheduleReconnect();
  }
}

/**
 * 新邮件到达处理器
 */
function onNewMail(numNewMsgs) {
  logger.info('📬 收到新邮件', { count: numNewMsgs });

  // 检查是否正在处理
  if (isProcessing) {
    logger.debug('正在处理邮件，跳过本次触发');
    return;
  }

  // 处理新邮件
  processUnreadEmails();
}

/**
 * 处理未读邮件
 */
async function processUnreadEmails() {
  // 检查是否正在处理
  if (isProcessing) {
    logger.debug('已有处理任务在运行，跳过');
    return;
  }

  try {
    // 设置处理标志
    isProcessing = true;
    logger.debug('开始处理未读邮件，设置 isProcessing = true');

    // 搜索未读邮件
    imapConnection.search(['UNSEEN'], (err, results) => {
      if (err) {
        logger.error('搜索邮件失败', { error: err.message });
        isProcessing = false;
        return;
      }

      if (!results || results.length === 0) {
        logger.debug('没有未读邮件');
        isProcessing = false;
        return;
      }

      logger.info('找到未读邮件', { count: results.length });

      // 批量获取邮件（不自动标记已读）
      const fetch = imapConnection.fetch(results, {
        bodies: '',
        markSeen: false // 不自动标记已读
      });

      let processedCount = 0;
      const totalCount = results.length;

      fetch.on('message', (msg, seqno) => {
        onMessageFetch(msg, seqno, () => {
          processedCount++;

          // 所有邮件处理完成
          if (processedCount === totalCount) {
            logger.info('本批邮件处理完成', { total: totalCount });

            // 重置处理标志
            isProcessing = false;
            logger.debug('重置 isProcessing = false');

            // 再次检查是否有新的未读邮件
            checkForMoreUnreadEmails();
          }
        });
      });

      fetch.once('error', (err) => {
        logger.error('获取邮件失败', { error: err.message });
        isProcessing = false;
      });

      fetch.once('end', () => {
        logger.debug('邮件获取流结束');
      });
    });
  } catch (error) {
    logger.error('处理未读邮件异常', { error: error.message, stack: error.stack });
    isProcessing = false;
  }
}

/**
 * 邮件获取处理器
 */
function onMessageFetch(msg, seqno, onComplete) {
  logger.debug('开始获取邮件', { seqno });

  let emailUid = null;
  let emailBuffer = Buffer.alloc(0);

  // 获取邮件 UID
  msg.once('attributes', (attrs) => {
    emailUid = attrs.uid;
    logger.debug('邮件 UID 获取成功', { seqno, uid: emailUid });
  });

  // 获取邮件内容
  msg.on('body', (stream, _info) => {
    const chunks = [];

    stream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    stream.once('end', () => {
      emailBuffer = Buffer.concat(chunks);
      logger.debug('邮件内容下载完成', {
        seqno,
        uid: emailUid,
        size: emailBuffer.length
      });
    });
  });

  // 邮件处理完成
  msg.once('end', async () => {
    logger.info('邮件下载完成，开始处理', { seqno, uid: emailUid });

    let shouldMarkAsRead = false;

    try {
      // 提取邮件元数据（发件人、主题）
      const metadata = await extractEmailMetadata(emailBuffer);

      logger.debug('邮件元数据', {
        uid: emailUid,
        from: metadata.from,
        subject: metadata.subject,
        date: metadata.date
      });

      // 过滤邮件（只处理 NULL AOS Helper 的邮件）
      if (!isOrderEmail(metadata)) {
        logger.info('跳过非订单邮件', {
          uid: emailUid,
          from: metadata.from,
          subject: metadata.subject
        });
        // 非订单邮件也标记已读，避免重复处理
        shouldMarkAsRead = true;
        onComplete && onComplete();
        return;
      }

      // 解析邮件
      const orderData = await parseOrderEmail(emailBuffer, emailUid.toString());

      // 保存到数据库
      await saveOrderFromEmail(orderData, emailUid.toString());

      logger.info('✅ 订单处理成功', {
        uid: emailUid,
        orderNumber: orderData.orderNumber
      });

      // 成功处理的订单邮件标记为已读
      shouldMarkAsRead = true;

      // 清除重试计数
      emailRetryCount.delete(emailUid);

    } catch (error) {
      logger.error('邮件处理失败', {
        seqno,
        uid: emailUid,
        error: error.message,
        stack: error.stack
      });

      // 判断错误类型和重试次数
      const retryCount = (emailRetryCount.get(emailUid) || 0) + 1;
      const isPermanent = isPermanentError(error);

      if (isPermanent) {
        // 永久性错误：立即标记已读，不再重试
        logger.error('检测到永久性错误，标记已读', {
          uid: emailUid,
          errorType: error.name,
          errorMessage: error.message
        });
        shouldMarkAsRead = true;
        emailRetryCount.delete(emailUid);
      } else if (retryCount >= 3) {
        // 临时性错误但重试次数超限：标记已读
        logger.error('重试次数超限，标记已读', {
          uid: emailUid,
          retryCount,
          errorType: error.name
        });
        shouldMarkAsRead = true;
        emailRetryCount.delete(emailUid);
      } else {
        // 临时性错误且未超限：保持未读，等待重试
        emailRetryCount.set(emailUid, retryCount);
        logger.warn('临时性错误，保持未读等待重试', {
          uid: emailUid,
          retryCount,
          maxRetry: 3,
          errorType: error.name
        });
        shouldMarkAsRead = false;
      }
    } finally {
      // 选择性标记已读
      if (shouldMarkAsRead && emailUid) {
        markEmailAsRead(emailUid);
      }

      onComplete && onComplete();
    }
  });
}

/**
 * 判断是否为永久性错误
 * @param {Error} error - 错误对象
 * @returns {boolean}
 */
function isPermanentError(error) {
  // 数据验证错误（字段格式、长度等）
  if (error.name === 'SequelizeValidationError') {
    return true;
  }

  // 唯一约束冲突（订单已存在）
  if (error.name === 'SequelizeUniqueConstraintError') {
    return true;
  }

  // 邮件解析错误（数据不完整）
  if (error.message && error.message.includes('邮件数据不完整')) {
    return true;
  }

  // 外键约束错误
  if (error.name === 'SequelizeForeignKeyConstraintError') {
    return true;
  }

  // 其他为临时错误（数据库连接、网络等）
  return false;
}

/**
 * 判断是否为订单邮件
 * @param {Object} metadata - 邮件元数据
 * @returns {boolean}
 */
function isOrderEmail(metadata) {
  const { from, subject } = metadata;

  // 检查主题是否包含关键词
  const hasOrderKeyword = subject.includes('NULL') ||
    subject.includes('预订助手') ||
    subject.includes('预订成功');

  // 测试阶段：只要主题符合就处理
  // 生产环境需要加上发件人验证
  return hasOrderKeyword;
}

/**
 * 标记邮件为已读
 * @param {number} uid - 邮件 UID
 */
function markEmailAsRead(uid) {
  try {
    imapConnection.addFlags(uid, '\\Seen', (err) => {
      if (err) {
        logger.error('标记邮件已读失败', { uid, error: err.message });
      } else {
        logger.debug('邮件已标记为已读', { uid });
      }
    });
  } catch (error) {
    logger.error('标记已读异常', { uid, error: error.message });
  }
}

/**
 * 处理完成后检查是否还有未读邮件
 */
function checkForMoreUnreadEmails() {
  // 延迟 500ms，给服务器时间处理标记已读命令
  setTimeout(() => {
    try {
      imapConnection.search(['UNSEEN'], (err, results) => {
        if (err) {
          logger.error('检查未读邮件失败', { error: err.message });
          return;
        }

        if (results && results.length > 0) {
          logger.info('发现新的未读邮件，立即处理', { count: results.length });
          processUnreadEmails();
        } else {
          logger.debug('没有更多未读邮件');
        }
      });
    } catch (error) {
      logger.error('检查未读邮件异常', { error: error.message });
    }
  }, 500);
}

/**
 * 安排重连
 */
function scheduleReconnect() {
  if (reconnectTimer) {
    return; // 已经在重连中
  }

  const delay = 30000; // 30秒后重连

  logger.info('将在 30 秒后尝试重连...');

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (!isConnected) {
      logger.info('尝试重新连接...');
      startEmailService();
    }
  }, delay);
}

/**
 * 获取服务状态
 * @returns {Object} 服务状态
 */
function getServiceStatus() {
  return {
    isConnected,
    host: config.imap.host,
    port: config.imap.port,
    user: config.imap.user,
    mailbox: config.imap.mailbox
  };
}

module.exports = {
  startEmailService,
  stopEmailService,
  getServiceStatus
};
