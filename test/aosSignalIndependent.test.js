const captured = require('./aosSignalIndependentFixture.json');
const expected = require('./aosSignalIndependentExpected.json');
const policy = require('../src/services/aosSignalPolicy');

const NOW = Date.parse('2026-10-19T04:00:00+08:00');
const SOURCE = { key: '10:instance-11', server: 'US10', instance: '心蓝11' };

/** 构造不含真实账号或凭据的日志片段。 */
function row(text, byteOffset = 10, overrides = {}) {
  return {
    id: `synthetic-${byteOffset}`,
    deviceId: 1,
    localId: 'one',
    fileId: 'file-version-one',
    byteOffset,
    loggedAt: new Date(NOW - 1000).toISOString(),
    parseState: 'parsed',
    partIndex: 0,
    message: `2026-10-19 03:59:59.000 [2][013]A77-${text}\r\n`,
    ...overrides,
  };
}

/** 按实际日志协议解析，捕获上下文仅包含安全结构字段。 */
function parse(text, byteOffset, overrides) {
  return policy.parseEntry(row(text, byteOffset, overrides), NOW);
}

describe('AOS 放货信号独立验收：真实语法及防串联', () => {
  test('真实日志脱敏回放：26条商品完整，23条门店完整，另3条不借未来预约', () => {
    const contexts = new Map();
    const observations = [];
    for (const item of [...captured].sort((a, b) => a.byteOffset - b.byteOffset)) {
      const entry = policy.parseEntry(item, Date.parse(item.loggedAt) + 1000);
      expect(entry).toBeTruthy();
      const context = policy.mergeContext(contexts.get(entry.taskKey), [entry], SOURCE, NOW);
      contexts.set(entry.taskKey, context);
      if (entry.kind === 'anchor') {
        const observed = policy.observation(context, entry);
        expect(observed).toMatchObject({ ...expected[entry.id], source: SOURCE });
        observations.push(observed);
      }
    }
    expect(observations).toHaveLength(26);
    expect(observations.filter(item => item.storeName !== '未知')).toHaveLength(23);
    expect(observations.filter(item => item.storeName === '未知')).toHaveLength(3);
    for (const observed of observations) {
      if (observed.storeName !== '未知') {
        expect(observed.city).not.toBe('未知');
        expect(observed.storeCode).not.toBe('未知');
      }
    }
  });

  test('精确信号不把其他取货提示作为命中', () => {
    expect(parse('取货信息: 取货日期待付款完成后确定', 1).kind).toBe('anchor');
    expect(parse('取货信息: 等待库存', 2)).toBeNull();
    expect(parse('取货日期待付款完成后确定', 3)).toBeNull();
  });

  test('接收超过3分钟、未来时间、未解析或分段续行都不能入队', () => {
    const message = '取货信息: 取货日期待付款完成后确定';
    for (const overrides of [
      { loggedAt: new Date(NOW - 180001).toISOString() },
      { loggedAt: new Date(NOW + 1).toISOString() },
      { loggedAt: 'invalid' },
      { parseState: 'invalid' },
      { partIndex: 1 },
    ])
      expect(parse(message, 1, overrides)).toBeNull();
    expect(parse(message, 1, { loggedAt: new Date(NOW - 180000).toISOString() })).toBeTruthy();
  });

  test('任务身份隔离设备、实例、文件版本与完整任务前缀', () => {
    const base = parse('商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999', 1);
    const entries = [base];
    for (const overrides of [
      { deviceId: 2 },
      { localId: 'two' },
      { fileId: 'file-version-two' },
      {
        message: row('商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999').message.replace(
          '[013]',
          '[014]'
        ),
      },
      {
        message: row('商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999').message.replace(
          'A77',
          'A78'
        ),
      },
      {
        message: row('商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999').message.replace(
          '[2]',
          '[3]'
        ),
      },
    ])
      entries.push(parse('商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999', 1, overrides));
    expect(new Set(entries.map(entry => entry.taskKey)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.message).toBeUndefined();
      expect(entry.accountNumber).toBeUndefined();
    }
  });

  test('跨批乱序按原始偏移恢复，重放同事件不会累积上下文', () => {
    const events = [
      parse('消息20110501', 1),
      parse('尝试预约: Apple 王府井, 2026-10-25', 2),
      parse('商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999', 3),
    ];
    let context = policy.mergeContext(null, [events[2]], SOURCE, NOW);
    context = policy.mergeContext(context, [events[1], events[0], events[2]], SOURCE, NOW);
    expect(context.events).toHaveLength(3);
    expect(
      policy.observation(context, parse('取货信息: 取货日期待付款完成后确定', 4))
    ).toMatchObject({ storeName: 'Apple 王府井', model: 'iPhone Duo' });
  });

  test('新登录边界之后不能借用上次预约和商品', () => {
    const context = policy.mergeContext(
      null,
      [
        parse('消息20110501', 1),
        parse('尝试预约: Apple 王府井', 2),
        parse('商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999', 3),
        parse('开始登录', 4),
      ],
      SOURCE,
      NOW
    );
    expect(
      policy.observation(context, parse('取货信息: 取货日期待付款完成后确定', 5))
    ).toMatchObject({ storeName: '未知', model: '未知' });
  });

  test('同任务上下文有固定上界', () => {
    const events = Array.from({ length: 200 }, (_, i) => parse('尝试预约: Apple 王府井', i));
    const context = policy.mergeContext(null, events, SOURCE, NOW);
    expect(context.events.length).toBeLessThanOrEqual(100);
    expect(context.events.at(-1).byteOffset).toBe(199);
  });

  test('十台十一实例聚合保留所有来源，次数明示非库存且无原日志账号', () => {
    const groups = {};
    for (let i = 0; i < 11; i += 1)
      policy.addGroup(groups, {
        city: '北京',
        storeCode: 'R448',
        storeName: 'Apple 王府井',
        model: 'iPhone Duo',
        color: '星光白色',
        capacity: '512G',
        source: {
          key: `source-${i}`,
          server: `US${String(Math.min(i + 1, 10)).padStart(2, '0')}`,
          instance: `实例${i + 1}`,
        },
      });
    const text = policy.content(groups, false);
    expect(text).toContain('11次命中｜1家门店');
    for (let i = 1; i <= 11; i += 1) expect(text).toContain(`实例${i}｜`);
    expect(text).not.toContain('[013]');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1400);
  });

  test('不同门店商品分组可追溯具体来源，日志时间按北京时间显示真实范围', () => {
    const groups = {};
    policy.addGroup(groups, {
      city: '北京',
      storeCode: 'R448',
      storeName: 'Apple 王府井',
      model: 'iPhone Duo',
      color: '星光白色',
      capacity: '512G',
      observedAt: NOW - 120000,
      source: { key: 'one', server: 'US01', instance: '心蓝01' },
    });
    policy.addGroup(groups, {
      city: '深圳',
      storeCode: 'R576',
      storeName: 'Apple 深圳万象城',
      model: 'iPhone Duo',
      color: '夜空色',
      capacity: '256G',
      observedAt: NOW,
      source: { key: 'two', server: 'US10', instance: '心蓝11' },
    });
    const text = policy.content(groups, false);
    expect(text).toContain('US_01 / 心蓝01｜1次');
    expect(text).toContain('US_10 / 心蓝11｜1次');
    expect(text).toContain('北京 · Apple 王府井\niPhone Duo\n星光白色 · 512G｜1次');
    expect(text).toContain('深圳 · Apple 深圳万象城\niPhone Duo\n夜空色 · 256G｜1次');
    expect(text).toContain('时间：10-19 03:58:00～04:00:00');
  });
});
