/**
 * 邮件解析器测试
 * @description 测试邮件解析功能，包括单商品和多商品订单
 */

const { parseOrderEmail } = require('../src/services/emailParser');

// 测试用例 1: 单商品订单
const testEmail1 = `From: 心选邮件通知 <noreply_12@lanu.cn>
Subject: NULL预订助手提交预订成功通知
Date: Wed, 8 Oct 2025 20:21:58 +0800
Content-Type: text/html; charset=UTF-8

<div style='font-size:12px;'>
亲爱的&nbsp;&nbsp;***test@hotmail.com：<br><br>
恭喜您于2025/10/8 20:21:58在电脑iZa8bpucta640l0Z上预订iPhone手机成功，以下为成功预订信息：<br /><br />
<span style='font-weight:bold'>MG0A4CH/A-iPhone 17 Pro Max 星宇橙色 1T x 2/李浩/603X/支付宝/-/指定信息/天津</span><br /><br />
<a href="https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test@hotmail.com" target='_blank'>点击此处查看订单详情</a>或请查收联系人邮箱的邮件查看订单详情<br /><br />
请在相应的时间到相应的店铺领取您预订的产品!<br /><br />
感谢您使用 NULL AOS Helper，我们一直在努力，谢谢您的支持。
</div>`;

// 测试用例 2: 多商品订单
const testEmail2 = `From: 心选邮件通知 <noreply_13@lanu.cn>
Subject: NULL预订助手提交预订成功通知
Date: Wed, 8 Oct 2025 20:30:00 +0800
Content-Type: text/html; charset=UTF-8

<div style='font-size:12px;'>
亲爱的&nbsp;&nbsp;***tzvcantetc8k@hotmail.com：<br><br>
恭喜您于2025/10/8 20:30:00在电脑iZa8bpucta640l0Z上预订iPhone手机成功，以下为成功预订信息：<br /><br />
<span style='font-weight:bold'>MG714CH/A-iPhone 17 鼠尾草绿色 256G x 2@HNPW2ZM/A-Belkin Secure Holder 挂绳 (适用于 AirTag) - 白色(98元) x 1/冉念/5904/支付宝/-/指定信息/水果惠</span><br /><br />
<a href="https://www.apple.com.cn/xc/cn/vieworder/W1779768870/18640948351@8lvv.com" target='_blank'>点击此处查看订单详情</a>或请查收联系人邮箱的邮件查看订单详情<br /><br />
请在相应的时间到相应的店铺领取您预订的产品!
</div>`;

/**
 * 运行测试
 */
async function runTests() {
  console.log('\n========================================');
  console.log('邮件解析器测试');
  console.log('========================================\n');

  let passCount = 0;
  let failCount = 0;

  // 测试 1: 单商品订单
  try {
    console.log('📋 测试 1: 单商品订单解析');
    const result1 = await parseOrderEmail(testEmail1, 'test-uid-001');

    // 验证结果
    console.assert(result1.appleId === 'test@hotmail.com', '❌ Apple ID 不匹配');
    console.assert(result1.orderNumber === 'W1234567890', '❌ 订单号不匹配');
    console.assert(result1.products.length === 1, '❌ 商品数量不匹配');
    console.assert(result1.products[0].model === 'MG0A4CH/A', '❌ 商品型号不匹配');
    console.assert(result1.products[0].quantity === 2, '❌ 商品数量不匹配');
    console.assert(result1.recipient.name === '李浩', '❌ 收件人姓名不匹配');
    console.assert(result1.recipient.idLast4 === '603X', '❌ 身份证后四位不匹配');
    console.assert(result1.paymentMethod === '支付宝', '❌ 付款方式不匹配');
    console.assert(result1.recipient.tag === '天津', '❌ 标签不匹配');

    console.log('✅ 测试 1 通过');
    console.log('   - Apple ID:', result1.appleId);
    console.log('   - 订单号:', result1.orderNumber);
    console.log('   - 商品:', result1.products[0].name);
    console.log('   - 数量:', result1.products[0].quantity);
    console.log('   - 收件人:', result1.recipient.name);
    passCount++;
  } catch (error) {
    console.error('❌ 测试 1 失败:', error.message);
    failCount++;
  }

  console.log('');

  // 测试 2: 多商品订单
  try {
    console.log('📋 测试 2: 多商品订单解析');
    const result2 = await parseOrderEmail(testEmail2, 'test-uid-002');

    // 验证结果
    console.assert(result2.appleId === 'tzvcantetc8k@hotmail.com', '❌ Apple ID 不匹配');
    console.assert(result2.orderNumber === 'W1779768870', '❌ 订单号不匹配');
    console.assert(result2.products.length === 2, '❌ 商品数量不匹配');
    console.assert(result2.products[0].model === 'MG714CH/A', '❌ 第一个商品型号不匹配');
    console.assert(result2.products[0].quantity === 2, '❌ 第一个商品数量不匹配');
    console.assert(result2.products[1].model === 'HNPW2ZM/A', '❌ 第二个商品型号不匹配');
    console.assert(result2.products[1].quantity === 1, '❌ 第二个商品数量不匹配');
    console.assert(result2.recipient.name === '冉念', '❌ 收件人姓名不匹配');
    console.assert(result2.recipient.idLast4 === '5904', '❌ 身份证后四位不匹配');
    console.assert(result2.recipient.tag === '水果惠', '❌ 标签不匹配');

    console.log('✅ 测试 2 通过');
    console.log('   - Apple ID:', result2.appleId);
    console.log('   - 订单号:', result2.orderNumber);
    console.log('   - 商品 1:', result2.products[0].name);
    console.log('   - 商品 2:', result2.products[1].name);
    console.log('   - 收件人:', result2.recipient.name);
    passCount++;
  } catch (error) {
    console.error('❌ 测试 2 失败:', error.message);
    failCount++;
  }

  console.log('\n========================================');
  console.log(`测试结果: ${passCount} 通过, ${failCount} 失败`);
  console.log('========================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

// 执行测试
runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
