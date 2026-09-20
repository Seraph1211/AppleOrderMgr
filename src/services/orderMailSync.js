const { EmailMailboxCursor, OrderMailState } = require('../models');
const { createEmailScanner } = require('./emailScanner');
const { advanceCursor } = require('./emailScanProgress');
const { getOrderMailConfig, isOrderMailConfigured } = require('./orderMailConfig');
const { receiveOrderMail } = require('./orderMailService');
const { MAX_MESSAGE_BYTES } = require('./orderMailContent');
const logger = require('../utils/logger');

/** 初始化独立只读扫描器；开关关闭时绝不访问真实邮箱。 */
async function startOrderMailSync() {
  try {
    const config = getOrderMailConfig();
    if (!isOrderMailConfigured(config)) throw new Error('订单邮件尚未启用或配置不完整');
    const [state] = await OrderMailState.findOrCreate({
      where: { mailboxIdentityHash: config.identity },
    });
    await state.update({ isConnected: false });
    const scanner = createEmailScanner({
      imapConfig: config.imap,
      mailboxIdentityHash: config.identity,
      readOnly: true,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      loadCursor: async identity => {
        try {
          const [cursor] = await EmailMailboxCursor.findOrCreate({
            where: identity,
            defaults: {
              ...identity,
              bootstrapSince: new Date(Date.now() - config.lookbackDays * 86400000),
            },
          });
          return {
            lastUid: cursor.lastUid === null ? null : Number(cursor.lastUid),
            bootstrapSince: cursor.bootstrapSince,
          };
        } catch (error) {
          logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
          throw error;
        }
      },
      advanceCursor,
      receive: (message, identity) => receiveOrderMail(message, identity, config),
      onState: async updates => {
        try {
          const values = { ...updates };
          delete values.mailboxIdentityHash;
          await OrderMailState.update(values, { where: { mailboxIdentityHash: config.identity } });
        } catch (error) {
          logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
          throw error;
        }
      },
    });
    scanner.start();
    return scanner;
  } catch (error) {
    logger.error('订单邮件扫描器启动失败', { errorType: error.name });
    throw error;
  }
}

module.exports = { startOrderMailSync };
