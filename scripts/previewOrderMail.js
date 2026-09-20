/**
 * 订单邮件隔离库浏览器预览：只使用合成邮件、合成账号和内存SMTP替身。
 * 不启动IMAP、官网抓取或业务调度器。
 */
const crypto = require('crypto');
const express = require('express');
const logger = require('../src/utils/logger');

async function main() {
  try {
    if (
      !/^apple_order_mgr_mail_test_[0-9]+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('预览只允许专用隔离库');
    Object.assign(process.env, {
      ORDER_MAIL_ENABLED: 'true',
      ORDER_MAIL_IMAP_HOST: 'imap.example.invalid',
      ORDER_MAIL_SMTP_HOST: 'smtp.example.invalid',
      ORDER_MAIL_USER: 'sender@example.test',
      ORDER_MAIL_PASSWORD: 'synthetic-password',
      ORDER_MAIL_PASSWORD_FILE: '',
    });
    const models = require('../src/models');
    const service = require('../src/services/orderMailService');
    const { getOrderMailConfig } = require('../src/services/orderMailConfig');
    const config = getOrderMailConfig();
    const password = 'Synthetic-Password-1!';
    for (const [username, permissions] of [
      ['mail_user', ['orders.read', 'order_mail.manage']],
      ['mail_other', ['orders.read']],
    ]) {
      const [user] = await models.User.findOrCreate({
        where: { username },
        defaults: { password, role: 'operator', status: 'active' },
      });
      await user.update({ status: 'active', orderAccess: { mode: 'tags', tags: ['MAIL-A'] } });
      await models.UserPermission.destroy({ where: { userId: user.id } });
      await models.UserPermission.bulkCreate(
        permissions.map(permissionCode => ({
          userId: user.id,
          permissionCode,
          grantedBy: user.id,
        }))
      );
    }
    await models.OrderMailDelivery.destroy({ where: {} });
    await models.OrderMailMessage.destroy({ where: {} });
    await models.OrderMailState.upsert({
      mailboxIdentityHash: config.identity,
      isConnected: true,
      lastScanStartedAt: new Date(),
      lastScanSucceededAt: new Date(),
      lastScanErrorCode: null,
    });
    await models.Order.findOrCreate({
      where: { orderNumber: 'W1234567890' },
      defaults: {
        tag: 'MAIL-A',
        orderDate: new Date(),
        products: [{ name: '合成商品', quantity: 1 }],
      },
    });
    const raw = Buffer.from(
      [
        'From: Apple <a@orders.apple.com>',
        'To: original@vvv8.net',
        'Subject: =?UTF-8?B?' +
          Buffer.from('我们正在处理你的订单 W1234567890').toString('base64') +
          '?=',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary=preview',
        '',
        '--preview',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '这是合成邮件，用于验证订单关联与转发。订单号 W1234567890。不会发送到真实邮箱。',
        '--preview',
        'Content-Type: text/plain',
        'Content-Disposition: attachment; filename=receipt.txt',
        '',
        'Synthetic receipt',
        '--preview--',
      ].join('\r\n')
    );
    await service.receiveOrderMail(
      { rawBuffer: raw, emailUid: 100 },
      {
        mailboxIdentityHash: config.identity,
        uidValidity: 'preview',
      },
      config
    );
    const app = express();
    app.use(express.json());
    app.use(require('../src/middleware/requestLogger')());
    app.use(require('../src/middleware/operationAudit').operationAudit);
    app.use('/api/auth', require('../src/routes/auth'));
    app.use('/api', require('../src/middleware/authMiddleware').authenticate);
    app.get('/api/system/auto-refresh', (_req, res) =>
      res.json({ success: true, data: { isRunning: false } })
    );
    app.use('/api/orders', require('../src/routes/orders'));
    app.use(require('../src/middleware/errorHandler'));
    const server = app.listen(3000);
    const transport = {
      sendMail: options =>
        Promise.resolve({ accepted: [options.to], messageId: crypto.randomUUID() }),
    };
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await models.OrderMailState.update(
          { lastScanSucceededAt: new Date() },
          { where: { mailboxIdentityHash: config.identity } }
        );
        await require('../src/services/orderMailSender').sendNextOrderMail({ transport, config });
      } catch (error) {
        logger.warn('合成邮件预览失败', { errorType: error.name });
      } finally {
        running = false;
      }
    }, 1000);
    const stop = () => {
      clearInterval(timer);
      server.close(() => models.sequelize.close().then(() => process.exit(0)));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    logger.info('订单邮件合成预览已启动，SMTP为内存替身');
  } catch (error) {
    logger.error('订单邮件合成预览启动失败', { errorType: error.name, message: error.message });
    process.exit(1);
  }
}
main();
