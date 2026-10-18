jest.mock('../src/models', () => ({
  UserPermission: { findAll: jest.fn() },
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/services/monitorService', () => ({
  overview: jest.fn(() => ({ devices: [] })),
}));
jest.mock('../src/services/monitorLogService', () => ({
  states: jest.fn(() => []),
}));
jest.mock('../src/services/monitorNotificationService', () => ({}));

const express = require('express');
const { UserPermission } = require('../src/models');
const { PERMISSIONS } = require('../src/constants/business');
const { getPermissionCatalog } = require('../src/constants/permissionCatalog');
const {
  getEffectivePermissions,
  resolveAvailableHome,
  validatePermissionSet,
} = require('../src/services/permissionService');

describe('完整日志独立权限', () => {
  let actor;
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = actor;
      next();
    });
    app.use('/api/server-monitor', require('../src/routes/serverMonitor'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('普通用户可单独获授并以日志页作为可用首页', () => {
    expect(
      getPermissionCatalog().find(item => item.code === PERMISSIONS.MONITOR_LOGS_READ)
    ).toMatchObject({
      label: '查看 AOS 完整运行日志',
      module: 'monitor',
      adminReserved: false,
    });
    expect(validatePermissionSet([PERMISSIONS.MONITOR_LOGS_READ])).toEqual([
      PERMISSIONS.MONITOR_LOGS_READ,
    ]);
    expect(resolveAvailableHome([PERMISSIONS.MONITOR_LOGS_READ])).toBe('/server-monitor/logs');
  });

  test('监控管理包含日志读取依赖，旧授权仍派生日志读取权限', async () => {
    expect(() => validatePermissionSet([PERMISSIONS.MONITOR_MANAGE])).toThrow('权限依赖不完整');
    expect(
      validatePermissionSet([PERMISSIONS.MONITOR_MANAGE, PERMISSIONS.MONITOR_LOGS_READ])
    ).toEqual([PERMISSIONS.MONITOR_LOGS_READ, PERMISSIONS.MONITOR_MANAGE]);
    UserPermission.findAll.mockResolvedValue([
      { permissionCode: PERMISSIONS.MONITOR_MANAGE },
    ]);
    await expect(getEffectivePermissions({ id: 7, role: 'operator' })).resolves.toEqual([
      PERMISSIONS.MONITOR_LOGS_READ,
      PERMISSIONS.MONITOR_MANAGE,
    ]);
  });

  test('日志权限不开放监控管理接口', async () => {
    actor = { id: 7, role: 'operator', permissions: [] };
    expect((await fetch(baseUrl + '/api/server-monitor/logs/states')).status).toBe(403);
    actor.permissions = [PERMISSIONS.MONITOR_LOGS_READ];
    expect((await fetch(baseUrl + '/api/server-monitor/logs/states')).status).toBe(200);
    expect((await fetch(baseUrl + '/api/server-monitor/overview')).status).toBe(403);
    actor.permissions = [PERMISSIONS.MONITOR_LOGS_READ, PERMISSIONS.MONITOR_MANAGE];
    expect((await fetch(baseUrl + '/api/server-monitor/overview')).status).toBe(200);
  });
});
