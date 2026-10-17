const {
  parseProxyText,
  parseProduct,
  parseProxyCities,
  getProxyStoreCities,
  validateProxyInput,
  buildProxyTemplate,
  generateProxyAddress,
  STORES,
} = require('../src/utils/proxyOrderInput');

const source = (city = '广州、深圳全店', extra = '') =>
  `姓名：张三\n身份证后四位：000X\n手机号：13800000000\n邮箱：customer@example.com\n机型：Duo 白色512\n取机城市：${city}\n支付方式：微信\n订单来源：闲鱼\n${extra}`;
const codes = ['R577', 'R639', 'R484', 'R761', 'R793'];

describe('代抢多城市保存与范围回归', () => {
  test('广州、深圳全店识别五家直营店，保存与模板不遗漏', () => {
    const parsed = parseProxyText(source());
    expect(parsed.canSave).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.draft).toMatchObject({
      storeCities: ['广州', '深圳'],
      storeCity: '广州、深圳',
      storeMode: 'city_any',
      storeCodes: codes,
      productModel: 'iPhone Duo',
      color: '星光白色',
      storage: '512GB',
    });
    const saved = validateProxyInput(parsed.draft);
    expect(saved.storeCodes).toEqual(codes);
    expect(saved.storeCity).toBe('广州、深圳');
    expect(
      buildProxyTemplate(saved, { appleId: 'pool@example.com', password: 'Synthetic' })
        .split(',')[2]
        .split('|')
    ).toEqual(['广州天环广场', '广州珠江新城', '深圳益田假日广场', '深圳万象城', '深圳前海壹方城']);
  });

  test.each([
    '广州、未知全店',
    '广州或者深圳全店',
    '广州、广州全店',
    '广州全店但不含天环',
    '广州、',
  ])('未知、重复及含限制城市不猜测 %s', city => {
    expect(parseProxyText(source(city)).canSave).toBe(false);
    expect(() => parseProxyCities(city)).toThrow();
  });

  test('明确全店与指定门店冲突，不静默改成子集', () => {
    const parsed = parseProxyText(source(undefined, '取机门店：广州天环广场|深圳万象城'));
    expect(parsed.canSave).toBe(false);
    expect(parsed.errors.join()).toContain('冲突');
  });

  test('多城市指定门店可用；重复及跨范围指定门店拒绝', () => {
    const parsed = parseProxyText(source('广州、深圳', '取机门店：广州天环广场|深圳万象城'));
    expect(parsed.canSave).toBe(true);
    expect(parsed.draft.storeMode).toBe('selected');
    expect(validateProxyInput(parsed.draft).storeCodes).toEqual(['R577', 'R761']);
    for (const extra of ['取机门店：广州天环广场|广州天环广场|深圳万象城', '取机门店：重庆万象城'])
      expect(parseProxyText(source('广州、深圳', extra)).canSave).toBe(false);
  });

  test('结构化城市字段冲突、重复及无对应门店拒绝', () => {
    const parsed = parseProxyText(source()).draft;
    for (const extra of [
      { storeCities: ['广州', '广州'] },
      { storeCities: ['广州', '未知'] },
      { storeCity: '广州' },
      { storeCodes: ['R577'] },
      { storeCodes: ['R577', 'R577', 'R761'] },
    ])
      expect(() => validateProxyInput({ ...parsed, ...extra })).toThrow();
  });

  test('保存后城市全店集合保持固定，明确新建/改变选择才展开', () => {
    const saved = validateProxyInput({
      ...parseProxyText(source()).draft,
      storeCodes: ['R577', 'R761'],
    });
    expect(validateProxyInput(saved).storeCodes).toEqual(['R577', 'R761']);
    expect(validateProxyInput(saved, { expandCityStores: true }).storeCodes).toEqual(codes);
    STORES.push({ code: 'RTEST', city: '广州', name: '测试新增门店' });
    try {
      expect(validateProxyInput(saved).storeCodes).toEqual(['R577', 'R761']);
      expect(
        buildProxyTemplate(saved, { appleId: 'pool@example.com', password: 'Synthetic' }).split(
          ','
        )[2]
      ).toBe('广州天环广场|深圳万象城');
    } finally {
      STORES.pop();
    }
  });

  test('缺城市的历史订单从全已知代码推导，旧单模板仍可导出', () => {
    const old = { ...parseProxyText(source('广州')).draft, storeCity: null };
    delete old.storeCities;
    expect(getProxyStoreCities(old)).toEqual(['广州']);
    expect(validateProxyInput(old, { existing: old }).storeCity).toBe('广州');
    expect(
      buildProxyTemplate(old, { appleId: 'pool@example.com', password: 'Synthetic' }).split(',')[2]
    ).toBe('广州天环广场|广州珠江新城');
    expect(getProxyStoreCities({ storeCodes: ['R577', 'UNKNOWN'] })).toEqual([]);
    expect(() => validateProxyInput(old)).toThrow();
  });

  test('账单参考门店必须位于全部城市的门店范围内', () => {
    const parsed = parseProxyText(source()).draft;
    expect(
      validateProxyInput({ ...parsed, billing: generateProxyAddress('R793') }).billing.city
    ).toBe('深圳');
    expect(() => validateProxyInput({ ...parsed, billing: generateProxyAddress('R480') })).toThrow(
      '参考门店'
    );
  });

  test.each(['Duo 白色512', 'Duo 白 256', '18PM 银512'])('已核实裸容量有界别名 %s', text => {
    expect(parseProduct(text).storage).toMatch(/^(256|512)GB$/);
    expect(parseProxyText(source().replace('Duo 白色512', text)).canSave).toBe(true);
  });
  test.each(['Duo 白色128', 'Duo 白色1024', 'Duo 512', 'Duo 白色 512台', 'Duo 白色 5120'])(
    '未知裸容量、无颜色和数量不能冒充容量 %s',
    text => {
      expect(parseProxyText(source().replace('Duo 白色512', text)).canSave).toBe(false);
    }
  );
});
