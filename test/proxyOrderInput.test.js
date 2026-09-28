const {
  parseProxyText,
  parseProduct,
  validateProxyInput,
  buildProxyTemplate,
  parsePoolAccounts,
  generateProxyAddress,
  isProxyMatch,
  STORES,
} = require('../src/utils/proxyOrderInput');
const draft = (extra = {}) => ({
  lastName: '张',
  firstName: '三',
  phone: '13800000000',
  email: 'customer@example.com',
  idLast4: '0020',
  productModel: 'iPhone 18 Pro Max',
  color: '酒红色',
  storage: '256GB',
  quantity: 1,
  storeCodes: ['R572'],
  storeMode: 'selected',
  billing: {
    province: '河南',
    city: '郑州',
    district: '二七区',
    streetAddress: '建设路1号',
    referenceStoreCode: 'R572',
  },
  ...extra,
});
const source = (model, place = '河南省郑州市二七区万象城') =>
  `淘宝代抢新增：\n1、姓名：张 三\n2、手机号：13800000000\n3、身份证后四号：0020\n4、邮箱：customer@example.com\n5、机型：${model}\n6、取机城市苹果直营店：${place}\n7、支付方式：支付宝`;

describe('代抢文本与软件模板', () => {
  test.each(['型号/颜色/内存/数量 18 PRO MAX 酒红色 256G 1台', '18pm/酒红色/256G/1台'])(
    '解析固定样例 %s',
    model => {
      const { draft: value } = parseProxyText(source(model));
      expect(value).toMatchObject({
        lastName: '张',
        firstName: '三',
        idLast4: '0020',
        productModel: 'iPhone 18 Pro Max',
        color: '酒红色',
        storage: '256GB',
        quantity: 1,
        storeCodes: ['R572'],
      });
    }
  );
  test('未填数量提示核对；城市不推定任意店', () => {
    const value = parseProxyText(source('18pm 银色 512G', '成都'));
    expect(value.draft).toMatchObject({
      quantity: 1,
      storeCodes: [],
      storeMode: 'selected',
      storeCity: '成都',
    });
    expect(value.warnings.join(' ')).toContain('未填写数量');
  });
  test('新格式、复姓和前导零', () => {
    const value = parseProxyText(
      '姓名：欧阳明\n机型：18pm\n颜色：银色\n容量：1T\n数量：2\n身份证后四位：000X'
    );
    expect(value.draft).toMatchObject({
      lastName: '欧阳',
      firstName: '明',
      storage: '1TB',
      quantity: 2,
      idLast4: '000X',
    });
  });
  test('拒绝多位客户和过长原文', () => {
    expect(() => parseProxyText('姓名：张三\n姓名：李四')).toThrow('一位');
    expect(() => parseProxyText('x'.repeat(10001))).toThrow();
  });
  test('未填写的平台订单号占位提示不会参与重复检查', () => {
    expect(
      parseProxyText(`${source('18pm 银色 256G')}\n平台订单号：（选填）`).draft.platformOrderNumber
    ).toBe('');
  });
  test('城市任选展开门店集合；指定多家保留', () => {
    const value = validateProxyInput(
      draft({
        storeMode: 'city_any',
        storeCity: '成都',
        billing: { ...draft().billing, referenceStoreCode: 'R502' },
      })
    );
    expect(value.storeCodes).toEqual(expect.arrayContaining(['R502', 'R580']));
    expect(validateProxyInput(draft({ storeCodes: ['R572', 'R502'] })).storeCodes).toHaveLength(2);
  });
  test.each([
    { idLast4: 20 },
    { idLast4: '20' },
    { storeCodes: [] },
    { quantity: 0 },
    { phone: '123' },
    { email: 'bad' },
    { firstName: '三,四' },
    { billing: {} },
  ])('拒绝不完整或破坏模板的输入 %j', extra => {
    expect(() => validateProxyInput(draft(extra))).toThrow();
  });
  test('模板逐字匹配原公式，包括后四位和固定 TAG', () => {
    const value = buildProxyTemplate(draft(), {
      appleId: 'pool@example.com',
      password: 'synthetic-pass',
    });
    expect(value).toBe(
      'pool@example.com,synthetic-pass,,,1,指定地址,13800000000,张,三,,customer@example.com,河南,郑州,二七区,,,建设路1号,,,,,,WECHAT,0,,,,否##0#7-1-8-9-2-0#0#0#否#否#否#否#否#5000#0#0#否#0#0#0#0#否#否##否##否#,0020,代抢 网店,,,'
    );
    expect(() =>
      buildProxyTemplate(draft(), { appleId: 'a@example.com', password: 'bad,pass' })
    ).toThrow();
  });
  test.each([
    'pool@example.com synthetic-pass',
    'pool@example.com\tsynthetic-pass',
    'pool@example.com----synthetic-pass',
  ])('账号分隔格式 %s', text => {
    expect(parsePoolAccounts(text)).toEqual([
      { appleId: 'pool@example.com', password: 'synthetic-pass' },
    ]);
  });
  test('账号重复、错误行、密码分隔注入拒绝', () => {
    expect(() => parsePoolAccounts('a@example.com p\nA@example.com p')).toThrow('重复');
    expect(() => parsePoolAccounts('a@example.com p\nbad')).toThrow('第 2 行');
    expect(() => parsePoolAccounts('a@example.com p,q')).toThrow();
  });
  test('49 家门店均有完整已核对区县；地址不会使用门店街道', () => {
    expect(STORES).toHaveLength(49);
    for (const store of STORES)
      expect(generateProxyAddress(store.code)).toMatchObject({
        province: expect.any(String),
        city: store.city,
        district: expect.stringMatching(/区|县/),
        referenceStoreCode: store.code,
      });
    expect(generateProxyAddress('R572').streetAddress).toMatch(/^建设路/);
    expect(() => generateProxyAddress('bad')).toThrow();
  });
});

describe('官方订单严格匹配', () => {
  const assignment = {
    accountEmail: 'pool@example.com',
    startedAt: '2026-09-28T01:00:00Z',
    endedAt: null,
  };
  const order = {
    id: 7,
    appleId: 'pool@example.com',
    orderDate: '2026-09-28T01:01:00Z',
    recipientName: '张 三',
    recipientPhone: '13800000000',
    recipientIdLast4: '0020',
    sourceContactEmail: 'customer@example.com',
    pickupStoreCode: 'R572',
    products: [{ name: 'iPhone 18 Pro Max 256GB 勃艮第酒红色', quantity: 1 }],
  };
  test('未付款及后续取消不影响匹配；颜色别名兼容', () =>
    expect(isProxyMatch(draft(), order, [assignment])).toBe(true));
  test.each([
    { appleId: 'other@example.com' },
    { orderDate: null },
    { orderDate: '2026-09-27T23:59:59Z' },
    { recipientName: '李四' },
    { recipientPhone: null },
    { recipientIdLast4: '0021' },
    { sourceContactEmail: 'other@example.com' },
    { pickupStoreCode: 'R502' },
    { products: [{ name: 'iPhone 18 Pro 256GB 酒红色', quantity: 1 }] },
    { products: [{ name: 'iPhone 18 Pro Max 256GB 银色', quantity: 1 }] },
  ])('证据不足或冲突不匹配 %j', extra =>
    expect(isProxyMatch(draft(), { ...order, ...extra }, [assignment])).toBe(false)
  );
  test('释放后只认占用区间内订单，拒绝被人工排除的旧关联', () => {
    expect(isProxyMatch(draft(), order, [{ ...assignment, endedAt: '2026-09-28T01:00:30Z' }])).toBe(
      false
    );
    expect(isProxyMatch(draft({ rejectedOrderIds: [7] }), order, [assignment])).toBe(false);
  });
  test('数量不足不匹配、多店任选匹配', () => {
    expect(isProxyMatch(draft({ quantity: 2 }), order, [assignment])).toBe(false);
    expect(isProxyMatch(draft({ storeCodes: ['R502', 'R572'] }), order, [assignment])).toBe(true);
  });
  test.each([
    ['18pm', 'iPhone 18 Pro Max'],
    ['18 PRO MAX', 'iPhone 18 Pro Max'],
    ['iPhone 17 Pro', 'iPhone 17 Pro'],
  ])('型号别名 %s', (value, expected) => expect(parseProduct(value).productModel).toBe(expected));
});
