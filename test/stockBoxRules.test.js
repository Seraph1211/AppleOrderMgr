const { parseBoxData } = require('../src/services/stockBoxRules');
const { extractSerialCandidates } = require('../src/services/pickupOcrRules');
const { CATALOG, PRICE_VERSION } = require('../src/services/stockFixedCatalog');
const parse = (content, barcodes) => parseBoxData({ content }, barcodes)[0];
describe('盒标结构化解析（合成文本，非阿里云实测）', () => {
  test.each(CATALOG)('$skuCode 固定映射及成本', item => {
    const row = parse(
      `${item.skuCode}\n${item.modelName}\n${item.storageGb}GB ${item.colorName}\nSerial No. AB12CD34EF`
    );
    expect(row).toMatchObject({
      serialNumber: 'AB12CD34EF',
      modelName: item.modelName,
      storageGb: item.storageGb,
      colorName: item.colorName,
      matchBasis: 'sku',
      reviewReasons: [],
    });
  });
  test('冻结 16 规格和固定价格版本', () => {
    expect(CATALOG).toHaveLength(16);
    expect(PRICE_VERSION).toBe('cn-iphone18-20260921');
    expect(
      CATALOG.filter(item => item.storageGb === 2048).every(item => item.amount === '21499.00')
    ).toBe(true);
  });
  test.each([
    ['Glacier', '冰川蓝色'],
    ['Glacier Blue', '冰川蓝色'],
    ['Black', '黑色'],
    ['Silver', '银色'],
    ['Burgundy', '勃艮第酒红色'],
  ])('拆段文字颜色 %s', (color, expected) => {
    expect(parse(`iPhone 18 Pro\nMax ${color}\n512GB\nSerial No. AB12CD34EF`)).toMatchObject({
      colorName: expected,
      storageGb: 512,
      matchBasis: 'description',
    });
  });
  test.each(['1TB', '1T', '1024GB'])('容量别名 %s', capacity =>
    expect(parse(`iPhone 18 Pro Max Black ${capacity}\nSerial No. AB12CD34EF`).storageGb).toBe(1024)
  );
  test('不把 Pro 识别成 Pro Max', () =>
    expect(parse('iPhone 18 Pro Black 512GB\nSerial No. AB12CD34EF').matchBasis).toBeNull());
  test('SKU 描述冲突和未知地区不自动确定', () => {
    expect(
      parse('MJY64CH/A iPhone 18 Pro Max 512GB Silver\nSerial No. AB12CD34EF').matchBasis
    ).toBeNull();
    expect(
      parse('MJY64LL/A iPhone 18 Pro Max 256GB Black\nSerial No. AB12CD34EF').matchBasis
    ).toBeNull();
  });
  test('编码排除、无标签需核对、文字不剥S、不猜字符', () => {
    expect(
      extractSerialCandidates(
        'CMIIT ID: 2025CP1234\nIMEI 123456789012345\nEID AB12CD34EF\nUPC CD12EF34GH'
      )
    ).toEqual([]);
    expect(extractSerialCandidates('CMIIT ID: 2025 CP12345678\nSerial No. AB12CD34EF')).toEqual([
      'AB12CD34EF',
    ]);
    expect(parse('AB12CD34EF').reviewReasons).toContain('未识别 Serial 标签，请核对 SN');
    expect(parse('Serial No. S012CD34EF').serialNumber).toBe('S012CD34EF');
    expect(parse('Serial No. AO12CD34EF').serialNumber).toBe('AO12CD34EF');
  });
  test('条码前导S交叉核对与冲突', () => {
    expect(parse('MJY64CH/A\nSerial No. AB12CD34EF', ['SAB12CD34EF']).reviewReasons).toEqual([]);
    const conflict = parse('MJY64CH/A\nSerial No. AB12CD34EF', ['SXY12CD34EF']);
    expect(conflict.serialNumber).toBe('XY12CD34EF');
    expect(conflict.sources.serial).toBe('barcode');
    expect(conflict.serialCandidates).toEqual(expect.arrayContaining(['AB12CD34EF', 'XY12CD34EF']));
    expect(conflict.reviewReasons).toContain('SN 文字与条码不一致');
  });
  test('唯一条码优先、重复条码去重，多个不同条码仍不能自动确定', () => {
    const repeated = parse('MJY64CH/A', ['SAB12CD34EF', 'AB12CD34EF']);
    expect(repeated.serialNumber).toBe('AB12CD34EF');
    expect(repeated.sources.serial).toBe('barcode');
    expect(repeated.serialCandidates).toEqual(['AB12CD34EF']);
    const multiple = parse('MJY64CH/A\nSerial No. AB12CD34EF', ['AB12CD34EF', 'XY12CD34EF']);
    expect(multiple.serialNumber).toBe('');
    expect(multiple.reviewReasons.length).toBeGreaterThan(0);
    const printed = parse('MJY64CH/A\nSerial No. AB12CD34EF', ['123456789012345']);
    expect(printed.serialNumber).toBe('AB12CD34EF');
    expect(printed.sources.serial).toBe('serial_label');
  });
  test('多盒未知位置不按数量硬配', () => {
    const rows = parseBoxData({
      content: 'MJY64CH/A MJY74CH/A\nSerial No. AB12CD34EF\nSerial No. CD12EF34GH',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].serialNumber).toBe('');
    expect(rows[0].matchBasis).toBeNull();
  });
  test('多盒仅粗略位置仍保守要求人工对应', () => {
    const line = (word, y) => ({
      word,
      pos: [
        { x: 0, y },
        { x: 200, y: y + 10 },
      ],
    });
    const rows = parseBoxData({
      content: '',
      ['prism_wordsInfo']: [
        line('MJY64CH/A iPhone 18 Pro Max 256GB Black', 0),
        line('Serial No. AB12CD34EF', 20),
        line('MJY74CH/A iPhone 18 Pro Max 256GB Silver', 200),
        line('Serial No. CD12EF34GH', 220),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].matchBasis).toBeNull();
    expect(rows[0].serialNumber).toBe('');
  });
});
