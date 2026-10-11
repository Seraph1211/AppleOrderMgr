jest.mock('../src/controllers/pickupController', () => ({
  list: jest.fn((_req, res) => res.json({ operation: 'photos' })),
  readEvidence: jest.fn((_req, res) => res.json({ operation: 'evidence' })),
}));
jest.mock('../src/controllers/pickupDeviceController', () => ({
  list: jest.fn((_req, res) => res.json({ operation: 'devices' })),
  create: jest.fn((_req, res) => res.json({ operation: 'bind' })),
  remove: jest.fn((_req, res) => res.json({ operation: 'unbind' })),
}));
jest.mock('../src/controllers/pickupOcrController', () => ({
  authorize: jest.fn((_req, _res, next) => next()),
  recognize: jest.fn((_req, res) => res.json({ operation: 'ocr' })),
}));
const express = require('express');
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      id: 1,
      role: req.headers['x-role'] || 'pickupStaff',
      permissions: (req.headers['x-permissions'] || '').split(','),
    };
    next();
  });
  app.use('/api/pickups', require('../src/routes/pickups'));
  app.use(require('../src/middleware/errorHandler'));
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/pickups`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

test.each([
  ['GET', '/filter-options'],
  ['GET', '/export'],
  ['PUT', '/123'],
  ['GET', '/123/events'],
  ['POST', '/123/evidence/prepare'],
  ['POST', '/123/evidence/confirm'],
])('退役专用接口即使管理员请求也不再执行：%s %s', async (method, path) => {
  const result = await fetch(`${base}${path}`, { method, headers: { 'x-role': 'admin' } });
  expect(result.status).toBe(404);
});

test.each([
  ['GET', '', 'photos'],
  ['GET', '/123/evidence/example', 'evidence'],
  ['GET', '/123/devices', 'devices'],
])('共用读取保留且无权限时拒绝：%s %s', async (method, path, operation) => {
  const denied = await fetch(`${base}${path}`, { method });
  expect(denied.status).toBe(403);
  const allowed = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-permissions': 'pickups.read' },
  });
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ operation });
});

test.each([
  ['POST', '/123/devices', 'bind'],
  ['DELETE', '/123/devices/example', 'unbind'],
])('共用设备写入仍需完整权限：%s %s', async (method, path, operation) => {
  for (const permissions of ['stock.read', 'pickups.read', 'pickups.edit']) {
    const denied = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-permissions': permissions },
    });
    expect(denied.status).toBe(403);
  }
  const allowed = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-permissions': 'pickups.read,pickups.edit' },
  });
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ operation });
});
