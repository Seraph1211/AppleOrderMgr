const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('./tmp/Apple订单页.html', 'utf-8');
const $ = cheerio.load(html);

console.log('========== 详细查找所有产品 ==========\n');

// 方法1: 查找 "已取消" 附近的所有产品
const bodyText = $('body').text();
const lines = bodyText.split('\n');

let foundProducts = [];
lines.forEach((line, index) => {
  if (line.includes('已取消') && !line.includes('取货已取消')) {
    // 查看当前行和前面几行
    for (let i = Math.max(0, index - 5); i <= index; i++) {
      const text = lines[i].trim();
      if (text.length > 10 && text.length < 100) {
        console.log(`行 ${i}: ${text}`);
      }
    }
    console.log('---');
  }
});

console.log('\n========== 查找包含数量的文本 ==========\n');

// 查找包含 "x " 或 "数量" 的文本
$('*').each((i, elem) => {
  const text = $(elem).text().trim();
  if ((text.match(/\sx\s*\d+/) || text.includes('数量')) && text.length < 150) {
    console.log(text);
  }
});

console.log('\n========== 查找所有包含 iPhone/USB 的独立段落 ==========\n');

$('div, p, span, li').each((i, elem) => {
  const text = $(elem).text().trim();
  const childrenText = $(elem).children().text().trim();
  const ownText = text.replace(childrenText, '').trim();
  
  if (ownText.length > 15 && ownText.length < 100 && 
      (ownText.includes('iPhone') || ownText.includes('USB-C')) &&
      !ownText.includes('选购') && !ownText.includes('探索')) {
    console.log(`${$(elem).prop('tagName')}: ${ownText}`);
  }
});

console.log('\n========== 查找结构化的商品列表 ==========\n');

// 查找可能的商品容器
$('[class*="item"], [class*="product"], [class*="line"]').each((i, elem) => {
  const text = $(elem).text().trim();
  if ((text.includes('iPhone') || text.includes('USB-C')) && text.length < 200) {
    console.log(`类名: ${$(elem).attr('class')}`);
    console.log(`内容: ${text}`);
    console.log('---');
  }
});

