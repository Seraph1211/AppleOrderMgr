jest.mock('../src/models', () => ({}));
const {
  normalizeRule,
  buildRuleIndex,
  matchRule,
} = require('../src/services/paymentTagRuleService');
const {
  selectCandidate,
  describeAutoAssignment,
} = require('../src/services/paymentAssignmentPolicy');

const input = {
  name: '渠道分配',
  enabled: true,
  recipientTags: ['渠道A', '渠道B'],
  assigneeUserIds: [1, 2],
};
const candidate = (id, activeCount = 0, capacity = 10, lastAssignedAt = null) => ({
  setting: { userId: id, maxActiveTasks: capacity, lastAssignedAt },
  activeCount,
});

test('规则规范化只去首尾空格，保留 TAG 内部字符和大小写', () => {
  expect(
    normalizeRule({ ...input, name: '  渠道分配  ', recipientTags: [' A B ', 'A B', 'a b'] })
  ).toMatchObject({ name: '渠道分配', recipientTags: ['A B', 'a b'] });
});

test.each([
  { name: '' },
  { name: 2 },
  { name: 'a'.repeat(101) },
  { enabled: 'true' },
  { recipientTags: [] },
  { recipientTags: [' '] },
  { recipientTags: [1] },
  { recipientTags: ['a'.repeat(501)] },
  { recipientTags: Array(101).fill('A') },
  { assigneeUserIds: [] },
  { assigneeUserIds: [1, 1] },
  { assigneeUserIds: ['1'] },
  { assigneeUserIds: [0] },
  { assigneeUserIds: [1.5] },
  { assigneeUserIds: [2147483648] },
  { assigneeUserIds: Array.from({ length: 101 }, (_, i) => i + 1) },
])('拒绝不合法规则 %j', patch => {
  expect(() => normalizeRule({ ...input, ...patch })).toThrow();
});

test('仅 AOS 来源完整匹配，不做前缀、包含或档案 TAG 匹配', () => {
  const rule = { ...input, id: 7 };
  const index = buildRuleIndex([rule, { ...input, id: 8, enabled: false }]);
  expect(
    matchRule({ ingestionSource: 'aos', sourceRecipientTag: ' 渠道A ', tag: 'OTHER' }, index)
  ).toBe(rule);
  expect(matchRule({ ingestionSource: 'aos', sourceRecipientTag: null, tag: '渠道B' }, index)).toBe(
    rule
  );
  for (const order of [
    { ingestionSource: 'email', tag: '渠道A' },
    { ingestionSource: 'aos', tag: '渠道A-1' },
    { ingestionSource: 'aos', tag: '' },
    { ingestionSource: 'aos', sourceRecipientTag: 'OTHER', tag: '渠道A' },
    null,
  ]) {
    expect(matchRule(order, index)).toBeNull();
  }
  expect(
    matchRule(
      { ingestionSource: 'aos', tag: 'a' },
      buildRuleIndex([{ ...input, recipientTags: ['A'] }])
    )
  ).toBeNull();
});

test('只在目标集合按负载比例选人，容量满时不回退；未命中保持默认算法', () => {
  const candidates = [candidate(1, 5), candidate(2, 6, 20), candidate(3)];
  expect(selectCandidate(candidates, input).setting.userId).toBe(2);
  expect(selectCandidate(candidates, null).setting.userId).toBe(3);
  expect(selectCandidate([candidate(1, 10), candidate(2, 20, 20), candidate(3)], input)).toBeNull();
  expect(selectCandidate([candidate(1, 0, 0), candidate(2, 0, 0)], input)).toBeNull();
});

test('相同比例按最久未分配时间及用户 ID 排序', () => {
  expect(selectCandidate([candidate(2), candidate(1)], input).setting.userId).toBe(1);
  expect(
    selectCandidate([candidate(1, 0, 10, '2026-09-12'), candidate(2)], input).setting.userId
  ).toBe(2);
});

const now = new Date('2026-09-12T00:00:00Z');
const task = {
  assigneeUserId: null,
  processingStatus: 'pending',
  paymentLinkSource: 'order_url',
  order: {
    status: 'payment_due',
    paymentStatus: 'unpaid',
    officialOrderCreatedAt: now,
  },
};
const overview = {
  settings: { enabled: true, mode: 'auto' },
  staff: [
    {
      id: 1,
      status: 'active',
      hasExecutionPermissions: true,
      autoAssignEnabled: true,
      remainingCapacity: 1,
    },
  ],
};
test.each([
  [{ settings: { enabled: false } }, 'DISABLED'],
  [{ settings: { enabled: true, mode: 'manual' } }, 'MANUAL_MODE'],
  [{ staff: [] }, 'RULE_NO_ELIGIBLE_STAFF'],
  [{ staff: [{ ...overview.staff[0], remainingCapacity: 0 }] }, 'RULE_CAPACITY_FULL'],
  [{ staff: [{ ...overview.staff[0], autoAssignEnabled: false }] }, 'RULE_NO_ELIGIBLE_STAFF'],
  [{}, 'WAITING_SCAN'],
])('等待原因按当前配置计算 %j', (patch, code) => {
  expect(describeAutoAssignment(task, input, { ...overview, ...patch }, now).reasonCode).toBe(code);
});
test.each([
  [{ processingStatus: 'exception' }, 'NOT_PENDING'],
  [{ order: { ...task.order, paymentStatus: 'paid' } }, 'ORDER_BLOCKED'],
  [{ order: { ...task.order, officialOrderCreatedAt: null } }, 'UNKNOWN_DEADLINE'],
  [{ order: { ...task.order, officialOrderCreatedAt: new Date(now - 3600000) } }, 'EXPIRED'],
  [{ paymentLinkSource: null }, 'MISSING_LINK'],
])('既有订单资格优先于规则等待原因 %j', (patch, code) => {
  expect(describeAutoAssignment({ ...task, ...patch }, input, overview, now).reasonCode).toBe(code);
});
test('已分配不显示待分配原因，无规则时给出默认原因', () => {
  expect(describeAutoAssignment({ ...task, assigneeUserId: 1 }, input, overview, now)).toBeNull();
  expect(describeAutoAssignment(task, null, { ...overview, staff: [] }, now).reasonCode).toBe(
    'NO_ELIGIBLE_STAFF'
  );
  expect(
    describeAutoAssignment(
      task,
      null,
      { ...overview, staff: [{ ...overview.staff[0], remainingCapacity: 0 }] },
      now
    ).reasonCode
  ).toBe('CAPACITY_FULL');
});
