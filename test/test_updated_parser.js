const fs = require('fs');
const { parseAppleOrderPage } = require('./crawler/order_parser.js');

// 读取订单页面 HTML
const html = fs.readFileSync('./tmp/Apple订单页-已取消.html', 'utf-8');

// 解析订单页面
const orderData = parseAppleOrderPage(html);

console.log('========== 解析结果 ==========\n');
console.log('订单号:', orderData.orderNumber);
console.log('下单日期:', orderData.orderDate);
console.log('订单状态:', orderData.orderStatus);
console.log('取机门店:', orderData.pickupStore);

console.log('\n产品列表:');
orderData.products.forEach((product, index) => {
  console.log(`\n  商品 ${index + 1}:`);
  console.log(`    名称: ${product.name}`);
  console.log(`    数量: ${product.quantity}`);
  console.log(`    状态: ${product.status}`);
  if (product.deliveryType) {
    console.log(`    配送方式: ${product.deliveryType}`);
  }
});

console.log('\n========== 完整数据（JSON）==========\n');
console.log(JSON.stringify(orderData, null, 2));
