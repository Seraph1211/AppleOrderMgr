const express = require('express');
const crypto = require('crypto');
const ApiError = require('../src/utils/ApiError');
const { createRouter } = require('../src/routes/applePurchaseSyncMachine');
const { makeBatch } = require('./fixtures/applePurchaseSyncV1');

const terminalId = crypto.randomUUID();
const token = `aps_synthetic.${'A'.repeat(43)}`;
const service = {
  authenticate: jest.fn(value => {
    if (value !== token) {
      throw new ApiError(401, 'UNAUTHORIZED', '终端凭据无效');
    }
    return Promise.resolve({ id: terminalId, enabled: true });
  }),
  status: jest.fn(terminal => ({
    contractVersion: '1',
    terminalId: terminal.id,
    terminalEnabled: true,
    serverTime: '2026-11-05T08:09:12.567Z',
    maxBatchEvents: 500,
    maxBodyBytes: 1_048_576,
  })),
  ingestBatch: jest.fn(batch =>
    Promise.resolve({
      batchId: batch.batchId,
      accepted: { observations: 1, monitorChanges: 1 },
      duplicates: { observations: 0, monitorChanges: 0 },
      highWater: { observations: '1', monitorChanges: '1' },
      serverTime: '2026-11-05T08:09:12.567Z',
    })
  ),
};

let server;
let root;
async function request(path, options = {}) {
  return await fetch(`${root}${path}`, {
    ...options,
    headers: {
      'X-Request-Id': crypto.randomUUID(),
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
}

beforeAll(async () => {
  const app = express();
  app.use('/api/apple-purchase-sync/v1', createRouter(service));
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  root = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

beforeEach(() => jest.clearAllMocks());

test('status 使用机器 Token、no-store 和冻结响应字段', async () => {
  const response = await request('/api/apple-purchase-sync/v1/status');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    success: true,
    data: { contractVersion: '1', terminalId, maxBodyBytes: 1_048_576 },
  });
});

test('混合批次严格解析后交给同一事务服务', async () => {
  const batch = makeBatch({ terminalId });
  const response = await request('/api/apple-purchase-sync/v1/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(batch),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { accepted: { observations: 1, monitorChanges: 1 } },
  });
  expect(service.ingestBatch).toHaveBeenCalledWith(
    expect.objectContaining({ batchId: batch.batchId }),
    expect.objectContaining({ id: terminalId }),
    token,
    expect.any(String)
  );
});

test.each([
  ['缺少 request ID', { headers: { 'X-Request-Id': '' } }, 400],
  ['错误 Token', { headers: { Authorization: 'Bearer wrong' } }, 401],
  ['错误 Content-Type', { method: 'POST', body: '{}' }, 400],
])('%s 被拒绝', async (_label, options, status) => {
  const response = await request('/api/apple-purchase-sync/v1/batches', options);
  expect(response.status).toBe(status);
});

test('未知字段不进入服务且错误响应不回显正文', async () => {
  const batch = makeBatch({ terminalId, unexpectedSecret: 'synthetic-sensitive-marker' });
  const response = await request('/api/apple-purchase-sync/v1/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('synthetic-sensitive-marker');
  expect(service.ingestBatch).not.toHaveBeenCalled();
});
