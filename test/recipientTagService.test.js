const {
  normalizeRecipientTag,
  getRecipientTag,
  getRecipientTagSource,
  getOrderRecipientName,
  getRecipientTagState,
  recipientTagSql,
} = require('../src/services/recipientTagService');

test.each([null, undefined, '', ' \t\n', '\u00a0', '\ufeff', '\u3000'])(
  '空白 TAG %j 不构成授权值，关联档案不能代替唯一身份查询',
  tag => {
    expect(normalizeRecipientTag(tag)).toBeNull();
    const order = { recipientRef: 1, recipient: { tag: 'UNVERIFIED' }, recipientTag: tag };
    expect(getRecipientTag(order)).toBeNull();
    expect(getRecipientTagState(order)).toBe('missing');
    expect(getRecipientTagSource(order)).toBeNull();
  }
);

test.each([' A ', 'a', "O'Reilly", 'A,B'])('AOS非空 TAG %s 原文优先且不依赖关联', tag => {
  const order = { ingestionSource: 'aos', sourceRecipientTag: tag, recipientTag: 'FALLBACK' };
  expect(getRecipientTag(order)).toBe(tag);
  expect(getRecipientTagState(order)).toBe('present');
  expect(getRecipientTagSource(order)).toBe('aos');
});

test.each(['email', 'manual', 'unknown', undefined])(
  '非AOS来源%s只采用查询验证的兜底',
  ingestionSource => {
    const order = { ingestionSource, sourceRecipientTag: 'AOS', tag: 'OLD', recipientTag: 'B' };
    expect(getRecipientTag(order)).toBe('B');
    expect(getRecipientTagSource(order)).toBe('recipient');
  }
);

test('空白AOS来源使用计算列，缺失计算列不得信任预加载旧关联', () => {
  const order = { ingestionSource: 'aos', sourceRecipientTag: '\u3000', recipient: { tag: 'OLD' } };
  expect(getRecipientTag(order)).toBeNull();
  expect(getRecipientTag({ ...order, recipientTag: 'B' })).toBe('B');
  expect(getRecipientTagSource({ ...order, recipientTag: 'B' })).toBe('recipient');
  expect(getRecipientTagState({ recipientTag: 'B' })).toBe('present');
  expect(getRecipientTagState({ tag: 'OLD' })).toBe('unlinked');
});

test('SQL共用姓名与来源尾号唯一匹配，不读取关联或加密证件', () => {
  const sql = recipientTagSql('order');
  expect(sql).toContain('"order".source_recipient_tag');
  expect(sql).toContain('COUNT(*) = 1');
  expect(sql).toContain('r.id_card_last4');
  expect(sql).not.toContain('recipient_ref');
  expect(sql).not.toContain('recipient_id_card');
  expect(() => recipientTagSql('o); DROP TABLE orders')).toThrow();
});

test('来源姓名展示不采用错误旧关联，AOS快照优先且不改变档案对象', () => {
  const order = {
    ingestionSource: 'aos',
    sourceLastName: '张',
    sourceFirstName: '三',
    recipientName: ' 李四 ',
    recipient: { id: 9, lastName: '王', firstName: '五' },
  };
  expect(getOrderRecipientName(order)).toBe('张三');
  expect(getOrderRecipientName({ ...order, ingestionSource: 'email' })).toBe('李四');
  expect(getOrderRecipientName({ recipient: order.recipient })).toBeNull();
  expect(order.recipient).toEqual({ id: 9, lastName: '王', firstName: '五' });
});
