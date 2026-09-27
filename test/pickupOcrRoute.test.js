jest.mock('../src/models', () => ({ Order: { findOne: jest.fn() } }));
jest.mock('../src/services/orderAccessService', () => ({
  scopeOrderWhere: (_user, where) => where,
}));
jest.mock('../src/services/pickupOcrService', () => ({ recognize: jest.fn() }));
jest.mock(
  '../src/controllers/pickupController',
  () => new Proxy({}, { get: () => (_req, res) => res.end() })
);
jest.mock(
  '../src/controllers/pickupDeviceController',
  () => new Proxy({}, { get: () => (_req, res) => res.end() })
);
const express = require('express');
const { Order } = require('../src/models');
const service = require('../src/services/pickupOcrService');
let server;
let base;
let sequence = 0;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      id: ++sequence,
      role: 'pickupStaff',
      permissions:
        req.headers['x-permission'] === 'read'
          ? ['pickups.read']
          : ['pickups.read', 'pickups.edit'],
    };
    next();
  });
  app.use('/pickups', require('../src/routes/pickups'));
  app.use(require('../src/middleware/errorHandler'));
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  jest.clearAllMocks();
  Order.findOne.mockResolvedValue({ id: 1 });
  service.recognize.mockResolvedValue({
    candidates: ['TEST000001'],
    provider: 'aliyun',
    requestId: 'synthetic',
  });
});
async function upload({ role = 'write', orderId = '1', extra = false } = {}) {
  try {
    const form = new FormData();
    form.append(
      'image',
      new Blob([Buffer.from([255, 216, 255, 0])], { type: 'image/jpeg' }),
      'test.jpg'
    );
    if (extra) form.append('url', 'https://example.test/image');
    return await fetch(`${base}/pickups/${orderId}/devices/ocr`, {
      method: 'POST',
      headers: { 'x-permission': role },
      body: form,
    });
  } catch (error) {
    throw new Error('OCR 测试请求失败', { cause: error });
  }
}
test('合法单图片请求只返回候选并禁止缓存', async () => {
  const response = await upload();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json()).data.candidates).toEqual(['TEST000001']);
  expect(service.recognize).toHaveBeenCalledTimes(1);
});
test('只读角色不能识别，不查订单或调用 OCR', async () => {
  expect((await upload({ role: 'read' })).status).toBe(403);
  expect(Order.findOne).not.toHaveBeenCalled();
  expect(service.recognize).not.toHaveBeenCalled();
});
test('无订单范围权限不收费', async () => {
  Order.findOne.mockResolvedValue(null);
  expect((await upload()).status).toBe(404);
  expect(service.recognize).not.toHaveBeenCalled();
});
test('无效 ID 及额外 URL 字段拒绝', async () => {
  expect((await upload({ orderId: 'bad' })).status).toBe(400);
  expect((await upload({ extra: true })).status).toBe(400);
  expect(service.recognize).not.toHaveBeenCalled();
});
