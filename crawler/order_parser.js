const cheerio = require('cheerio');

/**
 * 解析 Apple 订单详情页面
 * @param {string} html - 订单页面的 HTML 内容
 * @returns {Object} 解析后的订单数据
 */
function parseAppleOrderPage(html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text();

  // 尝试从 JSON 数据中提取完整订单信息
  let orderJson = null;
  $('script').each((i, elem) => {
    const scriptContent = $(elem).html();
    if (scriptContent && scriptContent.includes('orderItem-')) {
      try {
        // 清理 JSON 中的控制字符
        const cleaned = scriptContent.trim()
          .replace(/[\x00-\x1F\x7F]/g, '') // 移除控制字符
          .replace(/\n/g, ' ')              // 替换换行符
          .replace(/\r/g, '')               // 移除回车符
          .replace(/\t/g, ' ');             // 替换制表符

        orderJson = JSON.parse(cleaned);
      } catch (e) {
        // JSON 解析失败，继续使用 HTML 解析
      }
    }
  });

  // 1. 提取订单号
  let orderNumber = null;
  if (orderJson && orderJson.orderDetail && orderJson.orderDetail.d) {
    orderNumber = orderJson.orderDetail.d.orderNumber || orderJson.orderDetail.orderHeader?.d?.orderNumber;
  }
  if (!orderNumber) {
    const orderNumberMatch = bodyText.match(/W\d{10}/);
    orderNumber = orderNumberMatch ? orderNumberMatch[0] : null;
  }

  // 2. 提取下单日期
  let orderDate = null;
  if (orderJson && orderJson.orderDetail && orderJson.orderDetail.orderHeader?.d?.orderPlacedDate) {
    const dateStr = orderJson.orderDetail.orderHeader.d.orderPlacedDate;
    const dateMatch = dateStr.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (dateMatch) {
      orderDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
    }
  }
  if (!orderDate) {
    const orderDateMatch = bodyText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (orderDateMatch) {
      orderDate = `${orderDateMatch[1]}-${orderDateMatch[2].padStart(2, '0')}-${orderDateMatch[3].padStart(2, '0')}`;
    }
  }

  // 3. 提取订单状态
  let orderStatus = 'unknown';
  const statusKeywords = {
    '已取消': 'cancelled',
    '取货已取消': 'pickup_cancelled',
    '准备就绪': 'ready',
    '处理中': 'processing',
    '已发货': 'shipped',
    '已送达': 'delivered',
    'Ready': 'ready',
    'Processing': 'processing'
  };

  for (const [keyword, status] of Object.entries(statusKeywords)) {
    if (bodyText.includes(keyword)) {
      orderStatus = status;
      break;
    }
  }

  // 4. 提取产品信息（优先从 JSON 中提取）
  const products = [];

  if (orderJson && orderJson.orderDetail && orderJson.orderDetail.orderItems) {
    // 从 JSON 数据中提取商品列表
    const orderItems = orderJson.orderDetail.orderItems;

    // 遍历所有订单项（orderItem-0000101, orderItem-0000201 等）
    Object.keys(orderItems).forEach(key => {
      if (key.startsWith('orderItem-') && key.match(/orderItem-\d+/)) {
        const item = orderItems[key];
        const itemDetails = item.orderItemDetails?.d;

        if (itemDetails) {
          products.push({
            name: itemDetails.productName || itemDetails.itemShortName || 'Unknown Product',
            quantity: itemDetails.quantity || 0,
            deliveryType: item.d?.deliveryType || 'unknown',
            status: item.orderItemStatusTracker?.d?.currentStatus || 'unknown',
            imageUrl: itemDetails.imageData?.src || null
          });
        }
      }
    });
  }

  // 如果 JSON 解析失败，回退到 HTML 解析
  if (products.length === 0) {
    const productRegex = /(iPhone[^\n已取消]+?(?:Pro Max|Pro|Air|Plus)?[^\n已取消]*?(?:\d+TB|\d+GB)[^\n已取消]*?[一-龥]+色)\s*已取消/g;
    let match;
    while ((match = productRegex.exec(bodyText)) !== null) {
      const productName = match[1].trim();
      if (!productName.includes('{') && !productName.includes('"') && productName.length < 100) {
        products.push({
          name: productName,
          quantity: 1, // HTML 解析无法获取数量，默认为 1
          status: orderStatus
        });
      }
    }
  }

  // 5. 提取取机门店信息
  let pickupStore = null;
  const storeRegex = /店内取货地点[：:]\s*(Apple\s+[一-龥\w]+)/;
  const storeMatch = bodyText.match(storeRegex);
  if (storeMatch) {
    pickupStore = storeMatch[1].trim();
  }

  // 6. 尝试提取 JSON 数据
  let orderDataJson = null;
  $('script').each((i, elem) => {
    const scriptContent = $(elem).html();
    if (scriptContent && scriptContent.includes('OrderStatusGuestSummary')) {
      try {
        // 提取 JSON 对象
        const jsonMatch = scriptContent.match(/\{.*"OrderStatusGuestSummary".*\}/s);
        if (jsonMatch) {
          orderDataJson = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.error('解析 JSON 失败:', e.message);
      }
    }
  });

  return {
    orderNumber,
    orderDate,
    orderStatus,
    products,
    pickupStore,
    rawJson: orderDataJson
  };
}

module.exports = { parseAppleOrderPage };
