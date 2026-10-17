const input = require('../src/utils/proxyOrderInput');

const expectedCodes = ['R577', 'R639', 'R793', 'R761', 'R484'];
const expectedNames = [
  '广州天环广场',
  '广州珠江新城',
  '深圳前海壹方城',
  '深圳万象城',
  '深圳益田假日广场',
];
const source = (city = '广州、深圳全店', extra = '') =>
  `姓名：合成测试\n身份证后四位：000X\n手机号：13800000001\n邮箱：synthetic-multicity@example.com\n机型：Duo 白色512GB\n支付方式：微信\n取机城市：${city}\n订单来源：闲鱼\n${extra}`;
const sorted = values => [...values].sort();

/** 独立于开发用例核对已核实门店并集，不以实现动态输出作为唯一预期。 */
function checkAllStores(draft) {
  expect(sorted(draft.storeCodes)).toEqual(sorted(expectedCodes));
  expect(new Set(draft.storeCodes).size).toBe(expectedCodes.length);
  expect(draft.storeCodes).toHaveLength(expectedCodes.length);
  expect(draft.storeCodes).toContain(draft.billing.referenceStoreCode);
}

describe('代抢多城市独立输入验收', () => {
  test('AC-01 核心原文得到广州2店和深圳3店，商品和支付不被破坏', () => {
    const original = source().replace('512GB', '512');
    const parsed = input.parseProxyText(original);
    expect(parsed.errors).toEqual([]);
    expect(parsed.canSave).toBe(true);
    expect(parsed.draft).toMatchObject({
      productModel: 'iPhone Duo',
      color: '星光白色',
      storage: '512GB',
      paymentMethod: '微信',
      idLast4: '000X',
      rawText: original,
    });
    expect(parsed.draft.storeCities).toEqual(['广州', '深圳']);
    expect(parsed.draft.storeCity).toBe('广州、深圳');
    checkAllStores(parsed.draft);
    checkAllStores(input.validateProxyInput(parsed.draft));
  });

  test.each([
    '深圳、广州全店',
    '广州,深圳全店',
    '广州，深圳全店',
    '广州 深圳 全店',
    '广州、深圳全部门店',
    '广州全店、深圳全店',
    '广州、深圳',
  ])('AC-02 分隔与顺序变体 %s 保留完整集合且去重', city => {
    const parsed = input.parseProxyText(source(city));
    expect(parsed.errors).toEqual([]);
    expect(parsed.canSave).toBe(true);
    checkAllStores(input.validateProxyInput(parsed.draft));
  });

  test.each(['Duo 白色128', 'Duo 白色999', 'Duo 白色512 2台 3台'])(
    'AC-02 不猜未知裸容量或冲突数量 %s',
    product => {
      const parsed = input.parseProxyText(source().replace('Duo 白色512GB', product));
      expect(parsed.canSave).toBe(false);
      expect(parsed.errors.length).toBeGreaterThan(0);
    }
  );

  test('AC-03 生成模板恰好包含五店，使用软件标准名和微信编码', () => {
    const parsed = input.parseProxyText(source());
    expect(parsed.canSave).toBe(true);
    const template = input.buildProxyTemplate(parsed.draft, {
      appleId: 'synthetic-pool@example.com',
      password: 'Synthetic-Only',
    });
    const columns = template.split(',');
    expect(sorted(columns[2].split('|'))).toEqual(sorted(expectedNames));
    expect(columns[2].split('|')).toHaveLength(5);
    expect(columns[3]).toBe('iPhone Duo 星光白色 512G');
    expect(columns[22]).toBe('WECHAT');
    expect(columns[28]).toBe('000X');
  });

  test.each(['广州', '深圳'])('AC-04 单城市%s历史输入与保存保持兼容', city => {
    const parsed = input.parseProxyText(source(city));
    expect(parsed.canSave).toBe(true);
    expect(sorted(parsed.draft.storeCodes)).toEqual(
      sorted(input.STORES.filter(store => store.city === city).map(store => store.code))
    );
    const historical = { ...parsed.draft, storeCity: city };
    delete historical.storeCities;
    expect(input.validateProxyInput(historical).storeCodes).toEqual(historical.storeCodes);
  });

  test('AC-04 指定单城市多店和旧模板保持兼容', () => {
    const parsed = input.parseProxyText(source('深圳', '取机门店：深圳万象城|深圳益田假日广场'));
    expect(parsed.canSave).toBe(true);
    expect(sorted(parsed.draft.storeCodes)).toEqual(['R484', 'R761']);
    expect(input.validateProxyInput(parsed.draft).storeCodes).toEqual(parsed.draft.storeCodes);
    const template = input.buildProxyTemplate(parsed.draft, {
      appleId: 'synthetic-pool@example.com',
      password: 'Synthetic-Only',
    });
    expect(sorted(template.split(',')[2].split('|'))).toEqual(['深圳万象城', '深圳益田假日广场']);
  });

  test.each([
    ['广州、未知城全店', ''],
    ['未知城', ''],
    ['广州、深圳、广州全店', ''],
    ['', ''],
    ['广州、深圳全店', '取机门店：深圳万象城'],
    ['广州、深圳天环广场', ''],
    ['广州、深圳随便', ''],
  ])('AC-05 未知/空城市/混合指定门店不静默缩小 %s %s', (city, extra) => {
    const parsed = input.parseProxyText(source(city, extra));
    expect(parsed.canSave).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  test('AC-05 指定门店空集及未知代码保存校验拒绝', () => {
    const parsed = input.parseProxyText(source('广州'));
    expect(parsed.canSave).toBe(true);
    for (const storeCodes of [[], ['R000'], ['R577', 'R000']])
      expect(() =>
        input.validateProxyInput({ ...parsed.draft, storeMode: 'selected', storeCodes })
      ).toThrow();
  });

  test('AC-04 派生城市优先持久门店代码，不被陈旧城市说明误导', () => {
    expect(input.getProxyStoreCities({ storeCity: '广州', storeCodes: ['R484', 'R761'] })).toEqual([
      '深圳',
    ]);
    expect(input.getProxyStoreCities({ storeCity: '广州', storeCodes: ['R577', 'R484'] })).toEqual([
      '广州',
      '深圳',
    ]);
    expect(input.getProxyStoreCities({ storeCity: '广州', storeCodes: ['R000'] })).toEqual([
      '广州',
    ]);
  });

  test('AC-06 并集内每一家可自动匹配，范围外门店、身份和商品偏差不匹配', () => {
    const parsed = input.parseProxyText(source());
    expect(parsed.canSave).toBe(true);
    const draft = input.validateProxyInput(parsed.draft);
    const assignments = [
      {
        accountEmail: 'synthetic-pool@example.com',
        startedAt: new Date('2026-10-17T00:00:00Z'),
        endedAt: null,
      },
    ];
    const order = {
      id: 1,
      appleId: 'synthetic-pool@example.com',
      orderDate: '2026-10-17T00:01:00Z',
      recipientName: draft.lastName + draft.firstName,
      recipientPhone: draft.phone,
      recipientIdLast4: draft.idLast4,
      sourceContactEmail: draft.email,
      products: [{ name: 'iPhone Duo 星光白色 512GB', quantity: 1 }],
    };
    for (const pickupStoreCode of expectedCodes)
      expect(input.isProxyMatch(draft, { ...order, pickupStoreCode }, assignments)).toBe(true);
    for (const extra of [
      { pickupStoreCode: 'R480' },
      { pickupStoreCode: 'R000' },
      { pickupStoreCode: 'R577', recipientPhone: '13800000002' },
      { pickupStoreCode: 'R577', products: [{ name: 'iPhone Duo 夜空色 512GB', quantity: 1 }] },
    ])
      expect(input.isProxyMatch(draft, { ...order, ...extra }, assignments)).toBe(false);
  });
});
