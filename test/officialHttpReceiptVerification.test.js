/* eslint-disable no-magic-numbers -- 合成订单、时间窗口、文件权限与篡改边界。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const { OfficialOrderHttpCollector } = require('../src/services/officialOrderHttpCollector');
const {
  encrypt,
  decrypt,
  hash,
  safePath,
  writePrivate,
} = require('../src/services/officialOrderSupport');
const { verifyHttpReceipt } = require('../scripts/officialPickupBackfill/verifyHttpReceipt');

const ID = 11;
const RUN = 21;
const ORDER = 'W1234567890';
const HOST = 'secure6.www.apple.com.cn';
const TOKEN = 'synthetic-receipt-token-'.repeat(4);
const URL = `https://${HOST}/shop/order/guest/${ORDER}/${TOKEN}`;
const RECEIPT_URL = `https://${HOST}/shop/order/print/invoice/syntheticInvoice/${TOKEN}`;
const AUDIT_FILE = `http-sample-${ID}-${'a'.repeat(32)}.json`;
const RESULT_FILE = `private/results/order-${ID}-run-${RUN}.json`;
const RECEIPT_FILE = `private/http-receipt-${ID}-run-${RUN}.json`;
const AUDIT_PATH = `private/${AUDIT_FILE}`;
const EVENTS_FILE = `evidence/run-${RUN}/events.jsonl`;
let root;
let key;
let plan;
let audit;
let result;
let metadata;

function receiptBody({ orderNumber = ORDER, serials = ['A123456789', 'B123456789'] } = {}) {
  return JSON.stringify({
    orderInvoices: {
      c: ['orderInvoice-1'],
      'orderInvoice-1': {
        invoiceOrderSummary: { d: { orderNumber } },
        invoiceLineItems: {
          c: ['invoiceLineItem-1'],
          'invoiceLineItem-1': {
            d: {
              hasLineItemSerialInfo: true,
              lineItemSerialInfo: serials,
              quantityOrdered: String(serials.length),
              quantityShipped: String(serials.length),
              partNumber: 'TESTCH/A',
              productName: '测试手机 256GB 蓝色',
            },
          },
        },
      },
    },
  });
}

function save(relative, value) {
  writePrivate(
    path.join(root, relative),
    typeof value === 'string' ? value : JSON.stringify(value)
  );
}

function read(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function verify(overrides = {}) {
  return verifyHttpReceipt({ root, orderId: ID, runId: RUN, auditFile: AUDIT_FILE, ...overrides });
}

function changeEncrypted(relative, change) {
  const value = JSON.parse(decrypt(fs.readFileSync(path.join(root, relative)), key));
  change(value);
  writePrivate(path.join(root, relative), encrypt(value, key));
}

function events() {
  return fs.readFileSync(path.join(root, EVENTS_FILE), 'utf8').trim().split('\n').map(JSON.parse);
}

function saveEvents(value) {
  save(EVENTS_FILE, `${value.map(item => JSON.stringify(item)).join('\n')}\n`);
}

function replaceReceiptBody(body) {
  const oldSource = metadata.source;
  const sha256 = hash(Buffer.from(body));
  const file = `body-2-${sha256.slice(0, 16)}.enc`;
  writePrivate(path.join(root, `evidence/run-${RUN}/${file}`), encrypt(Buffer.from(body), key));
  changeEncrypted(`evidence/run-${RUN}/response-2.enc`, value => {
    value.bodyBase64 = Buffer.from(body).toString('base64');
  });
  metadata.source = { ...oldSource, sha256, file };
  save(RECEIPT_FILE, metadata);
  saveEvents(
    events().map(event =>
      event.file === oldSource.file
        ? { ...event, ...metadata.source, bytes: Buffer.byteLength(body) }
        : event
    )
  );
}

function changeDetailRequest(url, method = 'GET', body = null) {
  result.source.path = safePath(new global.URL(url).pathname);
  result.source.urlHash = hash(url);
  save(RESULT_FILE, result);
  changeEncrypted(`evidence/run-${RUN}/response-1.enc`, value => {
    value.url = url;
  });
  changeEncrypted(`evidence/run-${RUN}/request-1.enc`, value => {
    Object.assign(value, { url, method, body });
  });
  saveEvents(
    events().map(event =>
      event.file === result.source.file ? { ...event, ...result.source, method } : event
    )
  );
}

function treeSnapshot(directory = root) {
  const files = {};
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) Object.assign(files, treeSnapshot(file));
    else files[path.relative(root, file)] = hash(fs.readFileSync(file));
  }
  return files;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-receipt-verification-'));
  key = crypto.randomBytes(32);
  writePrivate(path.join(root, 'private/evidence.key'), key);
  plan = {
    schemaVersion: 3,
    scope: 'missing-fields',
    cutoff: null,
    startedAt: new Date(Date.now() - 60000).toISOString(),
    policy: { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 },
    entries: [
      {
        id: ID,
        orderNumber: ORDER,
        accountKey: 'b'.repeat(32),
        rowHash: 'c'.repeat(32),
        dateMissing: true,
        serialsMissing: true,
        previousDate: null,
        previousDevices: [],
      },
    ],
  };
  save('private/plan.json', plan);
  const model = buildLifecycleJson('PICKED_UP');
  model.orderDetail.orderHeader.d.invoiceUrl = RECEIPT_URL;
  const item = model.orderDetail.orderItems[model.orderDetail.orderItems.c[0]];
  item.orderItemDetails.d.quantity = 2;
  const responses = [JSON.stringify(model), receiptBody()];
  const startedAt = Date.now() / 1000;
  const transport = {
    request: jest.fn(input =>
      Promise.resolve({
        url: input.url,
        status: 200,
        bodyBase64: Buffer.from(responses.shift()).toString('base64'),
        headers: { 'content-type': 'text/html; charset=utf-8' },
        rawHeaders: [['content-type', 'text/html; charset=utf-8']],
        cookies: [],
      })
    ),
  };
  const collector = new OfficialOrderHttpCollector({
    transport,
    sample: { id: ID, orderNumber: ORDER, url: URL },
    root,
    key,
    runId: RUN,
  });
  expect(await collector.collect()).toMatchObject({
    outcome: 'SUCCEEDED',
    receiptOutcome: 'RECEIPT_VERIFIED',
  });
  audit = {
    attemptId: 'a'.repeat(32),
    targetOrderId: ID,
    orderId: ID,
    runId: RUN,
    outcome: 'SUCCEEDED',
    receiptOutcome: 'RECEIPT_VERIFIED',
    resultFile: `/research/${RESULT_FILE}`,
    startedAt,
    finishedAt: Date.now() / 1000,
    egressHash: 'd'.repeat(64),
    egressAfterHash: 'd'.repeat(64),
    egressVerifiedAfter: true,
    businessWrites: 0,
    cleanup: { removed: true },
  };
  save(AUDIT_PATH, audit);
  result = read(RESULT_FILE);
  metadata = read(RECEIPT_FILE);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('真实采集器合成产物通过独立核验，生成原 bindReceipt 输入且零文件写入', () => {
  const before = treeSnapshot();
  const payload = verify();
  expect(payload).toMatchObject({
    startedAt: plan.startedAt,
    cutoff: null,
    scope: 'missing-fields',
    schemaVersion: 3,
    entry: plan.entries[0],
    receipt: {
      systemOrderId: ID,
      orderNumber: ORDER,
      runId: RUN,
      detailRun: RUN,
      status: 200,
      detailSha256: result.source.sha256,
      sha256: metadata.source.sha256,
      urlHash: hash(RECEIPT_URL),
      transport: 'same-http-session',
      egressVerifiedAfter: true,
      egressHash: 'd'.repeat(64),
      auditFile: AUDIT_FILE,
      auditSha256: hash(fs.readFileSync(path.join(root, AUDIT_PATH))),
    },
    parsed: {
      orderNumber: ORDER,
      items: [{ serialNumber: 'A123456789' }, { serialNumber: 'B123456789' }],
    },
  });
  expect(metadata.egressVerifiedAfter).toBe(false);
  expect(treeSnapshot()).toEqual(before);
});

test('状态同步后采用经过原计划严格对照的 stableRowHash，不重定义范围', () => {
  const derived = {
    ...plan,
    statusSync: true,
    entries: plan.entries.map(entry => ({ ...entry, stableRowHash: 'e'.repeat(32) })),
  };
  save('private/status-plan.json', derived);
  expect(verify().entry.stableRowHash).toBe('e'.repeat(32));
  expect(verify().entry.rowHash).toBe(plan.entries[0].rowHash);
});

function bindingBasis() {
  return {
    version: 1,
    planSha256: hash(fs.readFileSync(path.join(root, 'private/plan.json'))),
    orderId: ID,
    originalRowHash: plan.entries[0].rowHash,
    stableRowHash: 'e'.repeat(32),
    runId: RUN,
    auditSha256: hash(fs.readFileSync(path.join(root, AUDIT_PATH))),
  };
}

test.each([false, true])('单订单冻结 basis 兼容裸对象及完整 dry-run preview %s', wrapped => {
  const basis = bindingBasis();
  const basisFile = 'http-status-preview.json';
  save(`private/${basisFile}`, wrapped ? { version: 1, mode: 'dry-run', basis } : basis);
  const before = treeSnapshot();
  const payload = verify({ basisFile });
  expect(payload.entry).toEqual({ ...plan.entries[0], stableRowHash: basis.stableRowHash });
  expect(payload.receipt).toMatchObject({
    basisFile,
    basisSha256: hash(fs.readFileSync(path.join(root, `private/${basisFile}`))),
  });
  expect(treeSnapshot()).toEqual(before);
});

test.each([
  value => {
    value.version = 2;
  },
  value => {
    value.planSha256 = 'f'.repeat(64);
  },
  value => {
    value.orderId += 1;
  },
  value => {
    value.originalRowHash = 'f'.repeat(32);
  },
  value => {
    value.stableRowHash = 'invalid';
  },
  value => {
    value.runId += 1;
  },
  value => {
    value.auditSha256 = 'f'.repeat(64);
  },
  value => {
    delete value.runId;
  },
  value => {
    value.statusSync = true;
  },
])('其他计划、订单、运行、审计或不完整 basis 被拒绝 %#', change => {
  const basis = bindingBasis();
  change(basis);
  save('private/http-status-preview.json', { basis });
  expect(() => verify({ basisFile: 'http-status-preview.json' })).toThrow(
    'HTTP_RECEIPT_BASIS_INVALID'
  );
});

test.each(['../http-status-preview.json', '/tmp/http-status-preview.json', '', null])(
  'basis 必须为明确私密目录文件名 %s',
  basisFile => {
    expect(() => verify({ basisFile })).toThrow('HTTP_RECEIPT_BASIS_INVALID');
  }
);

test('basis 与既存派生计划不同不能覆盖 stableRowHash', () => {
  save('private/status-plan.json', {
    ...plan,
    statusSync: true,
    entries: plan.entries.map(entry => ({ ...entry, stableRowHash: 'f'.repeat(32) })),
  });
  save('private/http-status-preview.json', bindingBasis());
  expect(() => verify({ basisFile: 'http-status-preview.json' })).toThrow(
    'HTTP_RECEIPT_BASIS_INVALID'
  );
});

test.each([
  value => {
    value.cutoff = '2026-09-23';
  },
  value => {
    value.statusSync = false;
  },
  value => {
    value.entries[0].dateMissing = false;
  },
  value => {
    value.entries[0].id = 12;
  },
  value => {
    value.entries[0].stableRowHash = 'invalid';
  },
  value => {
    value.entries.push({ ...value.entries[0] });
  },
  value => {
    value.extraScope = 'all';
  },
])('派生状态计划任何非允许差异都会拒绝 %#', change => {
  const derived = {
    ...plan,
    statusSync: true,
    entries: plan.entries.map(entry => ({ ...entry, stableRowHash: 'e'.repeat(32) })),
  };
  change(derived);
  save('private/status-plan.json', derived);
  expect(() => verify()).toThrow('HTTP_RECEIPT_STATUS_PLAN_INVALID');
});

test.each([
  { scope: 'all-picked-up', schemaVersion: 2 },
  { cutoff: '2026-09-23' },
  { startedAt: 'invalid' },
  { startedAt: new Date(Date.now() + 86400000).toISOString() },
  { startedAt: new Date(Date.now() - 172800000).toISOString() },
  { policy: { loginCooldown: true, apiHealthCheck: false, proxy541Limit: 3 } },
  { entries: [] },
])('旧范围、过期或缺失冻结计划不能绑定 %#', overrides => {
  save('private/plan.json', { ...plan, ...overrides });
  expect(() => verify()).toThrow('HTTP_RECEIPT_SCOPE_INVALID');
});

test('计划必须唯一包含该订单且仍有缺失字段基线', () => {
  plan.entries.push({ ...plan.entries[0] });
  save('private/plan.json', plan);
  expect(() => verify()).toThrow('HTTP_RECEIPT_SCOPE_INVALID');
  plan.entries.pop();
  Object.assign(plan.entries[0], { dateMissing: false, serialsMissing: false });
  save('private/plan.json', plan);
  expect(() => verify()).toThrow('HTTP_RECEIPT_SCOPE_INVALID');
});

test.each([
  { outcome: 'EGRESS_CHANGED_OR_UNVERIFIED' },
  { receiptOutcome: 'RECEIPT_LINK_MISSING' },
  { egressAfterHash: undefined },
  { egressAfterHash: 'f'.repeat(64) },
  { egressVerifiedAfter: false },
  { egressHash: 'not-hash', egressAfterHash: 'not-hash' },
  { orderId: 12 },
  { targetOrderId: 12 },
  { runId: 22 },
  { attemptId: 'b'.repeat(32) },
  { resultFile: '/research/private/results/order-12-run-21.json' },
  { finishedAt: undefined },
  { finishedAt: '2000000000' },
  { finishedAt: 0 },
  { businessWrites: 1 },
  { cleanup: { removed: false } },
])('前后出口、完成状态、身份或审计绑定不符即拒绝 %#', overrides => {
  save(AUDIT_PATH, { ...audit, ...overrides });
  expect(() => verify()).toThrow('HTTP_RECEIPT_AUDIT_INVALID');
});

test('不能用只带旧 egressVerifiedAfter 布尔的历史记录补造新审计', () => {
  delete audit.egressAfterHash;
  delete audit.finishedAt;
  save(AUDIT_PATH, audit);
  metadata.egressVerifiedAfter = true;
  save(RECEIPT_FILE, metadata);
  expect(() => verify()).toThrow('HTTP_RECEIPT_AUDIT_INVALID');
});

test.each([
  { auditFile: '../plan.json' },
  { auditFile: `http-sample-12-${'a'.repeat(32)}.json` },
  { auditFile: 'http-sample-11-1234567890.json' },
  { orderId: 0 },
  { runId: -1 },
  { root: '.' },
])('入口拒绝路径穿越和非法标识 %#', overrides => {
  expect(() => verify(overrides)).toThrow(/^HTTP_RECEIPT_/);
});

test.each([
  { systemOrderId: 12 },
  { detailRun: 22 },
  { detailSha256: 'a'.repeat(64) },
  { urlHash: 'invalid' },
])('收据元数据跨订单、跨运行或错摘要失败 %#', overrides => {
  save(RECEIPT_FILE, { ...metadata, ...overrides });
  expect(() => verify()).toThrow('HTTP_RECEIPT_METADATA_INVALID');
});

test('详情和收据源都必须属于当前 run', () => {
  metadata.source.runId = 22;
  save(RECEIPT_FILE, metadata);
  expect(() => verify()).toThrow('HTTP_RECEIPT_SOURCE_INVALID');
});

test('明文缓存 parsed 不能覆盖原文重新计算的完整序列号', () => {
  metadata.parsed.items[0].serialNumber = 'Z999999999';
  save(RECEIPT_FILE, metadata);
  expect(() => verify()).toThrow('HTTP_RECEIPT_PARSED_MISMATCH');
});

test('保存的详情商品、数量和身份标志必须与原文一致', () => {
  result.products[0].quantity = 1;
  save(RESULT_FILE, result);
  expect(() => verify()).toThrow('HTTP_RECEIPT_DETAIL_INVALID');
});

test('支持真实 fetchOrder POST 详情，包括官网下发的可选 e=true', () => {
  const url = `https://${HOST}/shop/orderx/guestx/${ORDER}/${TOKEN}?_a=fetchOrder&_m=guestOrderSpinner&e=true`;
  changeDetailRequest(url, 'POST', '');
  expect(verify().receipt.orderNumber).toBe(ORDER);
  changeEncrypted(`evidence/run-${RUN}/request-1.enc`, value => {
    value.body = 'unexpected=1';
  });
  expect(() => verify()).toThrow('HTTP_RECEIPT_DETAIL_REQUEST_INVALID');
});

test('POST 动作中的订单号必须精确匹配，其他位置包含目标订单不能替代', () => {
  const url = `https://${HOST}/shop/orderx/guestx/W9999999999/${ORDER}?_a=fetchOrder&_m=guestOrderSpinner`;
  changeDetailRequest(url, 'POST', '');
  expect(() => verify()).toThrow('HTTP_RECEIPT_DETAIL_REQUEST_INVALID');
});

test('GET URL 中仅令牌位置包含目标订单也拒绝', () => {
  const url = `https://${HOST}/shop/order/guest/W9999999999/${ORDER}`;
  changeDetailRequest(url);
  expect(() => verify()).toThrow('HTTP_RECEIPT_DETAIL_REQUEST_INVALID');
});

test.each([
  [{ serials: ['A123456789'] }, 'RECEIPT_QUANTITY_MISMATCH'],
  [{ orderNumber: 'W9999999999' }, 'RECEIPT_ORDER_MISMATCH'],
  [{ serials: ['A123456789', 'A123456789'] }, 'RECEIPT_SERIAL_INVALID'],
])('即使元数据、响应和摘要自洽，原文不满足身份/全量数量仍拒绝 %#', (options, code) => {
  replaceReceiptBody(receiptBody(options));
  expect(() => verify()).toThrow(code);
});

test.each(['<html>登录页</html>', '%PDF synthetic', '<p>Serial No A123456789</p>'])(
  '弱字符串和非结构化页面不能成为收据 %#',
  body => {
    replaceReceiptBody(body);
    expect(() => verify()).toThrow('RECEIPT_MODEL_AMBIGUOUS');
  }
);

test.each([
  value => {
    value.status = 302;
  },
  value => {
    value.url = RECEIPT_URL.replace('syntheticInvoice', 'otherInvoice');
  },
  value => {
    value.headers['content-type'] = 'application/pdf';
  },
  value => {
    value.bodyBase64 = Buffer.from('different body').toString('base64');
  },
])('加密响应状态、URL、类型或正文不符仍拒绝 %#', change => {
  changeEncrypted(`evidence/run-${RUN}/response-2.enc`, change);
  expect(() => verify()).toThrow('HTTP_RECEIPT_EVIDENCE_MISMATCH');
});

test('收据链接必须来自同一详情，不能换成同主机另一电子收据', () => {
  const alternate = RECEIPT_URL.replace('syntheticInvoice', 'otherInvoice');
  metadata.urlHash = hash(alternate);
  metadata.source.urlHash = hash(alternate);
  save(RECEIPT_FILE, metadata);
  changeEncrypted(`evidence/run-${RUN}/response-2.enc`, value => {
    value.url = alternate;
  });
  changeEncrypted(`evidence/run-${RUN}/request-2.enc`, value => {
    value.url = alternate;
  });
  saveEvents(
    events().map(event =>
      event.file === metadata.source.file ? { ...event, urlHash: hash(alternate) } : event
    )
  );
  expect(() => verify()).toThrow('HTTP_RECEIPT_BINDING_INVALID');
});

test('收据不是只读 GET 时拒绝，即使 URL 与订单相同', () => {
  changeEncrypted(`evidence/run-${RUN}/request-2.enc`, value => {
    value.method = 'POST';
  });
  saveEvents(
    events().map(event =>
      event.file === metadata.source.file ? { ...event, method: 'POST' } : event
    )
  );
  expect(() => verify()).toThrow('READ_DESTINATION_DENIED');
});

test('篡改密文认证标签或主体不能解密', () => {
  const file = path.join(root, `evidence/run-${RUN}/${metadata.source.file}`);
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  expect(() => verify()).toThrow('ENCRYPTED_STATE_INVALID');
});

test('重复来源台账以及台账缺失不构成完整证据链', () => {
  const records = events();
  saveEvents([...records, records[1]]);
  expect(() => verify()).toThrow('HTTP_RECEIPT_EVIDENCE_MISMATCH');
  saveEvents([records[0]]);
  expect(() => verify()).toThrow('HTTP_RECEIPT_EVIDENCE_MISMATCH');
});

test('只接受五分钟内观测，且必须落在同一次 sampler 窗口', () => {
  expect(() => verify({ now: Date.now() + 301000 })).toThrow('HTTP_RECEIPT_SOURCE_INVALID');
  audit.startedAt += 10;
  audit.finishedAt += 10;
  save(AUDIT_PATH, audit);
  expect(() => verify({ now: Date.now() + 11000 })).toThrow('HTTP_RECEIPT_SOURCE_INVALID');
});

test('私密文件权限和符号链接失守时停止读取', () => {
  const file = path.join(root, RECEIPT_FILE);
  fs.chmodSync(file, 0o644);
  expect(() => verify()).toThrow('HTTP_RECEIPT_FILE_INVALID');
  fs.chmodSync(file, 0o600);
  fs.renameSync(file, `${file}.original`);
  fs.symlinkSync(`${file}.original`, file);
  expect(() => verify()).toThrow('HTTP_RECEIPT_FILE_INVALID');
});

test('CLI 成功只输出受控载荷，非法参数只有固定错误且不输出 SN', () => {
  const script = path.join(__dirname, '../scripts/officialPickupBackfill/verifyHttpReceipt.js');
  const success = spawnSync(process.execPath, [script, root, String(ID), String(RUN), AUDIT_FILE], {
    encoding: 'utf8',
  });
  expect(success.status).toBe(0);
  expect(JSON.parse(success.stdout).parsed.items).toHaveLength(2);
  expect(success.stderr).toBe('');
  const failure = spawnSync(process.execPath, [script, root, '0', String(RUN), AUDIT_FILE], {
    encoding: 'utf8',
  });
  expect(failure.status).toBe(1);
  expect(failure.stdout).toBe('');
  expect(failure.stderr).toBe('HTTP_RECEIPT_INPUT_INVALID');
});
