const {
  normalizeRecipientTag,
  getRecipientTag,
  getRecipientTagState,
  recipientTagSql,
} = require('../src/services/recipientTagService');

test.each([null, undefined, '', ' \t\n', '\u00a0', '\ufeff', '\u3000'])(
  '空白 TAG %j 不构成授权值',
  tag => {
    expect(normalizeRecipientTag(tag)).toBeNull();
    const order = { recipientRef: 1, recipient: { tag }, tag: 'OLD', sourceRecipientTag: 'AOS' };
    expect(getRecipientTag(order)).toBeNull();
    expect(getRecipientTagState(order)).toBe('missing');
  }
);

test.each([' A ', 'a', "O'Reilly", 'A,B'])('非空 TAG %s 原文保留且与来源独立', tag => {
  const order = { recipientRef: 1, recipient: { tag }, tag: 'OLD', sourceRecipientTag: 'AOS' };
  expect(getRecipientTag(order)).toBe(tag);
  expect(getRecipientTagState(order)).toBe('present');
});

test('未关联不回退历史，查询计算列与档案预加载支持同一序列化', () => {
  expect(getRecipientTag({ tag: 'OLD', sourceRecipientTag: 'AOS' })).toBeNull();
  expect(getRecipientTagState({ tag: 'OLD' })).toBe('unlinked');
  expect(getRecipientTag({ recipientRef: 1, recipientTag: 'B' })).toBe('B');
});

test('SQL 别名限制为代码标识符，不接受表达式或外部片段', () => {
  expect(recipientTagSql('order')).toContain('"order".recipient_ref');
  expect(recipientTagSql()).toContain('"Order".recipient_ref');
  expect(recipientTagSql('o')).not.toContain('source_recipient_tag');
  expect(() => recipientTagSql('o); DROP TABLE orders')).toThrow();
});
