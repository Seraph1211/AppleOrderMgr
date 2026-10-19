const policy = require('../src/services/aosSignalPolicy');

// Association fixtures use literal byte offsets and timestamps to expose boundary ordering.
/* eslint-disable no-magic-numbers */
const source = { key: 'device:instance', server: 'US01', instance: '心蓝1' };
const anchor = (index, taskKey = 'task-1') => ({
  id: `anchor-${index}`,
  deviceId: 'device',
  localId: 'instance',
  fileId: 'file',
  taskKey,
  byteOffset: index * 4,
  loggedAt: 1000 + index,
  receivedAt: 2000 + index,
});
const observation = (index, city = '未知', storeCode = '未知', storeName = '未知') => ({
  city,
  storeCode,
  storeName,
  model: 'iPhone Duo',
  color: '星光白色',
  capacity: '512G',
  observedAt: 1000 + index,
  source,
});

test('缺城市或门店时不视为完整地址', () => {
  expect(policy.hasLocation(observation(1, '上海', 'R389', 'Apple 浦东'))).toBe(true);
  expect(policy.hasLocation(observation(1, '未知', 'R389', 'Apple 浦东'))).toBe(false);
  expect(policy.hasLocation(observation(1, '上海', '未知', '未知'))).toBe(false);
});

test('锚点之后才出现的预约不能补到该锚点上', () => {
  const anchorEntry = {
    ...anchor(1),
    id: 'anchor-event',
    kind: 'anchor',
    byteOffset: 4,
    loggedAt: 1004,
  };
  const context = {
    source,
    events: [
      { ...anchorEntry, id: 'stock', kind: 'stock', byteOffset: 1, loggedAt: 1001 },
      {
        ...anchorEntry,
        id: 'late-booking',
        kind: 'booking',
        byteOffset: 5,
        loggedAt: 1005,
        city: '上海',
        storeCode: 'R389',
        storeName: 'Apple 浦东',
      },
    ],
  };

  expect(policy.observation(context, anchorEntry)).toMatchObject({
    city: '未知',
    storeCode: '未知',
    storeName: '未知',
  });
});

test('窗口引用达到上限后冻结完整分组并保留总数与来源计数', () => {
  let window = { from: 2000, until: 182000, groups: {} };
  for (let index = 1; index <= policy.MAX_ASSOCIATION_REFS + 7; index++) {
    window = policy.addAssociation(window, anchor(index), observation(index));
  }

  expect(window.association.refs).toHaveLength(policy.MAX_ASSOCIATION_REFS);
  expect(window.association.overflowCount).toBe(7);
  const total = Object.values(window.groups).reduce((sum, group) => sum + group.count, 0);
  const frozen = Object.values(window.association.frozenGroups).reduce(
    (sum, group) => sum + group.count,
    0
  );
  expect(total).toBe(policy.MAX_ASSOCIATION_REFS + 7);
  expect(frozen).toBe(7);
  expect(Object.values(window.association.frozenGroups)[0].sources[source.key].count).toBe(7);
  expect(JSON.stringify(window.association)).not.toMatch(/A77|RMB|原始日志/);
});

test('重分组按taskKey读取上下文，原计数和来源计数不重复', () => {
  let window = { from: 2000, until: 182000, groups: {} };
  window = policy.addAssociation(window, anchor(1), observation(1));
  const stock = {
    ...anchor(1),
    id: 'stock-1',
    kind: 'stock',
    byteOffset: 1,
    loggedAt: 998,
  };
  const booking = {
    ...anchor(1),
    id: 'booking-1',
    kind: 'booking',
    byteOffset: 3,
    loggedAt: 999,
    city: '上海',
    storeCode: 'R389',
    storeName: 'Apple 浦东',
  };
  const context = {
    source,
    events: [stock, booking],
  };
  const refreshed = policy.refreshAssociation(window.association, new Map([['task-1', context]]));
  const groups = Object.values(refreshed.groups);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ city: '上海', storeCode: 'R389', count: 1 });
  expect(groups[0].sources[source.key].count).toBe(1);
  expect(Object.values(window.groups).reduce((sum, group) => sum + group.count, 0)).toBe(1);
  expect(refreshed.association.refs[0].anchor).toEqual(anchor(1));
});

test('上下文截尾后锚点保留最多三条脱敏证据，不退回未知', () => {
  const entry = (id, kind, byteOffset, loggedAt, fields = {}) => ({
    ...anchor(1),
    id,
    kind,
    byteOffset,
    loggedAt,
    ...fields,
  });
  const targetAnchor = { ...anchor(1), byteOffset: 4, loggedAt: 1004 };
  const context = {
    source,
    events: [
      entry('stock', 'stock', 1, 1001),
      entry('booking', 'booking', 2, 1002, {
        city: '上海',
        storeCode: 'R389',
        storeName: 'Apple 浦东',
        message: 'raw booking log must not persist',
      }),
      entry('product', 'product', 3, 1003, {
        model: 'iPhone Duo',
        color: '星光白色',
        capacity: '512G',
        message: 'raw product log must not persist',
      }),
    ],
  };
  const original = policy.observation(context, targetAnchor);
  let window = { groups: {} };
  window = policy.addAssociation(window, targetAnchor, original, context);
  const truncated = {
    source,
    events: Array.from({ length: 100 }, (_, index) =>
      entry(`later-${index}`, 'reset', 10 + index, 2000 + index)
    ),
  };
  const refreshed = policy.refreshAssociation(window.association, new Map([['task-1', truncated]]));

  expect(window.association.refs[0].events).toHaveLength(3);
  expect(refreshed.association.refs[0].events).toHaveLength(3);
  expect(Object.values(refreshed.groups)[0]).toMatchObject({
    city: '上海',
    storeCode: 'R389',
    model: 'iPhone Duo',
    color: '星光白色',
    capacity: '512G',
    count: 1,
  });
  expect(JSON.stringify(refreshed.association)).not.toContain('raw booking log');
  expect(JSON.stringify(refreshed.association)).not.toContain('raw product log');
});
