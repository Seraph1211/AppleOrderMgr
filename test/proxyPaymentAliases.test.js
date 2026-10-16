const {
  normalizeProxyPayment,
  parseProxyText,
  validateProxyInput,
  buildProxyTemplate,
  PAYMENT_METHODS,
} = require('../src/utils/proxyOrderInput');
const source = payment =>
  `姓名：合成\n身份证后四位：000X\n手机号：13800000000\n邮箱：synthetic@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼\n支付方式：${payment}`;
const account = { appleId: 'synthetic@example.com', password: 'Synthetic-Password' };

describe('代抢支付方式银行别名', () => {
  test.each([
    ['招商银行', '招行'],
    ['招行', '招行'],
    ['工商银行', '工行'],
    ['工行', '工行'],
    ['建设银行', '建行'],
    ['建行', '建行'],
  ])('银行全称/简称%s统一为%s，预览保存模板路径一致', (alias, canonical) => {
    for (const periods of [12, 24])
      for (const separator of ['', '分期', ' 分期 ', ' ']) {
        const payment = `${alias}${separator}${periods}期`;
        const expected = `${canonical}${periods}期`;
        expect(normalizeProxyPayment(payment)).toBe(expected);
        const preview = parseProxyText(source(payment));
        expect(preview.canSave).toBe(true);
        expect(preview.draft.paymentMethod).toBe(expected);
        expect(validateProxyInput({ ...preview.draft, paymentMethod: payment }).paymentMethod).toBe(
          expected
        );
        expect(
          buildProxyTemplate({ ...preview.draft, paymentMethod: payment }, account).split(',')[22]
        ).toBe(PAYMENT_METHODS[expected]);
      }
  });
  test.each([
    ['　招商银行　分期　２４　期　', '招行24期'],
    ['工商银行 分期 １２ 期', '工行12期'],
    ['建设银行２４期', '建行24期'],
    ['招行 分期 １２期', '招行12期'],
  ])('全角数字及合理空白%s', (payment, expected) => {
    expect(normalizeProxyPayment(payment)).toBe(expected);
    expect(parseProxyText(source(payment)).draft.paymentMethod).toBe(expected);
  });
  test.each(['花呗12期免息', '花呗 分期 １２ 期 免息', '　花呗　１２　期　免息　'])(
    '精确花呗12期免息别名%s',
    payment => {
      expect(normalizeProxyPayment(payment)).toBe('花呗12期');
      const preview = parseProxyText(source(payment));
      expect(preview.canSave).toBe(true);
      expect(preview.draft.paymentMethod).toBe('花呗12期');
      expect(validateProxyInput({ ...preview.draft, paymentMethod: payment }).paymentMethod).toBe(
        '花呗12期'
      );
      expect(
        buildProxyTemplate({ ...preview.draft, paymentMethod: payment }, account).split(',')[22]
      ).toBe('installments0001243254');
    }
  );
  test.each(Object.keys(PAYMENT_METHODS))('既有九种支付%s及导入值保持', payment => {
    const preview = parseProxyText(source(payment));
    expect(preview.canSave).toBe(true);
    expect(preview.draft.paymentMethod).toBe(payment);
    expect(buildProxyTemplate(preview.draft, account).split(',')[22]).toBe(
      PAYMENT_METHODS[payment]
    );
  });
  test.each([
    '招商银行',
    '工行',
    '建设银行分期',
    '招商银行24',
    '招商银行分期',
    '招商银行分期6期',
    '招行36期',
    '工商银行分期0期',
    '建行分期012期',
    '招商银行分期十二期',
    '中国银行24期',
    '招商24期',
    '招商银行信用卡24期',
    '招商银行24期|微信',
    '招行12期或24期',
    '招行12期/24期',
    '招商银行24期 支付宝',
    '招行12期建行24期',
    '花呗24期免息',
    '花呗6期免息',
    '花呗免息12期',
    '免息花呗12期',
    '花呗12期免息优惠',
    '招商银行12期免息',
    '花呗12期免息|微信',
    '未知文本',
    'toString',
    'constructor',
    '__proto__',
    '微 信',
    '花呗分期24期',
  ])('未知或歧义%s保留并拒绝保存和模板', payment => {
    expect(normalizeProxyPayment(payment)).toBe(payment);
    const preview = parseProxyText(source(payment));
    expect(preview.draft.paymentMethod).toBe(payment);
    expect(preview.canSave).toBe(false);
    expect(() => validateProxyInput(preview.draft)).toThrow('支付方式');
    expect(() => buildProxyTemplate(preview.draft, account)).toThrow('支付方式');
  });
  test('模板字段注入不可被规范化吞掉', () => {
    const draft = parseProxyText(source('微信')).draft;
    for (const paymentMethod of ['招商银行\n分期24期', '招行\t12期', '工行24期,微信'])
      expect(() => buildProxyTemplate({ ...draft, paymentMethod }, account)).toThrow();
  });
  test('未填支付沿用微信默认，不变更原文', () => {
    const text = source('招商银行分期24期');
    const preview = parseProxyText(text);
    expect(preview.draft.rawText).toBe(text);
    expect(parseProxyText(source('')).draft.paymentMethod).toBe('微信');
  });
});
