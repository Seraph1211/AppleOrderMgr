const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  batchError,
  validateBatchConfig,
  readPrivateFile,
} = require('../src/services/crawler/browserBatch/batchConfig');
const { openBatchCheckpoint } = require('../src/services/crawler/browserBatch/batchCheckpoint');
const { runBrowserBatch } = require('../src/services/crawler/browserBatch/batchRunner');
const { createBatchApi } = require('../src/services/crawler/browserBatch/batchApi');

const tick = () => new Promise(resolve => setImmediate(resolve));
const proxies = Array.from({ length: 12 }, (_, index) => `socks5://127.0.0.1:${20000 + index}`);
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-batch-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
function configFor(orderIds = [1], changes = {}) {
  return validateBatchConfig({
    apiBaseUrl: 'http://127.0.0.1:3000',
    tokenFile: path.join(dir, 'token'),
    checkpointFile: path.join(dir, 'state.json'),
    orderIds,
    proxies,
    ...changes,
  });
}
function apiFor() {
  return {
    start: jest.fn(id => Promise.resolve({ ticket: `ticket-${id}`, id })),
    permit: jest.fn(() => Promise.resolve()),
    submit: jest.fn(id => Promise.resolve({ success: true, orderId: id })),
  };
}

test.each([
  { concurrency: 11 },
  { concurrency: 0 },
  { orderIds: [1, 1] },
  { orderIds: [0] },
  { orderIds: ['1'] },
  { orderIds: [] },
  { orderIds: Array.from({ length: 1001 }, (_, i) => i + 1) },
  { proxies: proxies.slice(0, 9) },
  { proxies: [...proxies, proxies[0]] },
  { apiBaseUrl: 'http://production.example.com' },
  { apiBaseUrl: 'https://u:p@example.com' },
  { apiBaseUrl: 'https://example.com/?token=secret' },
  { apiBaseUrl: 'file:///tmp/a' },
  { tokenFile: 'relative' },
  { unknown: 1 },
  { headless: 'true' },
  { proxies: proxies.map(value => value.replace('socks5:', 'http:')) },
])('拒绝危险或超范围配置 %j', changes => {
  expect(() => configFor([1], changes)).toThrow();
});

test('默认十并发及 API 规范化，拒绝代理认证信息与规范化重复节点', () => {
  expect(configFor()).toMatchObject({ concurrency: 10, apiBaseUrl: 'http://127.0.0.1:3000/api' });
  expect(() => configFor([1], { proxies: [...proxies, 'socks5://user:secret@host:1080'] })).toThrow(
    'INVALID_PROXY'
  );
  expect(() => configFor([1], { proxies: [...proxies, '127.0.0.1:20000'] })).toThrow(
    'DUPLICATE_PROXY'
  );
});

test('私密文件拒绝宽权限与符号链接', () => {
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, 'secret', { mode: 0o644 });
  expect(() => readPrivateFile(file)).toThrow('PRIVATE_FILE_REQUIRED');
  fs.chmodSync(file, 0o600);
  expect(readPrivateFile(file)).toBe('secret');
  fs.symlinkSync(file, path.join(dir, 'link'));
  expect(() => readPrivateFile(path.join(dir, 'link'))).toThrow();
});

test('二十三笔任务实际峰值十并发、节点独占且所有任务完成', async () => {
  const config = configFor(Array.from({ length: 23 }, (_, i) => i + 1));
  const checkpoint = openBatchCheckpoint(config);
  const busy = new Set();
  let peak = 0;
  const api = apiFor();
  try {
    const summary = await runBrowserBatch({
      config,
      checkpoint,
      api,
      collect: async ({ proxy, task }) => {
        try {
          expect(busy.has(proxy)).toBe(false);
          busy.add(proxy);
          peak = Math.max(peak, busy.size);
          await tick();
          return { id: task.id };
        } finally {
          busy.delete(proxy);
        }
      },
    });
    expect(peak).toBe(10);
    expect(summary).toMatchObject({ counts: { succeeded: 23 }, fatalCode: null });
    expect(api.submit).toHaveBeenCalledTimes(23);
    expect(checkpoint.orders.every(row => row.attempts === 1)).toBe(true);
    const persisted = fs.readFileSync(config.checkpointFile, 'utf8');
    expect(persisted).not.toMatch(/ticket-|socks5|127\.0\.0\.1|Bearer/);
    expect(fs.statSync(config.checkpointFile).mode & 0o077).toBe(0);
  } finally {
    checkpoint.close();
  }
});

test('541 轮换代理、每单总共最多三次、失败不提交', async () => {
  const config = configFor([1, 2, 3], { concurrency: 3 });
  const checkpoint = openBatchCheckpoint(config);
  const seen = new Map();
  const api = apiFor();
  try {
    const summary = await runBrowserBatch({
      config,
      checkpoint,
      api,
      collect: jest.fn(({ task, proxy }) => {
        const list = seen.get(task.id) || [];
        expect(list.at(-1)).not.toBe(proxy);
        list.push(proxy);
        seen.set(task.id, list);
        return Promise.reject(batchError('APPLE_THROTTLED'));
      }),
    });
    expect(summary.counts).toEqual({ failed: 3 });
    expect([...seen.values()].map(list => list.length)).toEqual([3, 3, 3]);
    expect(new Set([...seen.values()].flat()).size).toBe(9);
    expect(api.submit).not.toHaveBeenCalled();
  } finally {
    checkpoint.close();
  }
});

test('单节点无法轮换时有界终止，不死锁也不复用旧代理', async () => {
  const config = configFor([1], { concurrency: 1, proxies: [proxies[0]] });
  const checkpoint = openBatchCheckpoint(config);
  try {
    await runBrowserBatch({
      config,
      checkpoint,
      api: apiFor(),
      collect: () => Promise.reject(batchError('NETWORK_FAILED')),
    });
    expect(checkpoint.orders[0]).toMatchObject({
      attempts: 1,
      status: 'failed',
      code: 'NO_ALTERNATE_PROXY',
    });
  } finally {
    checkpoint.close();
  }
});

test('十个槽位同时失败时释放后轮换，无额外备用节点也不死锁', async () => {
  const config = configFor(
    Array.from({ length: 10 }, (_, i) => i + 1),
    {
      proxies: proxies.slice(0, 10),
    }
  );
  const checkpoint = openBatchCheckpoint(config);
  const attempts = new Map();
  const leases = new Set();
  try {
    const summary = await runBrowserBatch({
      config,
      checkpoint,
      api: apiFor(),
      collect: async ({ task, proxy }) => {
        try {
          expect(leases.has(proxy)).toBe(false);
          leases.add(proxy);
          await tick();
          if (!attempts.has(task.id)) {
            attempts.set(task.id, proxy);
            throw batchError('APPLE_THROTTLED');
          }
          expect(proxy).not.toBe(attempts.get(task.id));
          return {};
        } finally {
          leases.delete(proxy);
        }
      },
    });
    expect(summary.counts).toEqual({ succeeded: 10 });
    expect(checkpoint.orders.every(row => row.attempts === 2)).toBe(true);
  } finally {
    checkpoint.close();
  }
});

test('错误订单或非成功回执不能被当作写入成功，禁止自动重放', async () => {
  const config = configFor([1]);
  const checkpoint = openBatchCheckpoint(config);
  const api = apiFor();
  api.submit.mockResolvedValue({ success: true, orderId: 999 });
  try {
    await runBrowserBatch({ config, checkpoint, api, collect: () => Promise.resolve({}) });
    expect(checkpoint.orders[0]).toMatchObject({
      attempts: 1,
      status: 'needs_review',
      code: 'SUBMISSION_UNCERTAIN',
    });
    expect(api.submit).toHaveBeenCalledTimes(1);
  } finally {
    checkpoint.close();
  }
});

test('加载页无结构化详情和身份错误均待核对且不提交', async () => {
  const config = configFor([1, 2]);
  const checkpoint = openBatchCheckpoint(config);
  const api = apiFor();
  try {
    await runBrowserBatch({
      config,
      checkpoint,
      api,
      collect: ({ task }) =>
        Promise.reject(batchError(task.id === 1 ? 'NO_STRUCTURED_DATA' : 'COLLECTION_INVALID')),
    });
    expect(checkpoint.orders.map(row => row.status)).toEqual(['needs_review', 'needs_review']);
    expect(api.submit).not.toHaveBeenCalled();
  } finally {
    checkpoint.close();
  }
});

test('提交回执丢失只提交一次，重启跳过成功单和待核对单', async () => {
  const config = configFor([1, 2]);
  let checkpoint = openBatchCheckpoint(config);
  const api = apiFor();
  api.submit.mockImplementation(id =>
    id === 1
      ? Promise.reject(batchError('API_UNREACHABLE'))
      : Promise.resolve({ success: true, orderId: id })
  );
  try {
    await runBrowserBatch({ config, checkpoint, api, collect: () => Promise.resolve({}) });
    expect(checkpoint.orders.find(row => row.id === 1).status).toBe('needs_review');
    checkpoint.close();
    checkpoint = openBatchCheckpoint(config);
    const second = apiFor();
    await runBrowserBatch({ config, checkpoint, api: second, collect: () => Promise.resolve({}) });
    expect(second.start).not.toHaveBeenCalled();
    expect(second.submit).not.toHaveBeenCalled();
  } finally {
    checkpoint.close();
  }
});

test('暂停或权限失效停止发放后续订单，保留待跑进度', async () => {
  const config = configFor([1, 2, 3], { concurrency: 1 });
  const checkpoint = openBatchCheckpoint(config);
  const api = apiFor();
  api.start.mockRejectedValue(batchError('REFRESH_PAUSED'));
  try {
    const result = await runBrowserBatch({ config, checkpoint, api, collect: jest.fn() });
    expect(result.fatalCode).toBe('REFRESH_PAUSED');
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(checkpoint.orders.every(row => row.status === 'pending')).toBe(true);
  } finally {
    checkpoint.close();
  }
});

test('取消十个在途采集立即停止并禁止提交或继续发放', async () => {
  const config = configFor(Array.from({ length: 20 }, (_, i) => i + 1));
  const checkpoint = openBatchCheckpoint(config);
  const api = apiFor();
  const abort = new AbortController();
  let running = 0;
  try {
    const result = await runBrowserBatch({
      config,
      checkpoint,
      api,
      signal: abort.signal,
      collect: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(batchError('CANCELLED')), { once: true });
          if (++running === 10) abort.abort();
        }),
    });
    expect(result.cancelled).toBe(true);
    expect(api.start).toHaveBeenCalledTimes(10);
    expect(api.submit).not.toHaveBeenCalled();
    expect(checkpoint.orders.every(row => row.status === 'pending')).toBe(true);
  } finally {
    checkpoint.close();
  }
});

test('检查点锁排他、身份不匹配拒绝、采集中断计次及提交中断待核对', () => {
  const config = configFor([1, 2, 3]);
  let checkpoint = openBatchCheckpoint(config);
  expect(() => openBatchCheckpoint(config)).toThrow('CHECKPOINT_LOCKED');
  Object.assign(checkpoint.orders[0], { status: 'collecting', attempts: 1 });
  Object.assign(checkpoint.orders[1], { status: 'submitting', attempts: 1 });
  Object.assign(checkpoint.orders[2], { status: 'collecting', attempts: 3 });
  checkpoint.save();
  checkpoint.close();
  expect(() => openBatchCheckpoint({ ...config, orderIds: [1] })).toThrow('CHECKPOINT_MISMATCH');
  checkpoint = openBatchCheckpoint(config);
  try {
    expect(checkpoint.orders.map(row => [row.status, row.attempts])).toEqual([
      ['pending', 1],
      ['needs_review', 1],
      ['failed', 3],
    ]);
  } finally {
    checkpoint.close();
  }
});

test('提交前必须落盘，落盘失败时不写订单并终止批次', async () => {
  const config = configFor();
  const checkpoint = openBatchCheckpoint(config);
  const api = apiFor();
  const original = checkpoint.save;
  checkpoint.save = () => {
    if (checkpoint.orders[0].status === 'submitting') throw batchError('CHECKPOINT_WRITE_FAILED');
    original();
  };
  try {
    const result = await runBrowserBatch({
      config,
      checkpoint,
      api,
      collect: () => Promise.resolve({}),
    });
    expect(result.fatalCode).toBe('CHECKPOINT_WRITE_FAILED');
    expect(api.submit).not.toHaveBeenCalled();
  } finally {
    checkpoint.close();
  }
});

test('API 禁止重定向、校验许可且不回显不受信响应或凭证', async () => {
  const fetchImpl = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ success: true, data: { allowed: true } })),
  });
  const api = createBatchApi({
    apiBaseUrl: 'https://system.test/api',
    token: 'x'.repeat(32),
    fetchImpl,
  });
  await api.permit(7, 'private-ticket');
  expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  fetchImpl.mockResolvedValue({
    ok: false,
    status: 403,
    text: () => Promise.resolve(JSON.stringify({ error: { code: 'secret', message: 'private' } })),
  });
  await expect(api.start(7)).rejects.toThrow('API_AUTH_REQUIRED');
  fetchImpl.mockRejectedValue(new Error('https://secret-credentials'));
  await expect(api.submit(7, 'private-ticket', {})).rejects.toThrow('API_UNREACHABLE');
});

test('API 空许可失败关闭，预先取消的请求传播 AbortSignal', async () => {
  const fetchImpl = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve('{"success":true,"data":{}}'),
  });
  const api = createBatchApi({
    apiBaseUrl: 'https://system.test/api',
    token: 'x'.repeat(32),
    fetchImpl,
  });
  await expect(api.permit(1, 'ticket')).rejects.toThrow('PERMIT_DENIED');
  const controller = new AbortController();
  controller.abort();
  await api.start(1, controller.signal);
  expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(true);
});
