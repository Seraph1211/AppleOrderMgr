const input = require('../src/utils/proxyOrderInput');
const source = (identity, label = '身份证号') =>
  `姓名：合成\n${label}：${identity}\n手机号：13800000001\n邮箱：synthetic@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼`;
const checksum = body => {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  return (
    body +
    '10X98765432'[
      weights.reduce((sum, weight, index) => sum + Number(body[index]) * weight, 0) % 11
    ]
  );
};
const cardEnding = end => {
  for (let index = 1; index < 100; index++) {
    const card = checksum(`11010120000110${String(index).padStart(3, '0')}`);
    if (card.endsWith(end)) return card;
  }
  throw new Error('合成证件夹具构建失败');
};

describe('代抢上线反馈身份证输入独立回归', () => {
  test.each(['身份证', '身份证号', '身份证号码', '身份证后四号', '身份证后四位'])(
    '标签%s接受合法18位，仅结构字段和模板输出尾4',
    label => {
      const card = cardEnding('X');
      const result = input.parseProxyText(source(card.toLowerCase(), label));
      expect(result.canSave).toBe(true);
      expect(result.draft.idLast4).toBe(card.slice(-4));
      expect(result.draft.idLast4).toMatch(/^0/);
      const checked = input.validateProxyInput({ ...result.draft, idLast4: card });
      expect(checked.idLast4).toBe(card.slice(-4));
      const template = input.buildProxyTemplate(checked, {
        appleId: 'pool@example.com',
        password: 'synthetic',
      });
      expect(template.split(',')[28]).toBe(card.slice(-4));
      expect(template).not.toContain(card);
    }
  );
  test.each(['0123', '0000', '045X', '045x'])('既有尾号%s保留前导零，X规范大写', tail => {
    const result = input.parseProxyText(source(tail, '身份证后四位'));
    expect(result.canSave).toBe(true);
    expect(result.draft.idLast4).toBe(tail.toUpperCase());
  });
  test('18位末尾0与15位日期结构合法输入仅取尾四', () => {
    for (const card of [cardEnding('0'), '110101900110012']) {
      const result = input.parseProxyText(source(card));
      expect(result.canSave).toBe(true);
      expect(result.draft.idLast4).toBe(card.slice(-4));
      expect(input.validateProxyInput({ ...result.draft, idLast4: card }).idLast4).toBe(
        card.slice(-4)
      );
    }
  });
  test.each([
    '123',
    '12345',
    '12345678901234567',
    '000101900110012',
    '110101900230012',
    checksum('11010119990230001'),
    '110101200001100010',
    '123O',
    '00I1',
    '045Y',
    '',
  ])('非法证件边界%#不得截尾后静默保存', card => {
    const result = input.parseProxyText(source(card));
    expect(result.canSave).toBe(false);
    expect(result.draft.idLast4).toBe('');
    expect(() =>
      input.validateProxyInput({ ...input.parseProxyText(source('0123')).draft, idLast4: card })
    ).toThrow();
  });
  test('多个标签尾号冲突必须核对，一致标签可保存，原文不被破坏', () => {
    const card = cardEnding('X');
    const same = source(card) + `\n身份证后四位：${card.slice(-4)}`;
    const conflict = source(card) + '\n身份证后四位：9999';
    expect(input.parseProxyText(same).canSave).toBe(true);
    const result = input.parseProxyText(conflict);
    expect(result.canSave).toBe(false);
    expect(result.draft.idLast4).toBe('');
    expect(result.draft.rawText).toBe(conflict);
  });
  test('structured数字输入不尝试恢复精度或推断前导零', () => {
    const draft = input.parseProxyText(source('0123')).draft;
    for (const card of [123, Number('110101200001100010'), null, {}, []])
      expect(() => input.validateProxyInput({ ...draft, idLast4: card })).toThrow();
  });
});
