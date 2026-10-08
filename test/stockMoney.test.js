const { cents, money, sumMoney, allocateMoney } = require('../src/utils/stockMoney');
describe('库存金额精确计算', () => {
  test.each(['0.00', '0.01', '1.01', '999999999999.99'])('往返金额 %s', value =>
    expect(money(cents(value))).toBe(value)
  );
  test.each([1, '1', '01.00', '0.001', 'NaN', 'Infinity', '-1.00', '1000000000000.00', null])(
    '拒绝非金额 %s',
    value => expect(() => cents(value)).toThrow()
  );
  test('负利润与全额相加', () => {
    expect(money(cents('-10.11', { signed: true }))).toBe('-10.11');
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    expect(() => cents('0.00', { positive: true })).toThrow();
  });
  test('按SN稳定分配余分', () => {
    expect(
      allocateMoney('1.00', [
        { id: '3', serialNumber: 'C' },
        { id: '1', serialNumber: 'A' },
        { id: '2', serialNumber: 'B' },
      ])
    ).toEqual([
      { saleUnitId: '1', amount: '0.34' },
      { saleUnitId: '2', amount: '0.33' },
      { saleUnitId: '3', amount: '0.33' },
    ]);
    expect(() => allocateMoney('1.00', [])).toThrow();
  });
});
