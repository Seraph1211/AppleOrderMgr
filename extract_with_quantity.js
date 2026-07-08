const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('./tmp/Apple订单页-已取消.html', 'utf-8');
const $ = cheerio.load(html);

console.log('========== 精确定位商品和数量 ==========\n');

const bodyText = $('body').text();
const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

// 查找包含 "x 数字" 的行及其上下文
lines.forEach((line, index) => {
  const quantityMatch = line.match(/x\s*(\d+)/i);
  if (quantityMatch && line.length < 100) {
    console.log(`\n找到数量标记: ${line}`);
    console.log('上下文:');
    for (let i = Math.max(0, index - 3); i <= Math.min(lines.length - 1, index + 2); i++) {
      console.log(`  ${i === index ? '>>>' : '   '} ${lines[i]}`);
    }
  }
});

console.log('\n\n========== 邮件中的产品信息格式 ==========\n');
// 从你之前提供的邮件格式来看，应该是这样的：
// MG0A4CH/A-iPhone 17 Pro Max 星宇橙色 1T x 2/李浩/603X/支付宝/-/指定信息/天津
console.log('邮件中的格式: iPhone 17 Pro Max 星宇橙色 1T x 2');
console.log('说明：x 2 表示购买 2 台');

console.log('\n========== 尝试从官网页面提取完整产品信息 ==========\n');

// 查找可能包含完整产品信息的元素
$('.rs-od-itemdetail, .rs-od-item').each((i, elem) => {
  const itemShortName = $(elem).find('.rs-od-itemshortname').text().trim();
  const itemFullName = $(elem).find('.rs-od-itemname, .rs-display-item-name').text().trim();
  const itemHTML = $(elem).html();
  
  console.log(`\n商品 ${i + 1}:`);
  console.log('  短名称:', itemShortName);
  console.log('  完整名称:', itemFullName);
  
  // 在 HTML 中查找数量
  const qtyMatch = itemHTML.match(/quantity['":\s]+(\d+)|qty['":\s]+(\d+)|x\s*(\d+)/i);
  if (qtyMatch) {
    const qty = qtyMatch[1] || qtyMatch[2] || qtyMatch[3];
    console.log('  数量:', qty);
  } else {
    console.log('  数量: 未找到（默认为 1）');
  }
});

