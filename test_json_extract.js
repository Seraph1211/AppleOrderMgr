const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('./tmp/Apple订单页-已取消.html', 'utf-8');
const $ = cheerio.load(html);

console.log('========== 查找订单 JSON 数据 ==========\n');

$('script').each((i, elem) => {
  const script = $(elem).html();
  if (script && script.includes('orderItem-0000101')) {
    console.log('找到包含订单数据的 script 标签');
    console.log('长度:', script.length);
    
    // 尝试提取 orderItems 部分
    const orderItemsMatch = script.match(/"orderItems":\{[^}]*"c":\[([^\]]+)\]/);
    if (orderItemsMatch) {
      console.log('\n找到 orderItems.c:', orderItemsMatch[1]);
    }
    
    // 尝试提取单个商品数据
    const item1Match = script.match(/"orderItem-0000101":\{[^}]*"orderItemDetails":\{[^}]*"d":\{([^}]*"quantity":\d+[^}]*)\}/);
    if (item1Match) {
      console.log('\n找到商品1数据片段:');
      console.log(item1Match[1].substring(0, 300));
    }
    
    // 保存完整 script 到文件
    fs.writeFileSync('./tmp/order_json.txt', script);
    console.log('\n完整 JSON 已保存到 ./tmp/order_json.txt');
  }
});
