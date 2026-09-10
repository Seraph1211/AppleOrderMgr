const { parseAosLine, validateAosDraft } = require('../src/services/aosParser');
const { buildAosLine } = require('./fixtures/aosRecords');

describe('AOS 严格解析', () => {
  test('保留空列、显式姓与名、完整 TAG 和北京时间毫秒', () => {
    const result = parseAosLine(buildAosLine());
    expect(result.issues).toEqual([]);
    expect(result.data.orderDate).toBe('2026-09-10T02:00:00.123Z');
    expect(result.data.products).toEqual([
      { model: 'MG054CH/A', name: 'iPhone 17 Pro Max 深蓝色 256G', quantity: 2 },
    ]);
    expect(result.data.lastName).toBe('测试');
    expect(result.data.recipientIdLast4).toBe('1234');
    expect(result.data.recipientTag).toBe('测试 TAG');
    expect(result.data).not.toHaveProperty('password');
    expect(JSON.stringify(result.data)).not.toContain('synthetic-software-account');
  });
  test('兼容 UTF-8 BOM', () => expect(parseAosLine('\uFEFF' + buildAosLine()).issues).toEqual([]));
  test('兼容历史 15 列和未来新增尾部列', () => {
    const current = buildAosLine().split('\t');
    const historical = parseAosLine(current.slice(0, 15).join('\t'));
    const extended = parseAosLine([...current, '未来字段一', '未来字段二'].join('\t'));
    const withLowercaseX = parseAosLine(buildAosLine({ 15: '123x' }));
    expect(historical.issues).toEqual([]);
    expect(historical.data.recipientIdLast4).toBeNull();
    expect(extended.issues).toEqual([]);
    expect(extended.data.recipientIdLast4).toBe('1234');
    expect(extended.data).not.toHaveProperty('extraColumns');
    expect(withLowercaseX.issues).toEqual([]);
    expect(withLowercaseX.data.recipientIdLast4).toBe('123X');
  });
  test.each([
    ['列缺失', buildAosLine().split('\t').slice(0, 14).join('\t'), 'AOS_COLUMN_COUNT_INVALID'],
    ['身份证后四位无效', buildAosLine({ 15: '12' }), 'AOS_FIELD_INVALID'],
    ['身份证后四位字符无效', buildAosLine({ 15: '12A4' }), 'AOS_FIELD_INVALID'],
    ['行终止符', buildAosLine() + '\r\n', 'AOS_COLUMN_COUNT_INVALID'],
    ['商品数量零', buildAosLine({ 10: 'MG054CH/A-商品 x 0' }), 'AOS_PRODUCT_INVALID'],
    ['未知商品语法', buildAosLine({ 10: '商品数量2' }), 'AOS_PRODUCT_INVALID'],
    ['不存在日期', buildAosLine({ 14: '2026-02-30 10:00:00.000' }), 'AOS_ORDER_DATE_INVALID'],
    ['只有日期', buildAosLine({ 14: '2026-09-10' }), 'AOS_ORDER_DATE_INVALID'],
    [
      '链接异单',
      buildAosLine({
        13: 'https://www.apple.com.cn/xc/cn/vieworder/W9900000002/contact%40example.com',
      }),
      'AOS_ORDER_IDENTITY_MISMATCH',
    ],
    [
      '链接异邮箱',
      buildAosLine({
        13: 'https://www.apple.com.cn/xc/cn/vieworder/W9900000001/other%40example.com',
      }),
      'AOS_ORDER_IDENTITY_MISMATCH',
    ],
    [
      '非 Apple 主机',
      buildAosLine({
        13: 'https://evil.example.com/xc/cn/vieworder/W9900000001/contact%40example.com',
      }),
      'AOS_ORDER_IDENTITY_MISMATCH',
    ],
    [
      '额外查询',
      buildAosLine({
        13: 'https://www.apple.com.cn/xc/cn/vieworder/W9900000001/contact%40example.com?a=1',
      }),
      'AOS_ORDER_IDENTITY_MISMATCH',
    ],
    [
      '路径归一化',
      buildAosLine({
        13: 'https://www.apple.com.cn/extra/../xc/cn/vieworder/W9900000001/contact%40example.com',
      }),
      'AOS_ORDER_IDENTITY_MISMATCH',
    ],
    ['非法支付方式', buildAosLine({ 11: '不确定' }), 'AOS_FIELD_INVALID'],
  ])('%s 返回稳定错误且不泄露原文', (_name, line, code) => {
    const result = parseAosLine(line);
    expect(result.issues.some(i => i.code === code)).toBe(true);
    expect(JSON.stringify(result.issues)).not.toContain('synthetic-password');
    expect(JSON.stringify(result.issues)).not.toContain('contact@example.com');
  });
  test('完整草稿不接受额外字段或密码混入', () => {
    const { data } = parseAosLine(buildAosLine());
    expect(validateAosDraft({ ...data, password: 'not-allowed' }).issues.length).toBe(1);
  });
});
