const fs = require('fs');
const { parseAppleOrderPage } = require('./crawler/order_parser.js');

// 读取订单页面 HTML
const html = fs.readFileSync('./tmp/Apple订单页.html', 'utf-8');

// 解析订单页面
const orderData = parseAppleOrderPage(html);

console.log('========== 解析结果 ==========\n');
console.log('订单号:', orderData.orderNumber);
console.log('下单日期:', orderData.orderDate);
console.log('订单状态:', orderData.orderStatus);
console.log('\n产品列表:');
orderData.products.forEach((product, index) => {
  console.log(`  ${index + 1}. ${product.name}`);
  console.log(`     状态: ${product.status}`);
});
console.log('\n取机门店:', orderData.pickupStore || '未找到');

if (orderData.rawJson) {
  console.log('\n✅ 成功提取到订单 JSON 数据');
} else {
  console.log('\n⚠️  未找到订单 JSON 数据');
}

console.log('\n========== 完整数据 ==========\n');
console.log(JSON.stringify(orderData, null, 2));
