const axios = require('axios');
const cheerio = require('cheerio');

async function fetchAppleOrder(orderUrl) {
  try {
    console.log('正在访问订单页面:', orderUrl);
    
    const response = await axios.get(orderUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0'
      },
      timeout: 30000
    });
    
    console.log('HTTP 状态码:', response.status);
    console.log('响应头 Content-Type:', response.headers['content-type']);
    
    const html = response.data;
    const $ = cheerio.load(html);
    
    console.log('\n========== 页面标题 ==========');
    console.log($('title').text());
    
    console.log('\n========== 页面文本内容（前 2000 字符）==========');
    const bodyText = $('body').text().trim();
    console.log(bodyText.substring(0, 2000));
    
    console.log('\n========== HTML 结构分析 ==========');
    console.log('包含的主要元素:');
    console.log('- div 数量:', $('div').length);
    console.log('- span 数量:', $('span').length);
    console.log('- table 数量:', $('table').length);
    console.log('- 包含 "订单" 的元素:', $('*:contains("订单")').length);
    
    // 保存完整 HTML 到文件
    const fs = require('fs');
    fs.writeFileSync('order_page.html', html);
    console.log('\n✅ 完整 HTML 已保存到 order_page.html');
    
    return { success: true, html, text: bodyText };
    
  } catch (error) {
    console.error('❌ 访问失败:', error.message);
    if (error.response) {
      console.error('响应状态码:', error.response.status);
      console.error('响应数据:', error.response.data.substring(0, 500));
    }
    return { success: false, error: error.message };
  }
}

// 测试访问
const testUrl = 'https://www.apple.com.cn/xc/cn/vieworder/W1316796973/15123298843@8lvv.com';
fetchAppleOrder(testUrl);
