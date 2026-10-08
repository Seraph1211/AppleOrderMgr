/* eslint-disable no-magic-numbers -- 明确测试预算、冷却和并发边界。 */
jest.mock('pg', () => ({ Client: jest.fn() }));
const { Client } = require('pg');
const OfficialOrderGate = require('../src/services/officialOrderGate');

const CONFIG = { host: 'apple-account-research-db', database: 'apple_account_research' };
const SAMPLE = { id: 11, accountHash: 'account', orderHash: 'order' };
let state;
let clients;

beforeEach(() => {
  state = { requests: 0, count: 0, locked: true, paused: false, queries: [] };
  clients = [];
  Client.mockImplementation(() => {
    const client = {
      connect: jest.fn().mockResolvedValue(),
      end: jest.fn().mockResolvedValue(),
      query: jest.fn((sql, args) => {
        try {
          state.queries.push({ sql, args });
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: state.locked }] };
          if (sql.includes('SELECT reason'))
            return { rows: state.paused ? [{ reason: 'HTTP_429' }] : [] };
          if (sql.includes('SELECT requests') || sql.includes('SELECT requests,extract'))
            return { rows: [{ requests: state.requests, gap: 1000 }] };
          if (sql.includes('SELECT count')) return { rows: [{ count: state.count }] };
          if (sql.includes('INSERT INTO runs')) return { rows: [{ id: 21 }] };
          if (sql.includes('UPDATE budget SET requests')) state.requests += 1;
          return { rows: [] };
        } catch (error) {
          error.component = 'mock';
          throw error;
        }
      }),
    };
    clients.push(client);
    return client;
  });
});

test('生产库配置在建连前拒绝', () => {
  expect(() => new OfficialOrderGate({ ...CONFIG, database: 'production' }, 100)).toThrow(
    'ISOLATED_DATABASE_REQUIRED'
  );
  expect(Client).not.toHaveBeenCalled();
});
test('生产手动冷登录允许显式有限预算，仍有硬上限', async () => {
  expect(() => new OfficialOrderGate(CONFIG, 1000, 401)).toThrow('ISOLATED_DATABASE_REQUIRED');
  const gate = new OfficialOrderGate(CONFIG, 1000, 300);
  await gate.open(SAMPLE, 'proxy');
  gate.requests = 200;
  await expect(gate.permit('https://www.apple.com.cn/', () => false)).resolves.toBeDefined();
  gate.requests = 300;
  await expect(gate.permit('https://www.apple.com.cn/', () => false)).rejects.toThrow(
    'REQUEST_BUDGET'
  );
  await gate.close('LIMIT');
});
test.each(['locked', 'paused', 'attempts', 'budget'])(
  '重启仍受账号互斥、冷却、次数和总预算约束：%s',
  async kind => {
    const gate = new OfficialOrderGate(CONFIG, 100);
    if (kind === 'locked') state.locked = false;
    if (kind === 'paused') state.paused = true;
    if (kind === 'attempts') state.count = 10;
    if (kind === 'budget') state.requests = 100;
    await expect(gate.open(SAMPLE, 'proxy')).rejects.toThrow();
    expect(state.queries.some(q => q.sql.includes('INSERT INTO runs'))).toBe(false);
    await gate.close('REJECTED');
  }
);
test('滚动24小时已用9次允许第10次，达到10次不新建运行或清理历史', async () => {
  const gate = new OfficialOrderGate(CONFIG, 100);
  state.count = 9;
  await expect(gate.open(SAMPLE, 'proxy')).resolves.toBe(21);
  expect(state.queries.filter(q => q.sql.includes('INSERT INTO collector_attempts'))).toHaveLength(
    1
  );
  await gate.finishOrder('SUCCEEDED');
  state.count = 10;
  await expect(gate.startOrder(SAMPLE)).rejects.toThrow('ORDER_ATTEMPT_LIMIT');
  expect(state.queries.filter(q => q.sql.includes('INSERT INTO runs'))).toHaveLength(1);
  const counts = state.queries.filter(q => q.sql.includes('SELECT count'));
  expect(counts).toHaveLength(2);
  expect(counts.every(q => q.sql.includes("created_at > now()-interval '24 hours'"))).toBe(true);
  expect(counts.every(q => q.args[0] === SAMPLE.orderHash)).toBe(true);
  expect(state.queries.some(q => /DELETE|TRUNCATE/.test(q.sql))).toBe(false);
  await gate.close('ORDER_ATTEMPT_LIMIT');
});
test('并发许可持久化在放行前完成，失败不退预算', async () => {
  const gate = new OfficialOrderGate(CONFIG, 100);
  await gate.open(SAMPLE, 'proxy');
  const permits = await Promise.all(
    [1, 2, 3].map(() => gate.permit('https://www.apple.com.cn/', () => false))
  );
  expect(permits.map(p => p.index)).toEqual([1, 2, 3]);
  expect(state.requests).toBe(3);
  expect(state.queries.filter(q => q.sql === 'COMMIT')).toHaveLength(4);
  expect(state.queries.some(q => q.sql.includes('requests-1'))).toBe(false);
  await gate.close('NETWORK_FAILED');
  expect(clients.every(client => client.end.mock.calls.length === 1)).toBe(true);
});
test('危险重定向、停止、每轮预算和时长不会获得许可', async () => {
  const gate = new OfficialOrderGate(CONFIG, 1000);
  await gate.open(SAMPLE, 'proxy');
  await expect(gate.permit('https://evil.test/', () => false)).rejects.toThrow(
    'DESTINATION_DENIED'
  );
  await expect(gate.permit('https://www.apple.com.cn/', () => true)).rejects.toThrow(
    'REQUEST_STOPPED'
  );
  gate.requests = 200;
  await expect(gate.permit('https://www.apple.com.cn/', () => false)).rejects.toThrow(
    'REQUEST_BUDGET'
  );
  gate.requests = 0;
  gate.started = Date.now() - 180001;
  await expect(gate.permit('https://www.apple.com.cn/', () => false)).rejects.toThrow(
    'TIME_BUDGET'
  );
  expect(state.requests).toBe(0);
  await gate.close('LIMIT');
});
test('429 服从 Retry-After，认证错误暂停账号，密码提交有持久化冷却', async () => {
  const gate = new OfficialOrderGate(CONFIG, 100);
  await gate.open(SAMPLE, 'proxy');
  await gate.claimLogin();
  await gate.recordFailure('HTTP_429', '7200');
  await gate.recordFailure('AUTH_REJECTED');
  await gate.recordFailure('AUTH_PRECONDITION_REQUIRED');
  await gate.recordFailure('HUMAN_VERIFICATION_REQUIRED');
  const pauses = state.queries
    .filter(q => q.sql.includes('INSERT INTO collector_pauses'))
    .map(q => q.args);
  expect(pauses).toContainEqual(['login', 'account', 'LOGIN_SUBMITTED', 900]);
  expect(pauses).toContainEqual(['proxy', 'proxy', 'HTTP_429', 7200]);
  expect(pauses).toContainEqual(['account', 'account', 'AUTH_REJECTED', 900]);
  expect(pauses).toContainEqual(['account', 'account', 'AUTH_PRECONDITION_REQUIRED', 900]);
  expect(pauses).toContainEqual(['account', 'account', 'HUMAN_VERIFICATION_REQUIRED', 900]);
  expect(
    state.queries
      .filter(q => q.sql.includes('INSERT INTO collector_pauses'))
      .every(q => q.sql.includes('greatest(collector_pauses.until_at,excluded.until_at)'))
  ).toBe(true);
  await gate.close('AUTH_REJECTED');
});
test('429 日期等待和 541 默认冷却不缩短旧暂停', async () => {
  const gate = new OfficialOrderGate(CONFIG, 100);
  await gate.open(SAMPLE, 'proxy');
  await gate.recordFailure('HTTP_429', new Date(Date.now() + 3600000).toUTCString());
  await gate.recordFailure('HTTP_541');
  await gate.recordFailure('HTTP_429', '172800');
  const pauses = state.queries.filter(q => q.sql.includes('INSERT INTO collector_pauses'));
  expect(pauses[0].args[3]).toBeGreaterThan(3500);
  expect(pauses[1].args[3]).toBe(1800);
  expect(pauses[2].args[3]).toBe(172800);
  expect(pauses[0].sql).toContain('greatest');
  await gate.close('HTTP_541');
});

test.each(['HTTP_429', 'HTTP_407', 'HTTP_AUTH_FAILED', 'PROXY_CONNECTION_FAILED'])(
  '账号冷却调整后代理 %s 仍至少暂停30分钟',
  async code => {
    const gate = new OfficialOrderGate(CONFIG, 100);
    await gate.open(SAMPLE, 'proxy');
    await gate.recordFailure(code, '15');
    const pauses = state.queries.filter(q => q.sql.includes('INSERT INTO collector_pauses'));
    expect(pauses.map(q => q.args)).toEqual([['proxy', 'proxy', code, 1800]]);
    await gate.close(code);
  }
);

test('授权新批次不创建登录或541冷却，保留登录审计和429保护', async () => {
  const gate = new OfficialOrderGate(CONFIG, 1000, 300, { loginCooldown: false, proxy541Limit: 3 });
  await gate.open(SAMPLE, 'proxy');
  await gate.claimLogin();
  await gate.recordFailure('HTTP_541');
  await gate.recordFailure('HTTP_503');
  expect(state.queries.filter(q => q.sql.includes('INSERT INTO collector_pauses'))).toHaveLength(0);
  expect(state.queries.some(q => q.sql.includes('SET login_at=now()'))).toBe(true);
  await gate.recordFailure('HTTP_429', '7200');
  expect(state.queries.filter(q => q.sql.includes('INSERT INTO collector_pauses'))[0].args).toEqual(
    ['proxy', 'proxy', 'HTTP_429', 7200]
  );
  await gate.close('HTTP_503');
});

test('三次541策略只跳过旧541代理冷却，其他暂停仍有效', async () => {
  const gate = new OfficialOrderGate(CONFIG, 1000, 300, { proxy541Limit: 3 });
  gate.lockClient.query.mockResolvedValue({ rows: [{ reason: 'HTTP_541' }] });
  await expect(gate.assertAvailable('proxy', 'proxy')).resolves.toBeUndefined();
  await expect(gate.assertAvailable('account', 'account')).rejects.toThrow('ACCOUNT_COOLDOWN');
  gate.lockClient.query.mockResolvedValue({ rows: [{ reason: 'HTTP_429' }] });
  await expect(gate.assertAvailable('proxy', 'proxy')).rejects.toThrow('PROXY_COOLDOWN');
});

test('每日10次不会把541轮换策略从3次改为10次', async () => {
  const gate = new OfficialOrderGate(CONFIG, 1000, 300, { proxy541Limit: 10 });
  gate.proxyHash = 'proxy';
  gate.lockClient.query.mockResolvedValue({ rows: [{ reason: 'HTTP_541' }] });
  await expect(gate.assertAvailable('proxy', 'proxy')).rejects.toThrow('PROXY_COOLDOWN');
  await gate.recordFailure('HTTP_541');
  expect(gate.lockClient.query).toHaveBeenLastCalledWith(expect.any(String), [
    'proxy',
    'proxy',
    'HTTP_541',
    1800,
  ]);
  await gate.close('HTTP_541');
});

test('账号组多单沿用账号锁、时间与总请求计数，每单独立登记尝试', async () => {
  const gate = new OfficialOrderGate(CONFIG, 1000, 300);
  await gate.open(SAMPLE, 'proxy');
  const started = gate.started;
  await gate.permit('https://www.apple.com.cn/', () => false);
  await gate.finishOrder('SUCCEEDED');
  await gate.startOrder({ ...SAMPLE, id: 12, orderHash: 'order-2' });
  expect(gate.started).toBe(started);
  expect(gate.requests).toBe(1);
  expect(state.queries.filter(q => q.sql.includes('pg_try_advisory_lock'))).toHaveLength(1);
  expect(state.queries.filter(q => q.sql.includes('INSERT INTO collector_attempts'))).toHaveLength(
    2
  );
  await gate.finishOrder('SUCCEEDED');
  state.count = 10;
  await expect(gate.startOrder({ ...SAMPLE, id: 13 })).rejects.toThrow('ORDER_ATTEMPT_LIMIT');
  await expect(gate.startOrder({ ...SAMPLE, accountHash: 'another' })).rejects.toThrow(
    'ACCOUNT_MISMATCH'
  );
  await gate.close('PARTIAL');
});
