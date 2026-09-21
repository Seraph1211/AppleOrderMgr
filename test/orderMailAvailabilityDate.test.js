const {
  parseOrderMailLifecycle,
  parsePickupDate,
} = require('../src/services/orderMailLifecycleParser');

describe('订单邮件有货日期解析', () => {
  test('取货日期字段为空时使用明确的有货日期', () => {
    const result = parseOrderMailLifecycle({
      subject: '我们正在处理你的订单 W1234567890',
      text: [
        '你的订单正在处理中。',
        '有货： 2026/09/22. 你订购的商品可以取货时，我们会与你联系。',
        'iPhone 18 Pro Max 512GB 冰川蓝色',
        '取货日期:',
        '签到时间: 18:15 - 18:30',
        '数量 1',
        '取货零售店:',
        'Apple 长沙',
      ].join('\n'),
    });

    expect(result.pickupInfo).toMatchObject({
      storeName: 'Apple 长沙',
      pickupDate: '2026-09-22',
      startTime: '18:15',
      endTime: '18:30',
    });
  });

  test('有货通知中的非法日期不会写入取货安排', () => {
    expect(parsePickupDate(['有货： 2026/02/30. 你订购的商品可以取货。'])).toBeNull();
  });
});
