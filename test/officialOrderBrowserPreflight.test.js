/* eslint-disable no-magic-numbers -- 明确两次收据额度、时间边界和隔离临时表。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const {
  preflightBrowser,
  preflightHttp,
} = require('../scripts/officialPickupBackfill/preflightGate');
const { hash } = require('../src/services/officialOrderSupport');
let root;
const account = hash('current@example.test');
const order = 'W1234567890';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-preflight-'));
  fs.mkdirSync(path.join(root, 'private'), { mode: 0o700 });
  const files = {
    'plan.json': {
      schemaVersion: 3,
      scope: 'missing-fields',
      cutoff: null,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      policy: { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 },
      entries: [{ id: 1, orderNumber: order }],
    },
    'request-1.json': {
      capturedAt: new Date().toISOString(),
      samples: [
        {
          id: 1,
          orderNumber: order,
          accountHash: account,
          beforeRowHash: 'a'.repeat(32),
          url: `https://www.apple.com.cn/shop/order/list/${order}/owner`,
        },
      ],
    },
  };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'private', name), JSON.stringify(value), { mode: 0o600 });
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const mockClient = (accountPaused, loginPaused, attempts) => ({
  query: jest.fn(sql =>
    Promise.resolve({
      rows: sql.startsWith('SELECT') ? [{ accountPaused, loginPaused, attempts }] : [],
    })
  ),
});

test.each([
  [true, true, 10, 'ACCOUNT_COOLDOWN'],
  [false, true, 0, 'LOGIN_COOLDOWN'],
  [false, true, 10, 'LOGIN_COOLDOWN'],
  [false, false, 0, 'BROWSER_PREFLIGHT_ALLOWED'],
  [false, false, 1, 'BROWSER_PREFLIGHT_ALLOWED'],
  [false, false, 3, 'BROWSER_PREFLIGHT_ALLOWED'],
  [false, false, 8, 'BROWSER_PREFLIGHT_ALLOWED'],
  [false, false, 9, 'RECEIPT_ATTEMPT_LIMIT'],
  [false, false, 10, 'RECEIPT_ATTEMPT_LIMIT'],
])('浏览器账号=%s 登录=%s 已用=%s → %s', async (paused, login, attempts, outcome) => {
  const client = mockClient(paused, login, attempts);
  const result = await preflightBrowser(client, root, 1);
  expect(result).toMatchObject({
    version: 2,
    mode: 'browser',
    requiredAttempts: 2,
    outcome,
    orderId: 1,
    accountPaused: paused,
    loginPaused: login,
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
      'mode',
      'requiredAttempts',
      'loginPaused',
    ].sort()
  );
  expect(client.query.mock.calls[2][1]).toEqual([account, hash(order)]);
  expect(client.query.mock.calls[2][0]).toMatch(/scope='login'/);
  expect(client.query.mock.calls[2][0]).not.toMatch(/INSERT|UPDATE|DELETE|\bruns\b|sample_id/);
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
});

test.each([null, 1, 'false'])('数据库登录暂停类型错误 %s 不伪装暂缓', async value => {
  const client = mockClient(false, value, 0);
  await expect(preflightBrowser(client, root, 1)).rejects.toMatchObject({
    code: 'GATE_PREFLIGHT_FAILED',
  });
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
});

test('browser 查询失败只读回滚，HTTP 已用 9 次仍允许且忽略 login', async () => {
  const client = mockClient(false, true, 9);
  const result = await preflightHttp(client, root, 1);
  expect(result.outcome).toBe('HTTP_PREFLIGHT_ALLOWED');
  expect(result).not.toHaveProperty('mode');
  expect(result).not.toHaveProperty('loginPaused');
  expect(client.query.mock.calls[2][0]).not.toMatch(/login/);
  client.query.mockImplementation(sql =>
    sql.startsWith('SELECT') ? Promise.reject(Error('query failed')) : Promise.resolve({ rows: [] })
  );
  await expect(preflightBrowser(client, root, 1)).rejects.toThrow('query failed');
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
});

describe('真实隔离 PostgreSQL：双暂停和两次余量', () => {
  let client;
  beforeEach(async () => {
    try {
      client = new Client({
        host: 'official-order-rebuild-postgres',
        user: 'postgres',
        password: 'test-only',
        database: 'postgres',
      });
      await client.connect();
      await client.query(
        'CREATE TEMP TABLE collector_pauses(scope text,key text,until_at timestamptz)'
      );
      await client.query(
        'CREATE TEMP TABLE collector_attempts(order_hash text,account_hash text,' +
          'created_at timestamptz)'
      );
    } catch (error) {
      throw Object.assign(error, { component: 'browser-preflight-test' });
    }
  });
  afterEach(async () => {
    try {
      if (client) await client.end();
    } catch (error) {
      throw Object.assign(error, { component: 'browser-preflight-test' });
    }
  });
  test('无历史run也查询当前账号登录暂停，账号暂停优先；读取不改变记录', async () => {
    try {
      await client.query(
        "INSERT INTO collector_pauses VALUES('login',$1,now()+interval '1 hour')",
        [account]
      );
      expect((await preflightBrowser(client, root, 1)).outcome).toBe('LOGIN_COOLDOWN');
      await client.query(
        "INSERT INTO collector_pauses VALUES('account',$1,now()+interval '1 hour')",
        [account]
      );
      expect((await preflightBrowser(client, root, 1)).outcome).toBe('ACCOUNT_COOLDOWN');
      expect(
        (await client.query('SELECT count(*)::int AS n FROM collector_pauses')).rows[0].n
      ).toBe(2);
      expect(
        (await client.query('SELECT count(*)::int AS n FROM collector_attempts')).rows[0].n
      ).toBe(0);
    } catch (error) {
      throw Object.assign(error, { component: 'browser-preflight-test' });
    }
  });
  test('旧账号尝试也计入同订单24h，过期尝试与暂停不计；每次查询为只读', async () => {
    try {
      await client.query(
        "INSERT INTO collector_pauses VALUES('login',$1,now()-interval '1 second')",
        [account]
      );
      await client.query(
        "INSERT INTO collector_attempts VALUES($1,'old',now()-interval '25 hours')," +
          "($1,'old',now())",
        [hash(order)]
      );
      await client.query(
        "INSERT INTO collector_attempts SELECT $1,'another',now() FROM generate_series(1,7)",
        [hash(order)]
      );
      const query = client.query.bind(client);
      const reads = [];
      client.query = async (...args) => {
        try {
          if (args[0].startsWith('SELECT EXISTS'))
            reads.push((await query('SHOW transaction_read_only')).rows[0].transaction_read_only);
          return await query(...args);
        } catch (error) {
          throw Object.assign(error, { component: 'browser-preflight-test' });
        }
      };
      expect((await preflightBrowser(client, root, 1)).outcome).toBe('BROWSER_PREFLIGHT_ALLOWED');
      await client.query("INSERT INTO collector_attempts VALUES($1,'different',now())", [
        hash(order),
      ]);
      expect((await preflightBrowser(client, root, 1)).outcome).toBe('RECEIPT_ATTEMPT_LIMIT');
      expect(reads).toEqual(['on', 'on']);
      expect(
        (await client.query('SELECT count(*)::int AS n FROM collector_attempts')).rows[0].n
      ).toBe(10);
    } catch (error) {
      throw Object.assign(error, { component: 'browser-preflight-test' });
    }
  });
});

describe('批次原值预检脚本的真实隔离 PostgreSQL', () => {
  let client;
  let expected;
  let readOnly;
  const script = fs
    .readFileSync(path.join(__dirname, '../scripts/officialOrder/runBrowserBatch.py'), 'utf8')
    .split("SNAPSHOT_SCRIPT = r'''")[1]
    .split("'''")[0];
  const vm = require('vm');
  beforeEach(async () => {
    try {
      client = new Client({
        host: 'official-order-rebuild-postgres',
        user: 'postgres',
        password: 'test-only',
        database: 'postgres',
      });
      await client.connect();
      await client.query("SET TIME ZONE 'Asia/Shanghai'");
      await client.query(
        'CREATE TEMP TABLE orders(id int,order_number text,email_order_status text,' +
          'actual_pickup_date date)'
      );
      await client.query('CREATE TEMP TABLE pickup_devices(order_id int)');
      await client.query("INSERT INTO orders VALUES(1,'W1234567890','picked_up','2026-09-22')");
      const { rows } = await client.query(
        "SELECT md5((to_jsonb(o)-'actual_pickup_date')::text) AS original," +
          'md5(to_jsonb(o)::text) AS full FROM orders o'
      );
      expected = {
        id: 1,
        orderNumber: order,
        rowHash: rows[0].original,
        previousDate: '2026-09-22',
      };
      expected.full = rows[0].full;
      readOnly = [];
    } catch (error) {
      throw Object.assign(error, { component: 'snapshot-test' });
    }
  });
  afterEach(async () => {
    try {
      await client.end();
    } catch (error) {
      throw Object.assign(error, { component: 'snapshot-test' });
    }
  });
  async function execute(values, production = true) {
    try {
      const out = [];
      const err = [];
      const query = client.query.bind(client);
      const fake = {
        connect: () => Promise.resolve(),
        end: () => query('ROLLBACK'),
        query: async (...args) => {
          try {
            if (args[0].startsWith('SELECT o.id'))
              readOnly.push(
                (await query('SHOW transaction_read_only')).rows[0].transaction_read_only
              );
            return await query(...args);
          } catch (error) {
            throw Object.assign(error, { component: 'snapshot-test' });
          }
        },
      };
      const context = {
        EXPECTED: values,
        require: () => ({
          Client: function ClientFixture() {
            return fake;
          },
        }),
        process: {
          env: {
            NODE_ENV: production ? 'production' : 'test',
            DB_HOST: 'official-order-rebuild-postgres',
            DB_NAME: 'postgres',
          },
          stdout: { write: value => out.push(value) },
          stderr: { write: value => err.push(value) },
          exitCode: 0,
        },
      };
      await vm.runInNewContext(script, context);
      return { out: out.join(''), err: err.join(''), code: context.process.exitCode };
    } catch (error) {
      throw Object.assign(error, { component: 'snapshot-test' });
    }
  }
  test('原仅缺SN与HTTP完整afterHash均通过，只读回滚且不改变行', async () => {
    try {
      expect((await execute(expected)).code).toBe(0);
      expect((await execute({ ...expected, afterHash: expected.full })).code).toBe(0);
      expect(readOnly).toEqual(['on', 'on']);
      expect((await client.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(1);
      expect((await client.query('SELECT count(*)::int AS n FROM pickup_devices')).rows[0].n).toBe(
        0
      );
    } catch (error) {
      throw Object.assign(error, { component: 'snapshot-test' });
    }
  });
  test('日期、原行、afterHash、设备变化或非生产环境全部拒绝且不泄露数据', async () => {
    try {
      for (const values of [
        { ...expected, previousDate: '2026-09-23' },
        { ...expected, rowHash: 'a'.repeat(32) },
        { ...expected, afterHash: 'a'.repeat(32) },
      ]) {
        expect(await execute(values)).toEqual({
          code: 1,
          out: '',
          err: 'BROWSER_BATCH_SNAPSHOT_INVALID',
        });
      }
      expect((await execute(expected, false)).code).toBe(1);
      await client.query('INSERT INTO pickup_devices VALUES(1)');
      expect((await execute(expected)).code).toBe(1);
      expect((await client.query('SELECT count(*)::int AS n FROM pickup_devices')).rows[0].n).toBe(
        1
      );
    } catch (error) {
      throw Object.assign(error, { component: 'snapshot-test' });
    }
  });
});
