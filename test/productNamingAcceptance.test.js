const {
  getProductDisplayName,
  resolveProductName,
  formatProductCapacity,
} = require('../src/utils/productNaming');
const { serializePublicProducts } = require('../src/utils/orderSerialization');
const { buildProductFilterItems, collectProductOptions } = require('../src/utils/productFilter');
const { productName } = require('../src/services/quotePricingCore');
const { execFileSync } = require('node:child_process');
const { buildOrderProductCondition } = require('../src/utils/productFilterQuery');
const { Sequelize } = require('sequelize');
const { buildNotificationText } = require('../src/services/wecomNotificationContent');

// 独立抄录已确认SKU表，不以被测目录反推预期。
const approved = [
  ['MJY64CH/A', 'iPhone 18 Pro Max', '黑色', '256G'],
  ['MJY74CH/A', 'iPhone 18 Pro Max', '银色', '256G'],
  ['MJY84CH/A', 'iPhone 18 Pro Max', '勃艮第酒红色', '256G'],
  ['MJY94CH/A', 'iPhone 18 Pro Max', '冰川蓝色', '256G'],
  ['MJYA4CH/A', 'iPhone 18 Pro Max', '黑色', '512G'],
  ['MJYC4CH/A', 'iPhone 18 Pro Max', '银色', '512G'],
  ['MJYD4CH/A', 'iPhone 18 Pro Max', '勃艮第酒红色', '512G'],
  ['MJYE4CH/A', 'iPhone 18 Pro Max', '冰川蓝色', '512G'],
  ['MJYF4CH/A', 'iPhone 18 Pro Max', '黑色', '1T'],
  ['MJYG4CH/A', 'iPhone 18 Pro Max', '银色', '1T'],
  ['MJYH4CH/A', 'iPhone 18 Pro Max', '勃艮第酒红色', '1T'],
  ['MJYJ4CH/A', 'iPhone 18 Pro Max', '冰川蓝色', '1T'],
  ['MJYK4CH/A', 'iPhone 18 Pro Max', '黑色', '2T'],
  ['MJYL4CH/A', 'iPhone 18 Pro Max', '银色', '2T'],
  ['MJYM4CH/A', 'iPhone 18 Pro Max', '勃艮第酒红色', '2T'],
  ['MJYN4CH/A', 'iPhone 18 Pro Max', '冰川蓝色', '2T'],
  ['MK2M4CH/A', 'iPhone Duo', '星光白色', '256G'],
  ['MK2N4CH/A', 'iPhone Duo', '夜空色', '256G'],
  ['MK2P4CH/A', 'iPhone Duo', '星光白色', '512G'],
  ['MK2Q4CH/A', 'iPhone Duo', '夜空色', '512G'],
  ['MK2T4CH/A', 'iPhone Duo', '星光白色', '1T'],
  ['MK2U4CH/A', 'iPhone Duo', '夜空色', '1T'],
  ['MK2V4CH/A', 'iPhone Duo', '星光白色', '2T'],
  ['MK2W4CH/A', 'iPhone Duo', '夜空色', '2T'],
];

test.each(approved)(
  'AC-01 目录 %s 的来源词序、单位、缺名及无SKU映射',
  (sku, model, color, capacity) => {
    const expected = `${model} ${color} ${capacity}`;
    const sources = [
      `${model} ${capacity}B ${color}`,
      `${model} ${color} ${capacity}`,
      `${model} ${capacity} ${color}`,
    ];
    for (const name of sources) {
      expect(getProductDisplayName({ model: sku, name })).toBe(expected);
      expect(getProductDisplayName(name)).toBe(expected);
    }
    expect(getProductDisplayName({ model: sku })).toBe(expected);
  }
);

test.each([
  ['256GB', '256G'],
  ['512gb', '512G'],
  ['1TB', '1T'],
  ['2t', '2T'],
  ['1024G', '1T'],
  ['1024GB', '1T'],
  ['2048GB', '2T'],
  [1024, '1T'],
  [2048, '2T'],
])('AC-01 容量 %s => %s', (input, output) => {
  expect(formatProductCapacity(input)).toBe(output);
});

test('AC-01 全角、空白和ProMax兼容；AC-04别名不回写输入', () => {
  expect(getProductDisplayName('  ｉＰｈｏｎｅ\u00a018 ProMax　２５６ＧＢ 黑色 ')).toBe(
    'iPhone 18 Pro Max 黑色 256G'
  );
  const proxy = Object.freeze({ model: 'iPhone 18 Pro Max', color: '酒红色', capacity: '256GB' });
  expect(getProductDisplayName(proxy)).toBe('iPhone 18 Pro Max 勃艮第酒红色 256G');
  expect(proxy).toEqual({ model: 'iPhone 18 Pro Max', color: '酒红色', capacity: '256GB' });
});

test.each([
  { model: 'MJY64CH/A', name: 'iPhone 18 Pro Max 银色 256G' },
  { model: 'MJY64CH/A', name: 'iPhone 18 Pro Max 黑色 512G' },
  { model: 'MJY64CH/A', name: 'iPhone Duo 星光白色 256G' },
  { model: 'MJY64CH/A', sku: 'MJY74CH/A', name: 'iPhone 18 Pro Max 黑色 256G' },
  { name: 'iPhone Duo 酒红色 256G' },
  { name: 'iPhone 18 Pro Max 256GB 黑色 手机壳' },
  { name: 'iPhone 18 Pro Max 黑色 256G + 耳机套装' },
  { name: 'iPhone 18 Pro Max 黑色 256G 512G' },
  { name: 'iPhone Duo 星光白色' },
  { name: 'iPhone Duo 星光白色 128GB' },
  { name: 'iPhone 18 Pro Max 黑色 128GB' },
  { name: '尚未识别的商品' },
])('AC-02 冲突或不完整输入保持原文并核对 %j', input => {
  const before = JSON.stringify(input);
  expect(resolveProductName(input)).toMatchObject({
    name: input.name,
    needsReview: true,
    matched: false,
  });
  expect(JSON.stringify(input)).toBe(before);
});

test('AC-03 业务序列化使用规范名并保留来源名称', () => {
  const raw = Object.freeze({
    name: 'iPhone 18 Pro Max 256GB 黑色',
    model: 'MJY64CH/A',
    quantity: 2,
  });
  const output = serializePublicProducts([raw])[0];
  expect(output.displayName).toBe('iPhone 18 Pro Max 黑色 256G');
  expect(output.name).toBe(raw.name);
  expect(output.quantity).toBe(2);
});

test('AC-03 报价输出顺序与容量一致且不改价格身份', () => {
  expect(productName({ productModel: '18 Pro Max', color: '银色', storageGb: 2048 })).toBe(
    'iPhone 18 Pro Max 银色 2T'
  );
});

test('AC-05 1024G历史键、别名继承；候选同订单去重', () => {
  const old = { model: 'MJYF4CH/A', name: 'iPhone 18 Pro Max 1024GB 黑色', quantity: 1 };
  const current = { ...old, name: 'iPhone 18 Pro Max 黑色 1T' };
  const before = buildProductFilterItems([old]);
  const after = buildProductFilterItems([current], before, [old]);
  expect(after[0].keys).toEqual(expect.arrayContaining(before[0].keys));
  expect(after[0].aliases).toContain(old.name);
  const options = collectProductOptions([
    { products: [old, old], productFilterItems: buildProductFilterItems([old, old]) },
    { products: [current], productFilterItems: after },
  ]);
  expect(options).toHaveLength(1);
  expect(options[0].count).toBe(2);
});

test.each([
  [
    {
      title: 'iPhone 18 Pro Max 256GB 黑色',
      model: 'iPhone 18 Pro Max',
      capacity: '256GB',
      sku: 'MJY64CH/A',
    },
    'iPhone 18 Pro Max 黑色 256G',
  ],
  [
    {
      productName: 'iPhone 18 Pro Max 256GB 黑色',
      productModel: '18 Pro Max',
      storageGb: 256,
      color: '黑色',
    },
    'iPhone 18 Pro Max 黑色 256G',
  ],
  [{ modelName: 'iPhone Duo', storageGb: 2048, colorName: '夜空色' }, 'iPhone Duo 夜空色 2T'],
  [
    { name: 'iPhone 18 Pro Max 512GB 冰川蓝色', model: 'MJYE4CH/A' },
    'iPhone 18 Pro Max 冰川蓝色 512G',
  ],
])('AC-03 实际模块字段shape %j', (input, output) => {
  expect(getProductDisplayName(input)).toBe(output);
});

test('AC-02 多字段名称规格冲突不可因只读取其中一字段而被覆盖', () => {
  expect(
    resolveProductName({
      name: 'iPhone 18 Pro Max 黑色 256G',
      productName: 'iPhone 18 Pro Max 银色 256G',
      model: 'MJY64CH/A',
    }).needsReview
  ).toBe(true);
});

test.each([
  { model: 'MJY64CH/A', sku: 'MJY74CH/A', name: 'iPhone 18 Pro Max 256GB 银色' },
  { model: 'MJY64CH/A', productModel: 'iPhone Duo', name: 'iPhone 18 Pro Max 256GB 黑色' },
])('AC-02 名称与优先字段一致时仍核对次要身份字段 %j', input => {
  expect(resolveProductName(input)).toMatchObject({
    name: input.name,
    matched: false,
    needsReview: true,
  });
});

test('AC-05 历史key和旧productNames组合查询兼容已改名业务项', () => {
  const old = { model: 'MJY64CH/A', name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 1 };
  const key = buildProductFilterItems([old])[0].key;
  const sequelize = new Sequelize('postgres://synthetic:synthetic@localhost/synthetic', {
    logging: false,
  });
  const condition = buildOrderProductCondition({ productKeys: JSON.stringify([key]) }, sequelize, [
    old.name,
  ]);
  expect(condition.val).toContain("'iPhone 18 Pro Max 黑色 256G'");
});

test('AC-04/05 浏览器实际ESM汇总身份、数量及付款复制保持一致', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { groupDisplayProducts as group } from './frontend/src/utils/productDisplay.js';
    import { buildPaymentCopyText } from './frontend/src/utils/paymentCopy.js';
    const old={name:'iPhone 18 Pro Max 256GB 黑色',model:'MJY64CH/A',quantity:1};
    const current={...old,name:'iPhone 18 Pro Max 黑色 256G',quantity:2};
    process.stdout.write(JSON.stringify({
      merged:group([old,current]),
      differentSku:group([old,{...current,model:'MJY74CH/A'}]),
      differentId:group([{...old,productId:1},{...current,productId:2}]),
      copy:buildPaymentCopyText({orderId:1,products:[old,current]},'synthetic')
    }));
  `,
    ],
    { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' }
  );
  const result = JSON.parse(output);
  expect(result.merged).toEqual([{ name: 'iPhone 18 Pro Max 黑色 256G', quantity: 3 }]);
  expect(result.differentSku).toHaveLength(2);
  expect(result.differentSku[1].filterNeedsReview).toBe(true);
  expect(result.differentId).toHaveLength(2);
  expect(result.copy).toContain('iPhone 18 Pro Max 黑色 256G x 3');
  expect(result.copy).not.toContain('256GB');
});

test('AC-03 后续订单通知使用同一名称且合计数量、不改来源明细', () => {
  const products = [
    { name: 'iPhone 18 Pro Max 256GB 黑色', model: 'MJY64CH/A', quantity: 1 },
    { name: 'iPhone 18 Pro Max 黑色 256G', model: 'MJY64CH/A', quantity: 2 },
  ];
  const original = JSON.stringify(products);
  const text = buildNotificationText({ id: 1, products }, 'synthetic');
  expect(text).toContain('iPhone 18 Pro Max 黑色 256G x 3');
  expect(text).not.toContain('256GB');
  expect(JSON.stringify(products)).toBe(original);
});
