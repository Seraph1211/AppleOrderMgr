const r = require('../src/utils/stockRules');
describe('库存输入与幂等规范', () => {
  test.each([
    '2026-02-30T12:00:00+08:00',
    '2025-02-29T12:00:00Z',
    '2026-10-04T24:00:00Z',
    '2026-10-04T12:00:60Z',
    '2026-10-04T12:00:00',
    '2026-10-04T12:00:00+14:01',
    'abc',
  ])('拒绝非法真实时间 %s', value => expect(() => r.instant(value)).toThrow());
  test.each(['2024-02-29T12:00:00+08:00', '2026-10-04T12:00:00.123Z', '2026-10-04T12:00:00-05:30'])(
    '保留有效时间 %s',
    value => expect(r.instant(value).toISOString()).toBe(new Date(value).toISOString())
  );
  test('字段/格式与摘要', () => {
    expect(r.digest({ b: 2, a: [1, 3] })).toBe(r.digest({ a: [1, 3], b: 2 }));
    expect(r.text(' hi ', '名称')).toBe('hi');
    expect(r.text(undefined, 'x', 5, true)).toBeNull();
    expect(() => r.uuid('abc')).toThrow();
    expect(() => r.only({ x: 1 }, [])).toThrow();
    expect(() => r.array([], 5)).toThrow();
    expect(r.array([], 5, true)).toEqual([]);
    expect(() => r.choice('a', ['b'])).toThrow();
    expect(() => r.dateOnly('2026-02-30')).toThrow();
  });
});
