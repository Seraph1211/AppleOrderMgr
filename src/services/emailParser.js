/**
 * 邮件解析器
 * @description 解析 NULL AOS Helper 发送的订单通知邮件，提取订单信息
 * @author Seraph
 * @date 2026-07-07
 */

const { simpleParser } = require('mailparser');
const logger = require('../utils/logger');
const { decodeHTMLEntities, stripHTMLTags } = require('../utils/helpers');

/**
 * 解析订单邮件
 * @param {Buffer|string} rawEmail - 原始邮件内容
 * @param {string} emailUid - 邮件唯一标识符
 * @returns {Promise<Object>} 解析后的订单数据
 */
async function parseOrderEmail(rawEmail, emailUid) {
  try {
    logger.info('开始解析邮件', { emailUid });

    // 1. 使用 mailparser 解析邮件
    const parsed = await simpleParser(rawEmail);

    // 2. 获取文本和HTML内容
    const textBody = parsed.text || '';
    const htmlBody = parsed.html || '';

    // 3. 清理内容（移除HTML标签和实体，合并换行）
    let cleanText = stripHTMLTags(decodeHTMLEntities(textBody));
    let cleanHtml = decodeHTMLEntities(htmlBody);

    // 移除多余的换行符，将文本合并为单行（重要：防止产品信息被换行截断）
    cleanText = cleanText.replace(/\n+/g, ' ').replace(/\s+/g, ' ');
    cleanHtml = cleanHtml.replace(/\n+/g, ' ').replace(/\s+/g, ' ');

    logger.debug('邮件内容清理完成', {
      emailUid,
      textLength: cleanText.length,
      htmlLength: cleanHtml.length
    });

    // 4. 提取各个字段
    const appleId = extractAppleId(cleanText);
    const orderDate = extractOrderDate(cleanText);
    const { orderUrl, orderNumber } = extractOrderLink(cleanHtml);
    const productInfo = extractProductInfo(cleanText);

    // 5. 验证必填字段
    validateRequiredFields({ appleId, orderNumber, orderUrl, productInfo });

    // 6. 构建返回数据
    const result = {
      appleId,
      orderNumber,
      orderUrl,
      orderDate,
      products: productInfo.products,
      recipient: {
        name: productInfo.recipientName,
        idLast4: productInfo.recipientIdLast4,
        tag: productInfo.recipientTag
      },
      paymentMethod: productInfo.paymentMethod,
      emailSubject: parsed.subject || '',
      emailFrom: parsed.from?.text || '',
      emailDate: parsed.date || new Date(),
      rawContent: rawEmail.toString('base64') // 保存原始邮件的Base64编码
    };

    logger.info('邮件解析成功', {
      emailUid,
      orderNumber: result.orderNumber,
      appleId: result.appleId,
      productCount: result.products.length
    });

    return result;
  } catch (error) {
    logger.error('邮件解析失败', {
      emailUid,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * 提取 Apple ID
 * @param {string} text - 邮件文本内容
 * @returns {string|null} Apple ID
 */
function extractAppleId(text) {
  // 匹配格式: 亲爱的 ***xxx@xxx.com
  const regex = /\*\*\*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
  const match = text.match(regex);

  if (match) {
    logger.debug('Apple ID 提取成功', { appleId: match[1] });
    return match[1].trim();
  }

  logger.warn('未能提取 Apple ID');
  return null;
}

/**
 * 提取预订时间
 * @param {string} text - 邮件文本内容
 * @returns {Date|null} 订单时间
 */
function extractOrderDate(text) {
  // 匹配格式: 恭喜您于2025/10/8 20:21:58
  const regex = /(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2})/;
  const match = text.match(regex);

  if (match) {
    // 将 / 替换为 - 以符合标准日期格式
    const dateStr = match[1].replace(/\//g, '-');
    const orderDate = new Date(dateStr);

    logger.debug('订单时间提取成功', { orderDate: orderDate.toISOString() });
    return orderDate;
  }

  logger.warn('未能提取订单时间');
  return null;
}

/**
 * 提取订单链接和订单号
 * @param {string} html - 邮件HTML内容
 * @returns {Object} { orderUrl, orderNumber }
 */
function extractOrderLink(html) {
  // 匹配格式: https://www.apple.com.cn/xc/cn/vieworder/W1779769040/xxx@xxx.com
  const regex = /https:\/\/www\.apple\.com\.cn\/xc\/cn\/vieworder\/(W\d{10})\/[^\s'"<>]+/;
  const match = html.match(regex);

  if (match) {
    const orderUrl = match[0];
    const orderNumber = match[1];

    logger.debug('订单链接提取成功', { orderNumber, orderUrl });
    return { orderUrl, orderNumber };
  }

  logger.warn('未能提取订单链接');
  return { orderUrl: null, orderNumber: null };
}

/**
 * 提取产品信息（支持多产品）
 * @param {string} text - 邮件文本内容
 * @returns {Object} 产品信息对象
 */
function extractProductInfo(text) {
  // 匹配完整的产品信息行
  // 格式: 型号1-产品1 x 数量1@型号2-产品2 x 数量2/取机人/身份证后四位/付款方式/-/-/标签
  // 关键：产品部分包含 @ 和 x 数字的结尾模式，用贪婪匹配直到遇到 /取机人/
  const fullInfoRegex = /(.+\sx\s\d+)\/([^/]+)\/([^/]+)\/([^/]+)\/[^/]*\/[^/]*\/(.+)/;
  const match = text.match(fullInfoRegex);

  if (!match) {
    throw new Error('无法解析产品信息：正则匹配失败');
  }

  const productsSection = match[1].trim();
  const recipientName = match[2].trim();
  const recipientIdLast4 = match[3].trim();
  const paymentMethod = match[4].trim();
  const recipientTag = match[5].trim();

  logger.debug('产品信息段落提取成功', {
    productsSection,
    recipientName,
    recipientIdLast4,
    paymentMethod,
    recipientTag
  });

  // 解析多个商品（按 @ 分割）
  const products = parseProducts(productsSection);

  return {
    products,
    recipientName,
    recipientIdLast4,
    paymentMethod,
    recipientTag
  };
}

/**
 * 解析商品列表（支持多商品，@ 分隔）
 * @param {string} productsSection - 商品段落字符串
 * @returns {Array<Object>} 商品数组
 */
function parseProducts(productsSection) {
  const products = [];

  // 按 @ 分割多个商品
  const productItems = productsSection.split('@');

  logger.debug('商品分割完成', {
    productCount: productItems.length,
    items: productItems.map((item, i) => `${i}: ${item}`)
  });

  productItems.forEach((item, index) => {
    // 匹配格式: MG714CH/A-iPhone 17 鼠尾草绿色 256G x 2
    const productRegex = /([A-Z0-9/]+)\s*-\s*(.+?)\s+x\s+(\d+)$/;
    const trimmedItem = item.trim();
    const match = trimmedItem.match(productRegex);

    logger.debug('商品解析尝试', {
      index: index + 1,
      item: trimmedItem,
      matched: !!match
    });

    if (match) {
      const product = {
        model: match[1].trim(),
        name: match[2].trim(),
        quantity: parseInt(match[3], 10),
        image: null // 图片需要从官网爬取
      };

      products.push(product);

      logger.debug('商品解析成功', {
        index: index + 1,
        model: product.model,
        name: product.name,
        quantity: product.quantity
      });
    } else {
      logger.warn('商品解析失败', { index: index + 1, item: trimmedItem });
    }
  });

  if (products.length === 0) {
    throw new Error('未能解析出任何商品');
  }

  return products;
}

/**
 * 验证必填字段
 * @param {Object} data - 待验证的数据
 * @throws {Error} 如果缺少必填字段
 */
function validateRequiredFields(data) {
  const { appleId, orderNumber, orderUrl, productInfo } = data;

  const errors = [];

  if (!appleId) {
    errors.push('缺少 Apple ID');
  }

  if (!orderNumber) {
    errors.push('缺少订单号');
  }

  if (!orderUrl) {
    errors.push('缺少订单链接');
  }

  if (!productInfo || !productInfo.products || productInfo.products.length === 0) {
    errors.push('缺少商品信息');
  }

  if (errors.length > 0) {
    throw new Error(`邮件数据不完整: ${errors.join(', ')}`);
  }

  logger.debug('必填字段验证通过');
}

/**
 * 提取邮件发件人和主题（用于过滤）
 * @param {Buffer|string} rawEmail - 原始邮件内容
 * @returns {Promise<Object>} { from, subject }
 */
async function extractEmailMetadata(rawEmail) {
  try {
    const parsed = await simpleParser(rawEmail);
    return {
      from: parsed.from?.text || '',
      subject: parsed.subject || '',
      date: parsed.date || new Date()
    };
  } catch (error) {
    logger.error('提取邮件元数据失败', { error: error.message });
    return {
      from: '',
      subject: '',
      date: new Date()
    };
  }
}

module.exports = {
  parseOrderEmail,
  extractEmailMetadata
};
