/**
 * 价格数据爬虫 - 长沙明威电讯报价单
 *
 * 用途：爬取苹果产品批发报价数据
 */

const https = require('https');
const http = require('http');

/**
 * 获取HTML内容（忽略SSL证书验证）
 * @param {string} url - 目标URL
 * @returns {Promise<string>} HTML内容
 */
function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      rejectUnauthorized: false, // 忽略SSL证书验证
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      }
    };

    const req = protocol.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve(data);
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

/**
 * 清理HTML标签和空白字符
 * @param {string} text - 原始文本
 * @returns {string} 清理后的文本
 */
function cleanText(text) {
  return text
    .replace(/<[^>]*>/g, '') // 移除HTML标签
    .replace(/&nbsp;/g, ' ') // 替换&nbsp;
    .replace(/\s+/g, ' ')    // 合并多个空白字符
    .trim();
}

/**
 * 解析价格数据
 * @param {string} html - HTML内容
 * @returns {Array<Object>} 价格数据数组
 */
function parsePrice(html) {
  const priceData = [];

  // 正则表达式匹配每一行数据
  // 结构: <div class="row"> ... 商品名称 ... 价格 ... 官网价 ... </div>
  const rowPattern = /<div class="row">\s*<div class="col-xs-4 view-goods-type view-goods-padding">\s*([\s\S]*?)\s*<\/div>\s*<div class="col-xs-3 red view-quote view-goods-padding">\s*(\d+)\s*<\/div>\s*<div class="col-xs-3 view-goods-padding"[^>]*>\s*(\d+)\s*<\/div>/g;

  let match;
  while ((match = rowPattern.exec(html)) !== null) {
    const productName = cleanText(match[1]);
    const price = parseInt(match[2]);
    const officialPrice = parseInt(match[3]);

    if (productName && !isNaN(price)) {
      priceData.push({
        product: productName,
        price: price,
        officialPrice: officialPrice || 0,
        discount: officialPrice > 0 ? price - officialPrice : null
      });
    }
  }

  return priceData;
}

/**
 * 主函数
 */
async function main() {
  const url = 'http://www.hnmwdx.com/m/ykbjdQuoteList.action?is_spqc=Y&is_dls=N&gsdm=60858&pp=&km=%E8%8B%B9%E6%9E%9C&network=&bj=&tykhgsdm=&datetime=1783928121128';

  console.log('开始爬取价格数据...');
  console.log('URL:', url);
  console.log('');

  try {
    // 获取HTML
    const html = await fetchHTML(url);
    console.log('✓ 成功获取HTML内容 (大小:', Math.round(html.length / 1024), 'KB)');

    // 解析价格
    const priceData = parsePrice(html);
    console.log(`✓ 成功解析 ${priceData.length} 条价格数据`);
    console.log('');

    // 输出数据
    console.log('==================== 价格数据 ====================');
    console.log('');

    priceData.forEach((item, index) => {
      console.log(`[${index + 1}] ${item.product}`);
      console.log(`    批发价: ¥${item.price}`);
      if (item.officialPrice > 0) {
        console.log(`    官网价: ¥${item.officialPrice}`);
        console.log(`    差价: ${item.discount > 0 ? '+' : ''}¥${item.discount}`);
      }
      console.log('');
    });

    console.log('==================================================');
    console.log(`总计: ${priceData.length} 个产品`);

    // 保存为JSON
    const fs = require('fs');
    const outputPath = '/tmp/price_data.json';
    fs.writeFileSync(outputPath, JSON.stringify(priceData, null, 2), 'utf8');
    console.log(`\n✓ 数据已保存到: ${outputPath}`);

    // 统计信息
    if (priceData.length > 0) {
      const avgPrice = Math.round(priceData.reduce((sum, item) => sum + item.price, 0) / priceData.length);
      const maxPrice = Math.max(...priceData.map(item => item.price));
      const minPrice = Math.min(...priceData.map(item => item.price));

      console.log('\n统计信息:');
      console.log(`  平均价格: ¥${avgPrice}`);
      console.log(`  最高价格: ¥${maxPrice}`);
      console.log(`  最低价格: ¥${minPrice}`);
    }

    return priceData;

  } catch (error) {
    console.error('❌ 爬取失败:', error.message);
    throw error;
  }
}

// 执行
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { fetchHTML, parsePrice, main };
