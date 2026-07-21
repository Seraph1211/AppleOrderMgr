/**
 * 测试邮件发送脚本
 * 模拟 NULL AOS Helper 发送订单通知邮件
 */

const nodemailer = require('nodemailer');
const logger = require('../src/utils/logger');

// 创建测试邮件传输器（使用 163 邮箱发送）
const transporter = nodemailer.createTransport({
  host: 'smtp.163.com',
  port: 465,
  secure: true,
  auth: {
    user: '18874504636@163.com',
    pass: 'RSh96WV5cTNfcRXa' // 授权码
  }
});

// 构造符合 NULL AOS Helper 格式的测试邮件
const testEmailHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
</head>
<body>
    <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>NULL预订助手提交预订成功通知</h2>
        <p>亲爱的 <strong>***maiwa5640@163.com</strong></p>
        <p>您的预订已成功提交到 Apple Store，订单详情如下：</p>

        <div style="background-color: #f5f5f5; padding: 15px; margin: 20px 0; border-radius: 5px;">
            <p><strong>订单信息：</strong></p>
            <p>MUX23CH/A-iPhone 16 Pro Max 钛沙色 512GB x 2@MWP33CH/A-妙控键盘 x 1/张三/1234/支付宝/-/-/测试订单</p>

            <p style="margin-top: 15px;"><strong>Apple ID：</strong> test@example.com</p>

            <p style="margin-top: 15px;"><strong>订单链接：</strong></p>
            <p><a href="https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test@example.com" style="color: #0066cc;">https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test@example.com</a></p>
        </div>

        <p>请及时登录 Apple Store 查看订单状态。</p>

        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
        <p style="color: #666; font-size: 12px;">
            此邮件由 NULL 预订助手自动发送，请勿直接回复。<br>
            如有疑问，请联系客服。
        </p>
    </div>
</body>
</html>
`;

async function sendTestEmail() {
  try {
    logger.info('开始发送测试邮件...');

    const info = await transporter.sendMail({
      from: '"NULL预订助手" <18874504636@163.com>',
      to: '18874504636@163.com',
      subject: 'NULL预订助手提交预订成功通知',
      html: testEmailHTML
    });

    logger.info('✅ 测试邮件发送成功', {
      messageId: info.messageId,
      response: info.response
    });

    logger.info('等待 5 秒后检查邮件是否到达...');

    setTimeout(() => {
      logger.info('请检查邮件监听服务是否收到并处理了邮件');
      process.exit(0);
    }, 5000);

  } catch (error) {
    logger.error('发送测试邮件失败', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

sendTestEmail();
