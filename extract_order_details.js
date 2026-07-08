const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('/Users/seraph/GitHouse/AppleOrderMgr/tmp/Apple订单页.html', 'utf-8');
const $ = cheerio.load(html);

console.log('========== 订单基本信息 ==========');

// 提取订单号
const orderNumber = $('body').text().match(/W\d{10}/)?.[0] || 'Not found';
console.log('订单号:', orderNumber);

// 提取下单日期
const orderDateMatch = $('body').text().match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
if (orderDateMatch) {
  console.log('下单日期:', `${orderDateMatch[1]}-${orderDateMatch[2].padStart(2, '0')}-${orderDateMatch[3].padStart(2, '0')}`);
}

console.log('\n========== 搜索产品信息 ==========');

// 查找包含 iPhone 的文本
$('*').each((i, elem) => {
  const text = $(elem).text().trim();
  if (text.includes('iPhone') && text.length < 200 && text.length > 10) {
    console.log('产品相关:', text.substring(0, 150));
  }
});

console.log('\n========== 搜索取机门店信息 ==========');

// 查找包含门店、地址的文本
$('*').each((i, elem) => {
  const text = $(elem).text().trim();
  if ((text.includes('Apple') && text.includes('Store')) || 
      text.includes('取货地点') || 
      text.includes('门店') ||
      text.includes('取机')) {
    if (text.length < 200 && text.length > 5) {
      console.log('门店相关:', text.substring(0, 150));
    }
  }
});

console.log('\n========== 搜索订单状态 ==========');

// 查找状态相关文本
const keywords = ['准备就绪', '处理中', '已发货', '已送达', '已取消', 'Ready', 'Processing'];
$('*').each((i, elem) => {
  const text = $(elem).text().trim();
  for (const keyword of keywords) {
    if (text.includes(keyword) && text.length < 100) {
      console.log('状态相关:', text);
      break;
    }
  }
});

// 查找 JSON 数据
console.log('\n========== 查找 JSON 数据 ==========');
$('script').each((i, elem) => {
  const scriptContent = $(elem).html();
  if (scriptContent && scriptContent.includes('OrderStatusGuestSummary')) {
    console.log('找到订单数据 JSON:');
    console.log(scriptContent.substring(0, 1000));
  }
});

