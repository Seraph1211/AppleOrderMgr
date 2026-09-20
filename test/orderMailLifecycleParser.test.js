const {
  TEMPLATE_TYPES,
  evaluateProductScope,
  parseOrderMailLifecycle,
  parsePickupDate,
  parseTimeRange,
} = require('../src/services/orderMailLifecycleParser');
const { aggregateOrderLifecycle } = require('../src/services/orderMailLifecycleService');

function parsed(subject, body) {
  return {
    subject,
    text: body,
    from: { value: [{ address: 'orders@orders.apple.com' }] },
  };
}

describe('订单邮件生命周期模板解析', () => {
  test('确认邮件只确认订单，不把条件式催付判为未付款', () => {
    const result = parseOrderMailLifecycle(
      parsed(
        '你的Apple Store在线商店订单 - W1234567890',
        [
          '我们收到了你的订单。',
          '确认你的付款后，我们会开始处理你的订单。',
          'iPhone 18 Pro Max 512GB 勃艮第酒红色',
          '取货日期： 星期二 2026/09/22',
          '取货时间： 19:45 - 20:00',
          '数量 1',
          '取货零售店：',
          'Apple 西湖',
          '杭州市上城区平海路 100 号',
          '310006',
        ].join('\n')
      )
    );
    expect(result).toMatchObject({
      templateType: TEMPLATE_TYPES.CONFIRMED,
      orderStatus: 'confirmed',
      paymentStatus: null,
      needsReview: false,
      pickupInfo: {
        storeName: 'Apple 西湖',
        pickupDate: '2026-09-22',
        startTime: '19:45',
        endTime: '20:00',
      },
    });
    expect(result.products).toEqual([
      { name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', quantity: 1 },
    ]);
  });

  test('处理邮件判为处理中和已付款，但未来取货说明不判可取货', () => {
    const result = parseOrderMailLifecycle(
      parsed(
        '我们正在处理你的订单 W1234567890',
        [
          '你的订单正在处理中。',
          '当你订购的商品可以取货时，我们会发送电子邮件通知你。',
          'iPhone 18 Pro Max 512GB 勃艮第酒红色',
          '取货日期:',
          '签到时间: 16:00 - 16:15',
          '数量 1',
        ].join('\n')
      )
    );
    expect(result.orderStatus).toBe('processing');
    expect(result.paymentStatus).toBe('paid');
  });

  test('正式可取货通知提取门店、地址、中国日期和 AM/PM 时段', () => {
    const result = parseOrderMailLifecycle(
      parsed(
        '关于你的 Apple 订单 W1234567890 的更新信息',
        [
          '你的订单商品已安排在 Apple, 泰禾广场取货。',
          '取货零售店:',
          'Apple',
          '泰禾广场',
          '福州市晋安区竹屿路 6 号',
          '东二环泰禾广场',
          '350000',
          '已可取货',
          'iPhone 18 Pro Max 256GB 黑色',
          '取货日期： 星期日, 9月 20日, 2026',
          '到店时间： 08:00 PM - 08:15 PM',
          '数量 1',
        ].join('\n')
      )
    );
    expect(result).toMatchObject({
      orderStatus: 'ready_for_pickup',
      paymentStatus: 'paid',
      pickupInfo: {
        storeName: 'Apple 泰禾广场',
        storeAddress: '福州市晋安区竹屿路 6 号 东二环泰禾广场',
        pickupDate: '2026-09-20',
        startTime: '20:00',
        endTime: '20:15',
        appointmentMode: 'scheduled',
      },
    });
  });

  test('营业时间内到店不补造日期或时段', () => {
    const result = parseOrderMailLifecycle(
      parsed(
        '订单 W1234567890 的取货信息',
        [
          '你的订单商品已备好并可取货。',
          '请于店面营业时间>内前往 Apple, 长沙。',
          '取货零售店:',
          'Apple',
          '长沙',
          '长沙市芙蓉区解放西路 188 号',
          '410000',
          '已可取货',
          'iPhone 18 Pro Max 512GB 勃艮第酒红色',
          '数量 1',
        ].join('\n')
      )
    );
    expect(result.pickupInfo).toMatchObject({
      appointmentMode: 'business_hours',
      pickupDate: null,
      startTime: null,
      endTime: null,
    });
  });

  test('电子收据和个人设置辅导不产生业务结论', () => {
    for (const subject of [
      'Apple 订单的电子收据 # MD123456',
      '个人设置辅导，帮你上手新 iPhone。',
    ]) {
      const result = parseOrderMailLifecycle(parsed(subject, '付款 取货 取消 W1234567890'));
      expect(result.templateType).toBe(TEMPLATE_TYPES.EXCLUDED);
      expect(result.orderStatus).toBeNull();
      expect(result.paymentStatus).toBeNull();
    }
  });

  test('商品范围按归一化名称和总数量核对，不接受部分履约', () => {
    const mail = [
      { name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', quantity: 1 },
      { name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', quantity: 1 },
    ];
    expect(
      evaluateProductScope(mail, [{ name: 'iPhone 18 Pro Max 勃艮第酒红色 512G', quantity: 2 }])
    ).toEqual({ matched: true, reason: null });
    expect(evaluateProductScope(mail.slice(0, 1), mail)).toEqual({
      matched: false,
      reason: 'PRODUCT_SCOPE_MISMATCH',
    });
  });

  test('日期和时段拒绝非法值', () => {
    expect(parsePickupDate(['取货日期： 2026/02/30'])).toBeNull();
    expect(parseTimeRange(['到店时间： 13:00 PM - 01:15 PM'])).toBeNull();
  });

  test('多封邮件乱序归并不回退，冲突只增加待核对标记', () => {
    const products = [{ name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 }];
    const readyPickup = {
      storeName: 'Apple 测试门店',
      pickupDate: '2026-09-20',
      startTime: '20:00',
      endTime: '20:15',
    };
    const aggregate = aggregateOrderLifecycle(
      { products },
      [
        {
          id: 'ready',
          messageId: 'ready-message',
          revision: 1,
          source: 'parser',
          templateType: TEMPLATE_TYPES.READY_UPDATE,
          authenticityStatus: 'verified',
          orderStatus: 'ready_for_pickup',
          paymentStatus: 'paid',
          pickupInfo: readyPickup,
          products,
          needsReview: false,
          reviewReasons: [],
          parsedAt: new Date('2026-09-20T02:00:00Z'),
          ruleVersion: 'test',
          message: { emailDate: new Date('2026-09-20T01:00:00Z') },
        },
        {
          id: 'confirmed',
          messageId: 'confirmed-message',
          revision: 1,
          source: 'parser',
          templateType: TEMPLATE_TYPES.CONFIRMED,
          authenticityStatus: 'verified',
          orderStatus: 'confirmed',
          paymentStatus: null,
          pickupInfo: null,
          products,
          needsReview: false,
          reviewReasons: [],
          parsedAt: new Date('2026-09-21T02:00:00Z'),
          ruleVersion: 'test',
          message: { emailDate: new Date('2026-09-21T01:00:00Z') },
        },
        {
          id: 'conflict',
          messageId: 'conflict-message',
          revision: 1,
          source: 'parser',
          templateType: TEMPLATE_TYPES.READY_UPDATE,
          authenticityStatus: 'verified',
          orderStatus: 'ready_for_pickup',
          paymentStatus: 'paid',
          pickupInfo: null,
          products: [{ name: 'iPhone 18 Pro Max 512GB 黑色', quantity: 1 }],
          needsReview: true,
          reviewReasons: ['PRODUCT_SCOPE_MISMATCH'],
          parsedAt: new Date('2026-09-22T02:00:00Z'),
          ruleVersion: 'test',
          message: { emailDate: new Date('2026-09-22T01:00:00Z') },
        },
      ]
    );
    expect(aggregate).toMatchObject({
      orderStatus: 'ready_for_pickup',
      paymentStatus: 'paid',
      pickupInfo: readyPickup,
      needsReview: true,
    });
    expect(aggregate.reviewReasons).toContain('PRODUCT_SCOPE_MISMATCH');
  });
});
