const {
  maskIdCard,
  maskPhone,
  maskAddress,
  escapeSpreadsheetFormula,
} = require('../src/utils/masking');

describe('API 脱敏工具', () => {
  test('应该隐藏身份证与手机号中间内容', () => {
    expect(maskIdCard('110101199001011234')).toBe('**************1234');
    expect(maskPhone('13800138000')).toBe('138****8000');
  });

  test('应该隐藏详细地址', () => {
    expect(maskAddress({ province: '重庆', city: '重庆', district: '江北区' })).toBe(
      '重庆重庆江北区（详细地址已隐藏）'
    );
  });

  test.each(['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\tformula'])('应该阻止表格公式注入：%s', value =>
    expect(escapeSpreadsheetFormula(value)).toBe(`'${value}`)
  );
});
