/* eslint-disable no-magic-numbers -- 明确验证证据时效、字段范围与真实 PostgreSQL 事务。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const {
  verifyHttpEvidence,
  applyHttpPayload,
  publicHttpApplyResult,
} = require('../scripts/officialPickupBackfill/applyHttpResult');
const { freezePickupBackfill } = require('../src/services/officialPickupBackfill');
const {
  encrypt,
  decrypt,
  hash,
  writePrivate,
  safePath,
} = require('../src/services/officialOrderSupport');
const { parseOfficialOrderDetail } = require('../src/services/officialOrderParser');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');

const NOW = Date.now();
const URL =
  'https://secure6.www.apple.com.cn/shop/orderx/guestx/W1234567890/synthetic?_a=fetchOrder&_m=guestOrderSpinner';
let root;
let source;
let audit;
let plan;
let model;
let key;
let auditName;
let requestUrl;

function saveEvidence(method = 'POST') {
  source.host = new global.URL(requestUrl).hostname;
  source.path = safePath(new global.URL(requestUrl).pathname);
  source.urlHash = hash(requestUrl);
  const bytes = Buffer.from(JSON.stringify(model));
  source.sha256 = hash(bytes);
  source.file = `body-1-${source.sha256.slice(0, 16)}.enc`;
  const response = {
    status: 200,
    url: requestUrl,
    bodyBase64: bytes.toString('base64'),
    rawHeaders: [['Content-Type', source.contentType]],
    cookies: [],
  };
  writePrivate(path.join(root, 'private/plan.json'), JSON.stringify(plan));
  writePrivate(path.join(root, 'private', auditName), JSON.stringify(audit));
  writePrivate(path.join(root, 'private/evidence.key'), key);
  writePrivate(
    path.join(root, 'private/results/order-1-run-12.json'),
    JSON.stringify({
      ...parseOfficialOrderDetail(bytes.toString(), 'W1234567890'),
      systemOrderId: 1,
      source,
    })
  );
  writePrivate(path.join(root, 'evidence/run-12', source.file), encrypt(bytes, key));
  writePrivate(path.join(root, 'evidence/run-12/response-1.enc'), encrypt(response, key));
  writePrivate(
    path.join(root, 'evidence/run-12/request-1.enc'),
    encrypt(
      {
        url: requestUrl,
        method,
        headers: {},
        body: null,
        observedAt: new Date(audit.startedAt * 1000).toISOString(),
      },
      key
    )
  );
  writePrivate(
    path.join(root, 'evidence/run-12/events.jsonl'),
    JSON.stringify({ message: 'http_response', method, bytes: bytes.length, ...source }) + '\n'
  );
}

beforeEach(() => {
  requestUrl = URL;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'official-http-apply-'));
  key = Buffer.alloc(32, 11);
  plan = {
    schemaVersion: 3,
    scope: 'missing-fields',
    cutoff: null,
    startedAt: new Date(NOW - 3000).toISOString(),
    policy: { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 },
    entries: [
      {
        id: 1,
        orderNumber: 'W1234567890',
        rowHash: 'a'.repeat(32),
        accountKey: 'b'.repeat(32),
        dateMissing: true,
        serialsMissing: true,
        previousDate: null,
        previousDevices: [],
      },
    ],
  };
  source = {
    provider: 'Apple official website',
    status: 200,
    cached: false,
    host: 'secure6.www.apple.com.cn',
    path: safePath(new global.URL(URL).pathname),
    urlHash: hash(URL),
    observedAt: new Date(NOW - 1000).toISOString(),
    contentType: 'application/json; charset=utf-8',
    runId: 12,
  };
  audit = {
    outcome: 'SUCCEEDED',
    orderId: 1,
    targetOrderId: 1,
    runId: 12,
    attemptId: 'c'.repeat(32),
    startedAt: (NOW - 2000) / 1000,
    finishedAt: (NOW - 500) / 1000,
    egressHash: 'd'.repeat(64),
    egressAfterHash: 'd'.repeat(64),
    egressVerifiedAfter: true,
    businessWrites: 0,
    cleanup: { removed: true },
    resultFile: '/research/private/results/order-1-run-12.json',
  };
  auditName = `http-sample-1-${audit.attemptId}.json`;
  model = buildLifecycleJson('PICKED_UP');
  const item = model.orderDetail.orderItems[model.orderDetail.orderItems.c[0]];
  item.orderItemDetails.d.deliveryDate = '已取货 9月 22';
  saveEvidence();
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('密文body/response与事件全部匹配，返回重新解析的本轮字段', () => {
  const payload = verifyHttpEvidence(root, auditName, NOW);
  expect(payload.result.products[0]).toMatchObject({
    rawStatus: 'PICKED_UP',
    pickupDateText: '已取货 9月 22',
  });
  expect(payload.entry.id).toBe(1);
  expect(payload.planSha256).toBe(hash(fs.readFileSync(path.join(root, 'private/plan.json'))));
});

test.each([
  ['outcome', 'HTTP_541'],
  ['orderId', 2],
  ['targetOrderId', 2],
  ['runId', 13],
  ['egressAfterHash', 'e'.repeat(64)],
  ['egressVerifiedAfter', false],
  ['finishedAt', (NOW - 1500) / 1000],
  ['startedAt', (NOW - 500) / 1000],
  ['businessWrites', 1],
  ['resultFile', '/research/private/results/order-2-run-12.json'],
  ['cleanup', { removed: false }],
  ['startedAt', String((NOW - 2000) / 1000)],
  ['finishedAt', String((NOW - 500) / 1000)],
])('拒绝错误出口/身份/窗口审计：%s', (field, value) => {
  audit[field] = value;
  saveEvidence();
  expect(() => verifyHttpEvidence(root, auditName, NOW)).toThrow();
});

test.each([
  ['schemaVersion', 2],
  ['scope', 'all-picked-up'],
  ['cutoff', '2026-09-23'],
  ['startedAt', new Date(NOW - 86401000).toISOString()],
  ['policy', { loginCooldown: false, apiHealthCheck: true, proxy541Limit: 3 }],
])('只能消费未过期v3冻结范围：%s', (field, value) => {
  plan[field] = value;
  saveEvidence();
  expect(() => verifyHttpEvidence(root, auditName, NOW)).toThrow('HTTP_APPLY_SCOPE_INVALID');
});

test('不能用旧观测时间作为当前时钟绕开五分钟检查', () => {
  source.observedAt = new Date(NOW - 300001).toISOString();
  plan.startedAt = new Date(NOW - 400000).toISOString();
  audit.startedAt = (NOW - 310000) / 1000;
  saveEvidence();
  expect(() => verifyHttpEvidence(root, auditName, NOW)).toThrow();
});

test('重解析原文，不接受resultFile伪造的状态和日期', () => {
  const filename = path.join(root, 'private/results/order-1-run-12.json');
  const result = JSON.parse(fs.readFileSync(filename));
  result.products[0].rawStatus = 'CANCELLED';
  result.actualPickupDate = '2000-01-01';
  writePrivate(filename, JSON.stringify(result));
  expect(verifyHttpEvidence(root, auditName, NOW).result.products[0].rawStatus).toBe('PICKED_UP');
});

test.each(['body', 'response', 'event', 'content-type'])('损坏%s证据拒绝', kind => {
  if (kind === 'body')
    writePrivate(path.join(root, 'evidence/run-12', source.file), encrypt('different', key));
  if (kind === 'response')
    writePrivate(
      path.join(root, 'evidence/run-12/response-1.enc'),
      encrypt({ status: 200, url: URL, bodyBase64: 'eA==' }, key)
    );
  if (kind === 'event') writePrivate(path.join(root, 'evidence/run-12/events.jsonl'), '{}\n');
  if (kind === 'content-type') {
    source.contentType = 'application/octet-stream';
    saveEvidence();
  }
  expect(() => verifyHttpEvidence(root, auditName, NOW)).toThrow();
});

test('公开输出剔除订单号/设备SN/账号/完整snapshot', () => {
  const result = publicHttpApplyResult({
    mode: 'dry-run',
    orderId: 1,
    snapshot: { orderNumber: 'W1234567890', serial: 'private-sn' },
    basis: { private: 'a@example.test' },
  });
  expect(JSON.stringify(result)).not.toMatch(/W1234567890|private-sn|example\.test|snapshot|basis/);
});

test.each([
  URL.replace('W1234567890', 'W1234567891'),
  URL.replace('fetchOrder', 'cancelOrder'),
  URL + '&unexpected=value',
  URL + '&e=false',
  URL + '&e=true&e=true',
  URL.replace('/guestx/', '/detail/'),
])('密文POST URL必须精确匹配本订单只读fetchOrder：%#', value => {
  requestUrl = value;
  saveEvidence();
  expect(() => verifyHttpEvidence(root, auditName, NOW)).toThrow();
});

test.each([
  ['method', 'DELETE'],
  ['body', 'action=cancel'],
  ['observedAt', new Date(NOW - 2500).toISOString()],
  ['observedAt', new Date(NOW).toISOString()],
])('请求证据的方法、空body和时间窗口必须匹配：%s', (name, value) => {
  const file = path.join(root, 'evidence/run-12/request-1.enc');
  const request = JSON.parse(decrypt(fs.readFileSync(file), key).toString());
  request[name] = value;
  writePrivate(file, encrypt(request, key));
  expect(() => verifyHttpEvidence(root, auditName, NOW)).toThrow();
});

test.each([
  '/shop/order/detail/synthetic/W1234567890',
  '/shop/order/guest/W1234567890/synthetic',
  '/shop/order/guest/W1234567890/synthetic?e=true',
  '/shop/order/list/W1234567890/synthetic',
  '/xc/cn/vieworder/W1234567890/synthetic',
])('官方只读GET详情按各路由精确绑定订单：%#', pathname => {
  requestUrl = 'https://secure6.www.apple.com.cn' + pathname;
  saveEvidence('GET');
  expect(verifyHttpEvidence(root, auditName, NOW).result.identityMatched).toBe(true);
});

test.each([
  '/shop/order/detail/synthetic/W1234567891',
  '/shop/order/detail/synthetic/W1234567890?e=true',
  '/shop/order/guest/W1234567890/synthetic?e=false',
  '/shop/order/guest/W1234567890/synthetic?e=true&e=true',
  '/shop/order/guest/W1234567890/synthetic/extra',
  '/shop/order/print/invoice/W1234567890/synthetic',
])('拒绝错单、额外路径和非详情GET动作：%#', pathname => {
  requestUrl = 'https://secure6.www.apple.com.cn' + pathname;
  saveEvidence('GET');
  expect(() => verifyHttpEvidence(root, auditName, NOW)).toThrow('HTTP_APPLY_REQUEST_INVALID');
});

const describeDb =
  process.env.PICKUP_TEST_DB_HOST === 'official-order-rebuild-postgres' ? describe : describe.skip;
describeDb('严格HTTP状态/日期回写真正PostgreSQL事务', () => {
  let client;
  let payload;

  beforeAll(async () => {
    client = new Client({
      host: process.env.PICKUP_TEST_DB_HOST,
      user: 'postgres',
      password: 'test-only',
      database: 'postgres',
    });
    await client.connect();
    await client.query(`CREATE TEMP TABLE orders (
      id int PRIMARY KEY,order_number text,apple_id text,
      email_order_status text,email_pickup_date date,
      actual_pickup_date date,official_raw_status text,official_status_observed_at timestamptz,
      status text,updated_at timestamptz DEFAULT '2026-09-22T00:00:00Z')`);
    await client.query(
      'CREATE TEMP TABLE pickup_devices(id int PRIMARY KEY,order_id int,serial_number text)'
    );
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE orders,pickup_devices');
    await client.query(`INSERT INTO orders(id,order_number,apple_id,email_order_status,status)
      VALUES(1,'W1234567890','a@example.test','picked_up','manual')`);
    plan = await freezePickupBackfill(client, { missingFields: true });
    plan.startedAt = new Date(Date.now() - 3000).toISOString();
    audit.startedAt = (Date.now() - 2000) / 1000;
    source.observedAt = new Date(Date.now() - 1000).toISOString();
    audit.finishedAt = (Date.now() - 500) / 1000;
    saveEvidence();
    payload = verifyHttpEvidence(root, auditName);
  });

  async function dryRun(basis) {
    try {
      return await applyHttpPayload(client, payload, { mode: 'dry-run', basis });
    } catch (error) {
      error.component = 'httpApplyTest';
      throw error;
    }
  }

  async function apply(preview) {
    try {
      return await applyHttpPayload(client, payload, {
        mode: 'apply',
        basis: preview.basis,
        preview,
      });
    } catch (error) {
      error.component = 'httpApplyTest';
      throw error;
    }
  }

  test('dry-run只读不改行；保存preview后只更新官网字段与空日期', async () => {
    const before = (await client.query('SELECT to_jsonb(o) AS row FROM orders o')).rows[0].row;
    const preview = await dryRun();
    expect(preview).toMatchObject({
      mode: 'dry-run',
      businessWrites: 0,
      dateAction: 'FILL_DATE',
      statusAction: 'UPDATE_STATUS',
    });
    expect((await client.query('SELECT to_jsonb(o) AS row FROM orders o')).rows[0].row).toEqual(
      before
    );
    const result = await apply(preview);
    expect(result).toMatchObject({ statusSaved: true, dateFilled: true, businessWrites: 1 });
    const after = (await client.query('SELECT to_jsonb(o) AS row FROM orders o')).rows[0].row;
    expect(after.actual_pickup_date).toBe('2026-09-22');
    expect(after.status).toBe(before.status);
    expect(after.updated_at).toBe(before.updated_at);
    expect(
      (await client.query('SELECT count(*)::int AS count FROM pickup_devices')).rows[0].count
    ).toBe(0);
  });

  test('冻结后新增人工日期仍保留，官网日期不得覆盖', async () => {
    await client.query("UPDATE orders SET actual_pickup_date='2026-09-21'");
    const preview = await dryRun();
    expect(preview.dateAction).toBe('KEEP_EXISTING_DATE');
    expect((await apply(preview)).dateFilled).toBe(false);
    expect(
      (await client.query('SELECT actual_pickup_date::text AS date FROM orders')).rows[0].date
    ).toBe('2026-09-21');
  });

  test('同一run凭basis安全幂等；不会重吸收已改业务字段', async () => {
    const first = await dryRun();
    await apply(first);
    const second = await dryRun(first.basis);
    expect((await apply(second)).businessWrites).toBe(0);
    await client.query("UPDATE orders SET status='changed'");
    await expect(dryRun(first.basis)).rejects.toThrow('HTTP_APPLY_ORDER_CHANGED');
  });

  test.each([
    "actual_pickup_date='2026-09-20'",
    "official_raw_status='MANUAL'",
    'official_status_observed_at=now()',
    "status='changed'",
  ])('preview后并发修改%s阻止回写', async change => {
    const preview = await dryRun();
    await client.query(`UPDATE orders SET ${change}`);
    await expect(apply(preview)).rejects.toThrow('HTTP_APPLY_ORDER_CHANGED');
  });

  test('preview后设备绑定改变阻止回写，序列号不被本入口改写', async () => {
    const preview = await dryRun();
    await client.query("INSERT INTO pickup_devices VALUES(1,1,'A123456789')");
    await expect(apply(preview)).rejects.toThrow('HTTP_APPLY_ORDER_CHANGED');
    expect(
      (await client.query('SELECT official_raw_status AS status FROM orders')).rows[0].status
    ).toBeNull();
  });

  test('新官网观测已存在时只保留，不反向刷新状态或补旧日期', async () => {
    const original = await dryRun();
    await client.query(
      "UPDATE orders SET official_raw_status='NEWER',official_status_observed_at=now()"
    );
    const preview = await dryRun(original.basis);
    expect(preview.statusAction).toBe('KEEP_NEWER_STATUS');
    expect((await apply(preview)).businessWrites).toBe(0);
    const row = (
      await client.query(
        'SELECT actual_pickup_date AS date,official_raw_status AS status FROM orders'
      )
    ).rows[0];
    expect(row).toEqual({ date: null, status: 'NEWER' });
  });

  test('无preview/伪造snapshot/其他run basis一律拒绝', async () => {
    await expect(applyHttpPayload(client, payload, { mode: 'apply' })).rejects.toThrow(
      'HTTP_APPLY_PREVIEW_REQUIRED'
    );
    const preview = await dryRun();
    preview.snapshot.order.status = 'invented';
    await expect(apply(preview)).rejects.toThrow('HTTP_APPLY_ORDER_CHANGED');
    await expect(dryRun({ ...preview.basis, runId: 99 })).rejects.toThrow(
      'HTTP_APPLY_BASIS_INVALID'
    );
  });

  test('过期payload在DB操作前拒绝，不用原observed当now', async () => {
    payload.result.source.observedAt = new Date(Date.now() - 300001).toISOString();
    await expect(dryRun()).rejects.toThrow('HTTP_APPLY_SOURCE_INVALID');
  });
});
