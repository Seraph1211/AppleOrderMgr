const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('./tmp/Apple订单页-已取消.html', 'utf-8');
const $ = cheerio.load(html);

console.log('========== 搜索数量信息 ==========\n');

// 方法1: 搜索包含 "x 1" "x 2" 这样的文本
const bodyText = $('body').text();
const quantityMatches = bodyText.match(/x\s*\d+/gi);
if (quantityMatches) {
  console.log('找到数量标记:');
  quantityMatches.forEach(m => console.log('  -', m));
}

console.log('\n========== 搜索包含价格的文本（可能伴随数量）==========\n');
const priceMatches = bodyText.match(/¥[\d,]+/g);
if (priceMatches) {
  console.log('找到价格:');
  priceMatches.slice(0, 10).forEach(p => console.log('  -', p));
}

console.log('\n========== 查找订单项目详细结构 ==========\n');
$('.rs-od-item').each((i, elem) => {
  console.log(`\n=== 商品 ${i + 1} ===`);
  
  // 商品名称
  const itemName = $(elem).find('.rs-od-itemshortname, .rs-od-itemname').text().trim();
  console.log('商品名称:', itemName);
  
  // 查找所有子元素的文本
  $(elem).find('*').each((j, child) => {
    const text = $(child).text().trim();
    const className = $(child).attr('class');
    if (text.length < 100 && text.length > 2 && 
        (className && (className.includes('quantity') || className.includes('qty') || 
         className.includes('price') || className.includes('amount')))) {
      console.log(`  ${className}: ${text}`);
    }
  });
  
  // 完整的文本内容（去重）
  const fullText = $(elem).text().replace(/\s+/g, ' ').trim();
  console.log('完整内容片段:', fullText.substring(0, 200));
});

console.log('\n========== 搜索 JSON 数据结构 ==========\n');
$('script').each((i, elem) => {
  const script = $(elem).html();
  if (script && script.includes('lineItem')) {
    console.log('找到 lineItem 相关数据:');
    console.log(script.substring(0, 1000));
  }
});

