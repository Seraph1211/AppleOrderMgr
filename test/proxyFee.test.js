const { normalizeProxyFee } = require('../src/utils/proxyFee');
const {
  parseProxyText,
  validateProxyInput,
  buildProxyTemplate,
} = require('../src/utils/proxyOrderInput');

describe('每笔委托费用总额', () => {
  test.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['  ', null],
    [0, '0.00'],
    ['0.00', '0.00'],
    [12.3, '12.30'],
    [' 120.01 ', '120.01'],
    ['001.20', '1.20'],
    ['9999999999.99', '9999999999.99'],
  ])('规范金额%p且不丢失分位', (value, expected) => {
    expect(normalizeProxyFee(value)).toBe(expected);
  });
  test.each([
    -1,
    '-0.01',
    '1.234',
    '1e2',
    '¥120',
    '1,200',
    '10000000000',
    NaN,
    Infinity,
    true,
    false,
    [],
    {},
    'abc',
    '1.',
    '.5',
  ])('非法输入%p不被舍入或转换为零', value => {
    expect(() => normalizeProxyFee(value)).toThrow('代抢费用');
  });
  test('数量、模板和原文解析不推导费用', () => {
    const draft = parseProxyText(
      '姓名：合成\n身份证后四位：0123\n手机号：13800000001\n邮箱：synthetic@example.test\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼'
    ).draft;
    const saved = validateProxyInput({ ...draft, quantity: 3, proxyFee: '120.50' });
    expect(saved.proxyFee).toBe('120.50');
    expect(validateProxyInput(draft).proxyFee).toBeNull();
    const account = { appleId: 'pool@example.test', password: 'synthetic' };
    expect(buildProxyTemplate(saved, account)).toBe(
      buildProxyTemplate({ ...saved, proxyFee: null }, account)
    );
  });
});
