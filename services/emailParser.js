const mailparser = require('mailparser').simpleParser;

/**
 * 解析 NULL 预订助手的订单邮件
 * @param {string} rawEmail - 原始邮件内容
 * @returns {Object} 解析后的订单数据
 */
async function parseOrderEmail(rawEmail) {
  // 解析邮件
  const parsed = await mailparser(rawEmail);

  // 提取 HTML 或文本内容
  const textBody = parsed.text || '';

  // 1. 提取 Apple ID
  const appleIdMatch = textBody.match(/\*\*\*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const appleId = appleIdMatch ? appleIdMatch[1] : null;

  // 2. 提取预订时间
  const dateMatch = textBody.match(/(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2})/);
  const orderDate = dateMatch ? new Date(dateMatch[1].replace(/\//g, '-')) : null;

  // 3. 提取订单链接和订单号
  const linkMatch = textBody.match(/https:\/\/www\.apple\.com\.cn\/xc\/cn\/vieworder\/([^\/'"]+)\/[^\s]+/);
  const orderUrl = linkMatch ? linkMatch[0] : null;
  const orderNumber = linkMatch ? linkMatch[1] : null;

  // 4. 提取产品信息（支持多商品，用 @ 分隔）
  // 格式: 型号-产品详情 x 数量@型号-产品详情 x 数量/取机人/身份证/付款方式/-/-/标签
  const productRegex = /([A-Z0-9]+\/[A-Z])\s*-\s*(.+?)\s+x\s+(\d+)(?:@|\/)/g;
  const fullInfoMatch = textBody.match(/([A-Z0-9\/]+-.+?)\/([^\/]+)\/([^\/]+)\/([^\/]+)\/[^\/]+\/[^\/]+\/(.+)/);

  if (!fullInfoMatch) {
    throw new Error('无法解析邮件中的产品信息');
  }

  // 提取产品部分和取机人部分
  const productsAndRecipient = fullInfoMatch[0];
  const recipientName = fullInfoMatch[2].trim();
  const recipientIdLast4 = fullInfoMatch[3].trim();
  const paymentMethod = fullInfoMatch[4].trim();
  const recipientTag = fullInfoMatch[5].trim();

  // 解析多个商品（按 @ 分割）
  const products = [];
  const productsPart = productsAndRecipient.split('/')[0]; // 取第一个 / 之前的部分
  const productItems = productsPart.split('@');

  productItems.forEach(item => {
    const productMatch = item.match(/([A-Z0-9]+\/[A-Z])\s*-\s*(.+?)\s+x\s+(\d+)$/);
    if (productMatch) {
      products.push({
        modelId: productMatch[1].trim(),
        name: productMatch[2].trim(),
        quantity: parseInt(productMatch[3])
      });
    }
  });

  return {
    appleId,
    orderNumber,
    orderUrl,
    orderDate,
    products,
    recipient: {
      name: recipientName,
      idLast4: recipientIdLast4,
      tag: recipientTag
    },
    paymentMethod,
    emailRaw: rawEmail
  };
}

module.exports = { parseOrderEmail };
