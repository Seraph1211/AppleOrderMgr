const {
  parseOrderMailLifecycle,
  parsePickupDate,
} = require('../src/services/orderMailLifecycleParser');
const { aggregateOrderLifecycle } = require('../src/services/orderMailLifecycleService');

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

  test('较新邮件日期为空时保留较早有效邮件的取货日期', () => {
    const orderNumber = 'W1234567890';
    const products = [{ name: 'iPhone 18 Pro Max 512GB 冰川蓝色', quantity: 1 }];
    const event = (overrides = {}) => ({
      id: overrides.id,
      messageId: `${overrides.id}-message`,
      revision: 1,
      source: 'parser',
      templateType: overrides.templateType,
      orderStatus: overrides.orderStatus,
      paymentStatus: overrides.paymentStatus || null,
      pickupInfo: overrides.pickupInfo,
      products,
      needsReview: false,
      reviewReasons: [],
      parsedAt: overrides.emailDate,
      ruleVersion: 'test',
      message: { orderNumber, emailDate: overrides.emailDate },
    });

    const aggregate = aggregateOrderLifecycle({ orderNumber, products }, [
      event({
        id: 'confirmed',
        templateType: 'confirmed',
        orderStatus: 'confirmed',
        emailDate: new Date('2026-09-20T01:00:00Z'),
        pickupInfo: {
          storeName: 'Apple 长沙',
          storeAddress: null,
          pickupDate: '2026-09-22',
          startTime: '18:15',
          endTime: '18:30',
          appointmentMode: 'scheduled',
        },
      }),
      event({
        id: 'processing',
        templateType: 'processing',
        orderStatus: 'processing',
        paymentStatus: 'paid',
        emailDate: new Date('2026-09-21T01:00:00Z'),
        pickupInfo: {
          storeName: 'Apple 长沙',
          storeAddress: '长沙市芙蓉区解放西路 188 号',
          pickupDate: null,
          startTime: '18:15',
          endTime: '18:30',
          appointmentMode: 'scheduled',
        },
      }),
    ]);

    expect(aggregate.pickupInfo).toMatchObject({
      storeName: 'Apple 长沙',
      storeAddress: '长沙市芙蓉区解放西路 188 号',
      pickupDate: '2026-09-22',
      startTime: '18:15',
      endTime: '18:30',
    });
  });
});
