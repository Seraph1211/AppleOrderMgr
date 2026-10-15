const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CATALOG, specification } = require('../src/services/stockFixedCatalog');
const { parseBoxData } = require('../src/services/stockBoxRules');

// 独立验收输入来自已确认官网记录，避免用实现目录生成预期。
const EXPECTED = [
  ['MK2M4CH/A', 256, '星光白色', '15999.00'],
  ['MK2N4CH/A', 256, '夜空色', '15999.00'],
  ['MK2P4CH/A', 512, '星光白色', '17999.00'],
  ['MK2Q4CH/A', 512, '夜空色', '17999.00'],
  ['MK2T4CH/A', 1024, '星光白色', '21499.00'],
  ['MK2U4CH/A', 1024, '夜空色', '21499.00'],
  ['MK2V4CH/A', 2048, '星光白色', '26499.00'],
  ['MK2W4CH/A', 2048, '夜空色', '26499.00'],
];
const parse = text => parseBoxData({ content: text })[0];

describe('iPhone Duo 独立目录与盒标验收', () => {
  test('应该完整保留16旧规格并新增8个精确国行规格', () => {
    expect(CATALOG).toHaveLength(24);
    expect(CATALOG.filter(item => item.modelName === 'iPhone 18 Pro Max')).toHaveLength(16);
    expect(new Set(CATALOG.map(item => item.skuCode)).size).toBe(24);
    expect(CATALOG.filter(item => item.modelName === 'iPhone Duo')).toHaveLength(8);
  });

  test.each(EXPECTED)(
    '应该精确匹配 %s 的容量颜色及成本',
    (skuCode, storageGb, colorName, amount) => {
      const product = { skuCode, modelName: 'iPhone Duo', storageGb, colorName };
      expect(specification(product)).toMatchObject({ ...product, amount });
      expect(specification({ ...product, skuCode: 'UNKNOWNCH/A' })).toBeNull();
      expect(specification({ ...product, modelName: 'iPhone 18 Pro Max' })).toBeNull();
      expect(specification({ ...product, storageGb: 128 })).toBeNull();
      expect(specification({ ...product, colorName: '黑色' })).toBeNull();
    }
  );

  test.each(EXPECTED)('应该按 %s 盒标料号识别规格', (skuCode, storageGb, colorName) => {
    expect(parse(`${skuCode}\nSerial No. AB12CD34EF`)).toMatchObject({
      serialNumber: 'AB12CD34EF',
      modelName: 'iPhone Duo',
      storageGb,
      colorName,
      matchBasis: 'sku',
      reviewReasons: [],
    });
  });

  test.each([
    ['星光白色', '星光白色'],
    ['Star White', '星光白色'],
    ['Starwhite', '星光白色'],
    ['夜空色', '夜空色'],
    ['Night Sky', '夜空色'],
    ['Nightsky', '夜空色'],
  ])('应该按中英文文字 %s 识别Duo', (color, colorName) => {
    expect(parse(`iPhone Duo ${color} 1TB\nSerial No. AB12CD34EF`)).toMatchObject({
      modelName: 'iPhone Duo',
      storageGb: 1024,
      colorName,
      matchBasis: 'description',
      reviewReasons: [],
    });
  });

  test.each([
    'MK2M4CH/A iPhone Duo 512GB Star White',
    'MK2M4CH/A iPhone Duo 256GB Night Sky',
    'MK2M4CH/A iPhone 18 Pro Max 256GB Star White',
    'MK2M4LL/A iPhone Duo 256GB Star White',
    'iPhone Duo 256GB 512GB Star White',
    'iPhone Duo 256GB Star White Night Sky',
    'MK2M4CH/A MK2N4CH/A',
  ])('应该拒绝冲突或不明规格 %s', text => {
    const result = parse(`${text}\nSerial No. AB12CD34EF`);
    expect(result.matchBasis).toBeNull();
    expect(result.reviewReasons.length).toBeGreaterThan(0);
  });

  test.each(['AO12CD34EF', 'A012CD34EF', 'AI12CD34EF', 'A112CD34EF'])(
    '应该原样保留SN %s而不猜字符',
    serialNumber => {
      expect(parse(`MK2M4CH/A\nSerial No. ${serialNumber}`).serialNumber).toBe(serialNumber);
    }
  );

  test.each([
    [
      'src/utils/orderCatalogPricingV1.js',
      '37b91eaef7569a8d7cfb25e213c19f62e2b67ddb1971c8ab24785cdd7f78b0e2',
    ],
    [
      'src/data/stockCatalogV20260921.json',
      '8869d444fb48fb275e1dba642e213260bbd429532b41586cad53b82760045d1b',
    ],
  ])('应该冻结历史版本文件 %s', (file, expectedHash) => {
    const content = fs.readFileSync(path.join(__dirname, '..', file));
    expect(crypto.createHash('sha256').update(content).digest('hex')).toBe(expectedHash);
  });
});
