jest.mock('../src/models', () => ({ UserPermission: { findAll: jest.fn() } }));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/services/monitorService', () => ({}));
jest.mock('../src/services/monitorLogService', () => ({}));
jest.mock('../src/services/monitorNotificationService', () => ({}));
jest.mock('../src/services/aosTaskConfigService', () =>
  Object.fromEntries(
    [
      'list',
      'detail',
      'versions',
      'version',
      'preview',
      'activate',
      'confirm',
      'invalidate',
      'restore',
    ].map(key => [key, jest.fn().mockResolvedValue({ checked: true })])
  )
);
const express = require('express');
const service = require('../src/services/aosTaskConfigService');
const { PERMISSIONS } = require('../src/constants/business');
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const routes = [
  ['GET', ''],
  ['GET', `/${INSTANCE}`],
  ['GET', `/${INSTANCE}/versions`],
  ['GET', `/${INSTANCE}/versions/version`],
  ...['preview', 'activate', 'confirm', 'invalidate', 'restore'].map(action => [
    'POST',
    `/${INSTANCE}/${action}`,
  ]),
];
let actor;
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = actor;
    next();
  });
  app.use('/api/server-monitor', require('../src/routes/serverMonitor'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/server-monitor/task-configs`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});
test.each(routes)('%s %s不向仅日志权限用户开放', async (method, path) => {
  actor = { id: 'actor', role: 'operator', permissions: [PERMISSIONS.MONITOR_LOGS_READ] };
  const response = await fetch(base + path, { method });
  expect(response.status).toBe(403);
});
test('monitor.manage可读取与提交，操作者取认证身份而非正文', async () => {
  actor = {
    id: 'authenticated-actor',
    role: 'operator',
    permissions: [PERMISSIONS.MONITOR_MANAGE, PERMISSIONS.MONITOR_LOGS_READ],
  };
  expect((await fetch(base)).status).toBe(200);
  const body = { text: 'fixture', actorId: 'forged-actor' };
  expect(
    (
      await fetch(`${base}/${INSTANCE}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).status
  ).toBe(200);
  expect(service.preview).toHaveBeenCalledWith(actor.id, INSTANCE, body);
});

test('畸形任务配置JSON不向响应或日志传播输入秘密', () => {
  const logger = require('../src/utils/logger');
  jest.clearAllMocks();
  const errorHandler = require('../src/middleware/errorHandler');
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  errorHandler(
    { type: 'entity.parse.failed', message: 'secret-password-in-invalid-json' },
    { method: 'POST', originalUrl: `/api/server-monitor/task-configs/${INSTANCE}/preview` },
    response,
    jest.fn()
  );
  expect(response.status).toHaveBeenCalledWith(400);
  expect(JSON.stringify([response.json.mock.calls, logger.warn.mock.calls])).not.toContain(
    'secret-password-in-invalid-json'
  );
});

test.each(['TASK-CONFIGS', 'Task-Configs', 'task-configs'])(
  '大小写路由%s与编码/语法异常均脱敏',
  path => {
    const logger = require('../src/utils/logger');
    const handler = require('../src/middleware/errorHandler');
    const errors = [
      new SyntaxError('secret-syntax-input'),
      { type: 'encoding.unsupported', message: 'secret-encoding-input' },
      { body: 'secret-body-input', message: 'secret-message' },
    ];
    for (const error of errors) {
      jest.clearAllMocks();
      const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      handler(
        error,
        { method: 'POST', originalUrl: `/api/server-monitor/${path}/${INSTANCE}/preview` },
        response,
        jest.fn()
      );
      expect(response.status).toHaveBeenCalledWith(400);
      expect(
        JSON.stringify([response.json.mock.calls, logger.warn.mock.calls, logger.error.mock.calls])
      ).not.toContain('secret-');
    }
  }
);
