const input = require('../src/utils/proxyOrderInput');
const source = (product = 'Duo 白 256G', extras = '') =>
  `姓名：张三\n身份证后四位：0123\n手机号：13800000001\n邮箱：customer1@example.com\n机型：${product}\n取机城市：重庆\n订单来源：闲鱼\n备注：只能10.24～10.25取货\n${extras}`;
const expectedPayments = {
  微信: 'WECHAT',
  支付宝: 'ALIPAY',
  花呗12期: 'installments0001243254',
  招行12期: 'installments0001321713-2',
  招行24期: 'installments0001321713',
  建行12期: 'installments0000882476-2',
  建行24期: 'installments0000882476',
  工行12期: 'installments0000833448-2',
  工行24期: 'installments0000833448',
};
const expectedStores =
  'R448=北京王府井;R572=郑州万象城;R401=上海环贸 iapm;R683=上海环球港;R678=上海静安;R359=上海南京东路;R389=上海浦东;R705=上海七宝;R581=上海五角场;R390=上海香港广场;R574=无锡恒隆广场;R320=北京三里屯;R557=青岛万象城;R576=沈阳万象城;R534=沈阳中街大悦城;R580=成都太古里;R502=成都万象城;R577=广州天环广场;R648=济南恒隆广场;R645=北京朝阳大悦城;R479=北京华贸购物中心;R388=北京西单大悦城;R792=北京荟聚;R571=南宁万象城;R793=深圳前海壹方城;R761=深圳万象城;R484=深圳益田假日广场;R765=合肥万象城;R476=重庆北城天街;R480=重庆解放碑;R573=重庆万象城;R646=福州泰禾广场;R644=厦门新生活广场;R639=广州珠江新城;R575=武汉;R617=长沙;R643=南京虹悦城;R493=南京新街口;R703=南京玄武湖;R688=苏州;R609=大连恒隆广场;R637=天津大悦城;R579=天津恒隆广场;R638=天津万象城;R670=昆明;R532=杭州万象城;R471=杭州西湖;R531=宁波天一广场;R766=温州万象城';
const account = { appleId: 'synthetic@example.com', password: 'Synthetic-Pass' };
const parse = (product, extras) => input.parseProxyText(source(product, extras));

describe('代抢二期独立解析及模板字段验收', () => {
  test('明确城市自动固化完整门店、账单及默认值，前导零保留', () => {
    const result = parse();
    expect(result.canSave).toBe(true);
    expect(result.draft).toMatchObject({
      idLast4: '0123',
      quantity: 1,
      paymentMethod: '微信',
      orderSource: '闲鱼',
      notes: '只能10.24～10.25取货',
    });
    expect(result.draft.storeCodes.sort()).toEqual(['R476', 'R480', 'R573']);
    expect(result.draft.billing.streetAddress).toBeTruthy();
    expect(result.warnings.join(' ')).toContain('1');
  });
  test('三个候选、指定门店及末尾X完整解析', () => {
    const result = input.parseProxyText(
      source(
        '18PM 银 256G | 18PM 黑 256G | Duo 白 512G',
        '取机门店：重庆解放碑 | 重庆万象城\n支付方式：花呗12期'
      ).replace('0123', '045X')
    );
    expect(result.canSave).toBe(true);
    expect(result.draft.idLast4).toBe('045X');
    expect(result.draft.productCandidates).toHaveLength(3);
    expect(result.draft.storeCodes).toEqual(['R480', 'R573']);
  });
  test.each([
    '18PM 白 256G',
    '18PM 蓝 1T',
    'Duo 白 128G',
    '18 Pro 黑 512G',
    '18PM 银 黑 256G',
    '18PM 银 256G 512G',
    '18PM 银 256G / Duo 白 512G',
  ])('未核实组合进入核对而非静默登记 %s', product => {
    expect(parse(product).canSave).toBe(false);
  });
  test('十九商品组合的模板名称独立枚举比对', () => {
    const names = [];
    for (const color of ['银色', '勃艮第酒红色', '冰川蓝色', '黑色'])
      for (const size of ['256G', '512G']) names.push(`iPhone 18 Pro Max ${color} ${size}`);
    names.push(
      'iPhone 18 Pro Max 银色 1T',
      'iPhone 18 Pro Max 勃艮第酒红色 1T',
      'iPhone 18 Pro 银色 512G'
    );
    for (const color of ['星光白色', '夜空色'])
      for (const size of ['256G', '512G', '1T', '2T']) names.push(`iPhone Duo ${color} ${size}`);
    expect(names).toHaveLength(19);
    for (const name of names) {
      const result = parse(name);
      expect(result.canSave).toBe(true);
      expect(input.buildProxyTemplate(result.draft, account).split(',')[3]).toBe(name);
    }
  });
  test.each(Object.entries(expectedPayments))(
    '支付%s精确软件值，CSV全部字段及配置后缀冻结',
    (payment, code) => {
      const draft = parse(
        'Duo 白 256G',
        `支付方式：${payment}\n数量：2\n取机门店：重庆解放碑`
      ).draft;
      draft.billing = {
        referenceStoreCode: 'R480',
        province: '重庆',
        city: '重庆',
        district: '渝中区',
        streetAddress: '合成路1号',
      };
      const expected = [
        'synthetic@example.com',
        'Synthetic-Pass',
        '重庆解放碑',
        'iPhone Duo 星光白色 256G',
        '2',
        '指定地址',
        '13800000001',
        '张',
        '三',
        '',
        'customer1@example.com',
        '重庆',
        '重庆',
        '渝中区',
        '',
        '',
        '合成路1号',
        '',
        '',
        '',
        '',
        '',
        code,
        '0',
        '',
        '',
        '',
        '否##0#7-1-8-9-2-0#0#0#否#否#否#否#否#5000#0#0#否#0#0#0#0#否#否##否##否#',
        '0123',
        '代抢 闲鱼',
        '',
        '',
        '',
      ];
      expect(input.buildProxyTemplate(draft, account).split(',')).toEqual(expected);
    }
  );
  test('49门店以人工锚点逐项验证，不能以去Apple前缀猜名', () => {
    const pairs = expectedStores.split(';').map(item => item.split('='));
    expect(pairs).toHaveLength(49);
    for (const [code, softwareName] of pairs) {
      const store = input.STORES.find(item => item.code === code);
      expect(store).toBeTruthy();
      const draft = parse().draft;
      Object.assign(draft, {
        storeCodes: [code],
        storeCity: store.city,
        storeMode: 'selected',
        billing: input.generateProxyAddress(code),
      });
      expect(input.buildProxyTemplate(draft, account).split(',')[2]).toBe(softwareName);
    }
  });
  test('已固化city_any门店集合保存时不扩大、跨城市门店拒绝', () => {
    const draft = parse().draft;
    expect(
      input.validateProxyInput({
        ...draft,
        storeMode: 'city_any',
        storeCodes: ['R480'],
        billing: input.generateProxyAddress('R480'),
      }).storeCodes
    ).toEqual(['R480']);
    expect(() =>
      input.validateProxyInput({
        ...draft,
        storeCodes: ['R572'],
        billing: input.generateProxyAddress('R572'),
      })
    ).toThrow();
  });
  test('未知支付拒绝模板，备注不参与匹配', () => {
    const draft = parse().draft;
    expect(() =>
      input.buildProxyTemplate({ ...draft, paymentMethod: '未知支付' }, account)
    ).toThrow();
    const assignment = { accountEmail: account.appleId, startedAt: '2026-10-15T00:00:00Z' };
    const order = {
      id: 1,
      appleId: account.appleId,
      orderDate: '2026-10-15T01:00:00Z',
      recipientName: '张三',
      recipientPhone: draft.phone,
      recipientIdLast4: draft.idLast4,
      sourceContactEmail: draft.email,
      pickupStoreCode: 'R480',
      products: [{ name: 'iPhone Duo 星光白色 256GB', quantity: 1 }],
    };
    expect(
      input.isProxyMatch({ ...draft, notes: '只接受其他颜色，10月26日取' }, order, [assignment])
    ).toBe(true);
    for (const extra of [
      { recipientPhone: null },
      { recipientIdLast4: '999X' },
      { sourceContactEmail: 'other@example.com' },
      { pickupStoreCode: 'R572' },
      { products: [{ name: 'iPhone Duo 星光白色 256GB', quantity: 0 }] },
    ])
      expect(input.isProxyMatch(draft, { ...order, ...extra }, [assignment])).toBe(false);
  });
});
