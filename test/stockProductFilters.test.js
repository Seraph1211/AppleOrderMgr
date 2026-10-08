const { parseStockProductFilters } = require('../src/utils/stockProductFilters');
describe('库存规格多选输入', () => {
  test('空选与去重，容量保持整数', () => {
    expect(parseStockProductFilters({})).toEqual({
      modelNames: [],
      storageGbs: [],
      colorNames: [],
    });
    expect(
      parseStockProductFilters({
        modelNames: '["机型A","机型A"]',
        storageGbs: '[256,512]',
        colorNames: '[]',
      })
    ).toEqual({ modelNames: ['机型A'], storageGbs: [256, 512], colorNames: [] });
  });
  test.each([
    'bad',
    'null',
    '{}',
    '[null]',
    '[1]',
    '[""]',
    '["  "]',
    JSON.stringify(['x'.repeat(101)]),
    JSON.stringify(Array(101).fill('A')),
  ])('拒绝非法机型 %s', value => {
    expect(() => parseStockProductFilters({ modelNames: value })).toThrow();
  });
  test.each(['["256"]', '[0]', '[-1]', '[1.5]', '[2147483648]', '[null]'])(
    '拒绝非法容量 %s',
    value => {
      expect(() => parseStockProductFilters({ storageGbs: value })).toThrow();
    }
  );
  test('拒绝数组对象与过长颜色；SQL字符仅保留为参数值', () => {
    expect(() => parseStockProductFilters({ colorNames: ['银色'] })).toThrow();
    expect(() =>
      parseStockProductFilters({ colorNames: JSON.stringify(['x'.repeat(65)]) })
    ).toThrow();
    expect(parseStockProductFilters({ modelNames: JSON.stringify(["A'_%"]) }).modelNames).toEqual([
      "A'_%",
    ]);
  });
});
