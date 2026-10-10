const {
  explicitSerials,
  returnDecision,
  returnFingerprint,
} = require('../src/services/stockLifecycleRules');
const sn = 'A123456789';
const observation = {
  hasReturn: true,
  matched: true,
  ambiguous: false,
  fingerprint: 'a'.repeat(64),
};
test.each(['registered', 'in_stock'])('明确匹配的 %s 设备转退货并保留原仓', state => {
  expect(
    returnDecision({ state, locationId: state === 'in_stock' ? 'warehouse' : null }, observation)
  ).toMatchObject({ state: 'returned', returnPreviousState: state, locationId: null });
});
test('已售永不自动撤销销售或货款', () => {
  expect(returnDecision({ state: 'sold' }, observation)).toEqual({
    lifecycleIssue: 'sold_return_conflict',
  });
});
test('未确认具体设备时原状态保持', () => {
  expect(
    returnDecision({ state: 'in_stock' }, { ...observation, matched: false, ambiguous: true })
  ).toEqual({ lifecycleIssue: 'return_pending' });
});
test('退货撤销只提示，不自动恢复库存', () => {
  expect(returnDecision({ state: 'returned' }, { ...observation, hasReturn: false })).toEqual({
    lifecycleIssue: 'return_withdrawn',
  });
});
test('明确未退货的同单另一台不受影响', () => {
  expect(returnDecision({ state: 'in_stock' }, { ...observation, matched: false })).toEqual({
    lifecycleIssue: null,
  });
});
test('人工核实已售只对相同观测有效', () => {
  expect(
    returnDecision(
      { state: 'sold', returnDecisionFingerprint: observation.fingerprint },
      observation
    )
  ).toEqual({ lifecycleIssue: null });
  expect(returnDecision({ state: 'sold', returnDecisionFingerprint: 'old' }, observation)).toEqual({
    lifecycleIssue: 'sold_return_conflict',
  });
});
test.each([null, [], [sn, sn], ['1234567890'], ['a123456789'], [sn, 'B123456789']])(
  '不完整或非法 SN 不猜测 %j',
  value => {
    expect(explicitSerials({ serialNumbers: value }, 1)).toEqual([]);
  }
);
test('仅单项完整 SN 可用于匹配', () => {
  expect(explicitSerials({ serialNumber: sn }, 1)).toEqual([sn]);
  expect(explicitSerials({ serialNumbers: [sn] }, 2)).toEqual([]);
});
test('退货状态、数量或SN变化使旧人工确认失效', () => {
  const items = [
    { key: 'item', name: '设备', quantity: 1, rawStatus: 'RETURN_STARTED', serialNumbers: [sn] },
  ];
  expect(returnFingerprint(items)).toBe(returnFingerprint(JSON.parse(JSON.stringify(items))));
  expect(returnFingerprint(items)).not.toBe(returnFingerprint([{ ...items[0], quantity: 2 }]));
});

test('已退货设备遇到新的歧义观测也必须提示人工确认', () => {
  expect(
    returnDecision({ state: 'returned' }, { ...observation, ambiguous: true, matched: false })
  ).toEqual({ lifecycleIssue: 'return_pending' });
});
