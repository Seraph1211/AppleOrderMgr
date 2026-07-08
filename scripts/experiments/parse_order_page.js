const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('/Users/seraph/GitHouse/AppleOrderMgr/tmp/Apple订单页.html', 'utf-8');
const $ = cheerio.load(html);

console.log('========== 页面标题 ==========');
console.log($('title').text());

console.log('\n========== 可见文本内容（前 3000 字符）==========');
const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
console.log(bodyText.substring(0, 3000));

console.log('\n========== 查找订单相关元素 ==========');

// 查找包含 "订单" 的元素
$('*').each((i, elem) => {
  const text = $(elem).text().trim();
  if (text.includes('订单号') || text.includes('Order') || text.includes('W1') && text.length < 50) {
    console.log(`${$(elem).prop('tagName')}: ${text.substring(0, 100)}`);
  }
});

// 查找所有 data 属性
console.log('\n========== data-* 属性 ==========');
$('[data-order], [data-product], [data-store]').each((i, elem) => {
  console.log($(elem).prop('tagName'), $(elem).attr('data-order') || $(elem).attr('data-product') || $(elem).attr('data-store'));
});

