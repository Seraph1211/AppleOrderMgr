/* eslint-disable no-magic-numbers -- 只读预检的明确时间、次数和隔离临时表边界。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const { preflightHttp } = require('../scripts/officialPickupBackfill/preflightGate');
const { hash } = require('../src/services/officialOrderSupport');
const vm = require('vm');
let root;
let plan;
let input;
const accountHash = hash('current@example.test');
const orderHash = hash('W1234567890');
const save = () => {
  for (const [name, value] of [
    ['plan.json', plan],
    ['request-1.json', input],
  ]) {
    fs.writeFileSync(path.join(root, 'private', name), JSON.stringify(value), { mode: 0o600 });
  }
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-preflight-'));
  fs.mkdirSync(path.join(root, 'private'), { mode: 0o700 });
  plan = {
    schemaVersion: 3,
    scope: 'missing-fields',
    cutoff: null,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    policy: { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 },
    entries: [{ id: 1, orderNumber: 'W1234567890' }],
  };
  input = {
    capturedAt: new Date(Date.now() - 1000).toISOString(),
    samples: [
      {
        id: 1,
        orderNumber: 'W1234567890',
        accountHash,
        beforeRowHash: 'a'.repeat(32),
        url: 'https://www.apple.com.cn/shop/order/list/W1234567890/current%40example.test',
      },
    ],
  };
  save();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const mockClient = (accountPaused = false, attempts = 0) => ({
  query: jest.fn(sql =>
    Promise.resolve({
      rows: sql.startsWith('SELECT') ? [{ accountPaused, attempts }] : [],
    })
  ),
});

test.each([
  [true, 0, 'ACCOUNT_COOLDOWN'],
  [true, 10, 'ACCOUNT_COOLDOWN'],
  [false, 10, 'ORDER_ATTEMPT_LIMIT'],
  [false, 11, 'ORDER_ATTEMPT_LIMIT'],
  [false, 9, 'HTTP_PREFLIGHT_ALLOWED'],
  [false, 3, 'HTTP_PREFLIGHT_ALLOWED'],
])('当前账号=%s、尝试=%s：%s，只读查询不需要本订单旧run', async (paused, attempts, outcome) => {
  const client = mockClient(paused, attempts);
  const result = await preflightHttp(client, root, 1);
  expect(result).toMatchObject({
    version: 2,
    outcome,
    orderId: 1,
    accountPaused: paused,
    attempts,
  });
  expect(Object.keys(result).sort()).toEqual(
    [
      'version',
      'outcome',
      'orderId',
      'checkedAt',
      'planSha256',
      'inputSha256',
      'accountPaused',
      'attempts',
    ].sort()
  );
  expect(result.planSha256).toBe(hash(fs.readFileSync(path.join(root, 'private/plan.json'))));
  expect(result.inputSha256).toBe(hash(fs.readFileSync(path.join(root, 'private/request-1.json'))));
  expect(JSON.stringify(result)).not.toMatch(/W1234567890|current@example|password|runId/);
  expect(client.query.mock.calls[0]).toEqual(['BEGIN READ ONLY']);
  expect(client.query.mock.calls[1]).toEqual(["SET LOCAL statement_timeout='8s'"]);
  expect(client.query.mock.calls[2][1]).toEqual([accountHash, orderHash]);
  expect(client.query.mock.calls[2][0]).not.toMatch(
    /login|sample_id|\bJOIN\b|INSERT|UPDATE|DELETE|runs/
  );
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
});

test.each([
  'id',
  'number',
  'url',
  'account',
  'multiple',
  'failures',
  'stale',
  'future',
  'plan',
  'duplicate',
  'proxyPolicy',
])('身份或范围不符在研究查询前停止：%s', async kind => {
  if (kind === 'id') input.samples[0].id = 2;
  if (kind === 'number') input.samples[0].orderNumber = 'W9999999999';
  if (kind === 'url')
    input.samples[0].url = input.samples[0].url.replace('W1234567890', 'W9999999999');
  if (kind === 'account') input.samples[0].accountHash = 'md5-is-not-sha256';
  if (kind === 'multiple') input.samples.push(input.samples[0]);
  if (kind === 'failures') input.failures = [{ id: 1 }];
  if (kind === 'stale') input.capturedAt = new Date(Date.now() - 301000).toISOString();
  if (kind === 'future') input.capturedAt = new Date(Date.now() + 60000).toISOString();
  if (kind === 'plan') plan.scope = 'all-picked-up';
  if (kind === 'duplicate') plan.entries.push(plan.entries[0]);
  if (kind === 'proxyPolicy') plan.policy.proxy541Limit = 10;
  save();
  const client = mockClient();
  await expect(preflightHttp(client, root, 1)).rejects.toThrow();
  expect(client.query).not.toHaveBeenCalled();
});

test('SQL 异常回滚且不能返回暂缓', async () => {
  const client = mockClient();
  client.query.mockImplementation(sql => {
    if (sql.startsWith('SELECT')) return Promise.reject(new Error('synthetic-database-error'));
    return Promise.resolve({ rows: [] });
  });
  await expect(preflightHttp(client, root, 1)).rejects.toThrow();
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
});
test.each(['before', 'after'])('STOP 在%s查询时优先停止', async when => {
  const client = mockClient(true, 3);
  if (when === 'before') fs.writeFileSync(path.join(root, 'private/STOP'), '');
  else
    client.query.mockImplementation(sql => {
      if (sql.startsWith('SELECT')) fs.writeFileSync(path.join(root, 'private/STOP'), '');
      return Promise.resolve({ rows: [{ accountPaused: true, attempts: 3 }] });
    });
  await expect(preflightHttp(client, root, 1)).rejects.toThrow('REQUEST_STOPPED');
});
test.each([
  { accountPaused: 1, attempts: 0 },
  { accountPaused: false, attempts: '3' },
])('数据库结果类型不符不能猜测：%j', async row => {
  const client = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
  await expect(preflightHttp(client, root, 1)).rejects.toThrow('GATE_PREFLIGHT_FAILED');
});

test.each([[], ['--proxies']].map(args => [args]))(
  '旧 /ops 入口不加载 HTTP 依赖：%j',
  async args => {
    const calls = [];
    const output = [];
    const exportsModule = { exports: {} };
    const fakeClient = class {
      connect() {
        return Promise.resolve();
      }
      end() {
        return Promise.resolve();
      }
      query(sql, values) {
        calls.push([sql, values]);
        return Promise.resolve({ rows: sql.startsWith('BEGIN') ? [] : [{ id: 1, attempts: 2 }] });
      }
    };
    const localRequire = name => {
      if (name === 'module')
        return {
          createRequire: () => dependency => {
            if (dependency !== 'pg') throw new Error('unexpected dependency');
            return { Client: fakeClient };
          },
        };
      if (name === 'path') return path;
      if (name === 'fs')
        return {
          readFileSync: filename =>
            JSON.stringify(filename.endsWith('/db.json') ? {} : { entries: [{ id: 1 }] }),
        };
      throw new Error('HTTP dependency must remain lazy');
    };
    localRequire.main = exportsModule;
    const processStub = {
      argv: ['node', '/ops/preflightGate.js', ...args],
      stdout: { write: text => output.push(text) },
      stderr: { write: jest.fn() },
    };
    vm.runInNewContext(
      fs.readFileSync(require.resolve('../scripts/officialPickupBackfill/preflightGate'), 'utf8'),
      { require: localRequire, module: exportsModule, process: processStub }
    );
    await new Promise(resolve => setImmediate(resolve));
    expect(processStub.exitCode).toBeUndefined();
    expect(processStub.stderr.write).not.toHaveBeenCalled();
    expect(JSON.parse(output.join(''))).toEqual([{ id: 1, attempts: 2 }]);
    expect(calls[0][0]).toBe('BEGIN READ ONLY');
    if (args.length) expect(calls[1][0]).toContain("scope='proxy'");
    else expect(calls[1][0]).toContain("p.scope IN ('account','login')");
  }
);

const describeDb =
  process.env.PICKUP_TEST_DB_HOST === 'official-order-rebuild-postgres' ? describe : describe.skip;
describeDb('真实隔离 PostgreSQL 预检语义', () => {
  let client;
  beforeAll(async () => {
    client = new Client({
      host: process.env.PICKUP_TEST_DB_HOST,
      user: 'postgres',
      password: 'test-only',
      database: 'postgres',
    });
    await client.connect();
    await client.query(
      'CREATE TEMP TABLE collector_pauses(scope text,key text,until_at timestamptz)'
    );
    await client.query(
      'CREATE TEMP TABLE collector_attempts(' +
        'order_hash text,account_hash text,created_at timestamptz)'
    );
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query('TRUNCATE collector_pauses,collector_attempts');
  });
  test('无历史尝试的当前账号冷却仍拦截，仅登录冷却不拦截', async () => {
    await client.query("INSERT INTO collector_pauses VALUES('login',$1,now()+interval '1 hour')", [
      accountHash,
    ]);
    expect((await preflightHttp(client, root, 1)).outcome).toBe('HTTP_PREFLIGHT_ALLOWED');
    await client.query(
      "INSERT INTO collector_pauses VALUES('account',$1,now()+interval '1 hour')",
      [accountHash]
    );
    expect((await preflightHttp(client, root, 1)).outcome).toBe('ACCOUNT_COOLDOWN');
    expect(
      (await client.query('SELECT count(*)::int AS count FROM collector_attempts')).rows[0].count
    ).toBe(0);
  });
  test('按orderHash跨账号计数，超过24小时的旧记录及别的订单不计入', async () => {
    await client.query(
      `INSERT INTO collector_attempts VALUES
      ($1,'old-account',now()-interval '1 hour'),($1,'another',now()-interval '2 hours'),
      ($1,'current',now()-interval '24 hours'),('another-order','current',now())`,
      [orderHash]
    );
    expect((await preflightHttp(client, root, 1)).attempts).toBe(2);
    await client.query(
      "INSERT INTO collector_attempts SELECT $1,'other',now() FROM generate_series(1,7)",
      [orderHash]
    );
    expect((await preflightHttp(client, root, 1)).outcome).toBe('HTTP_PREFLIGHT_ALLOWED');
    await client.query('INSERT INTO collector_attempts VALUES($1,$2,now())', [
      orderHash,
      accountHash,
    ]);
    const observing = {
      query: async (sql, parameters) => {
        if (sql.startsWith('SELECT')) {
          expect(
            (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only
          ).toBe('on');
        }
        return client.query(sql, parameters);
      },
    };
    expect((await preflightHttp(observing, root, 1)).outcome).toBe('ORDER_ATTEMPT_LIMIT');
    expect(
      (await client.query('SELECT count(*)::int AS count FROM collector_attempts')).rows[0].count
    ).toBe(12);
  });
  test('已过期account pause不拦截，预检通过后原保护记录仍可变化', async () => {
    await client.query(
      "INSERT INTO collector_pauses VALUES('account',$1,now()-interval '1 second')",
      [accountHash]
    );
    expect((await preflightHttp(client, root, 1)).outcome).toBe('HTTP_PREFLIGHT_ALLOWED');
    await client.query("UPDATE collector_pauses SET until_at=now()+interval '1 hour'");
    expect((await preflightHttp(client, root, 1)).outcome).toBe('ACCOUNT_COOLDOWN');
  });
});
