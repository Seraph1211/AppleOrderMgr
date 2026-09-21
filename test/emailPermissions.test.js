jest.mock('../src/models', () => ({ User: {} }));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/controllers/emailProcessingController', () =>
  Object.fromEntries(
    [
      'listRecords',
      'getMetrics',
      'batchReparse',
      'getRecord',
      'reparseRecord',
      'saveDraft',
      'ingestRecord',
      'resolveRecord',
    ].map(name => [name, jest.fn((_req, res) => res.json({ action: name }))])
  )
);

const express = require('express');
const { getPermissionCatalog } = require('../src/constants/permissionCatalog');
const { validatePermissionSet } = require('../src/services/permissionService');
const router = require('../src/routes/emailProcessing');

const endpoints = [
  ['get', '/', 'email.read'],
  ['get', '/metrics', 'email.read'],
  ['get', '/1', 'email.content.read'],
  ['post', '/batch-reparse', 'email.process'],
  ['post', '/1/reparse', 'email.process'],
  ['put', '/1/draft', 'email.process'],
  ['post', '/1/ingest', 'email.process'],
  ['post', '/1/resolve', 'email.process'],
];

describe('邮件权限分级授权', () => {
  let server;
  let baseUrl;
  let actor;
  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = actor;
      next();
    });
    app.use(router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('邮件权限可以授予普通用户，依赖及其他管理员权限保留', () => {
    for (const code of [
      'email.read',
      'email.content.read',
      'email.process',
      'order_mail.read',
      'order_mail.forward',
    ]) {
      expect(getPermissionCatalog().find(item => item.code === code).adminReserved).toBe(false);
    }
    expect(validatePermissionSet(['email.read'])).toEqual(['email.read']);
    expect(
      validatePermissionSet(['email.read', 'email.content.read', 'email.process'])
    ).toHaveLength(3);
    expect(
      validatePermissionSet(['orders.read', 'order_mail.read', 'order_mail.forward'])
    ).toHaveLength(3);
    expect(validatePermissionSet(['orders.read', 'order_mail.manage'])).toHaveLength(2);
    for (const permissions of [
      ['email.content.read'],
      ['email.read', 'email.process'],
      ['order_mail.read'],
      ['orders.read', 'order_mail.forward'],
    ]) {
      expect(() => validatePermissionSet(permissions)).toThrow('权限依赖不完整');
    }
    expect(() => validatePermissionSet(['users.read'])).toThrow('管理员保留');
  });

  test.each(['operator', 'readOnly'])('%s 的各级权限仅开放对应邮件接口', async role => {
    for (const permissions of [
      [],
      ['email.read'],
      ['email.read', 'email.content.read'],
      ['email.read', 'email.content.read', 'email.process'],
      ['orders.read', 'order_mail.read', 'order_mail.forward'],
    ]) {
      actor = { id: 3, role, permissions };
      for (const [method, path, permission] of endpoints) {
        const response = await fetch(baseUrl + path, { method: method.toUpperCase() });
        expect(response.status).toBe(permissions.includes(permission) ? 200 : 403);
        await response.text();
      }
    }
  });

  test('未认证请求全部拒绝', async () => {
    actor = undefined;
    for (const [method, path] of endpoints) {
      const response = await fetch(baseUrl + path, { method: method.toUpperCase() });
      expect(response.status).toBe(401);
      await response.text();
    }
  });
});
