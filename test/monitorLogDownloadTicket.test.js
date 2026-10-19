process.env.JWT_SECRET = 'monitor-log-download-test-secret-1234567890';

jest.mock('../src/models', () => ({ User: { findByPk: jest.fn() } }));
jest.mock('../src/services/permissionService', () => ({ getEffectivePermissions: jest.fn() }));
jest.mock('../src/services/monitorLogService', () => ({
  prepareExport: jest.fn(input => ({
    query: {
      deviceId: input.deviceId,
      localId: input.localId,
      ...(input.startAt ? { startAt: input.startAt, endAt: input.endAt } : { date: input.date }),
    },
    rows: [],
    fileName: 'aos-synthetic.log',
  })),
  writeExport: jest.fn(async (_prepared, write) => {
    await write('第一行\n');
    await write('第二行\n');
    return { exported: 2, aborted: false, durationMs: 1 };
  }),
}));
jest.mock('../src/services/monitorService', () => ({}));
jest.mock('../src/services/monitorNotificationService', () => ({}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { User } = require('../src/models');
const permissionService = require('../src/services/permissionService');
const { authenticate } = require('../src/middleware/authMiddleware');
const { generateToken, verifyToken } = require('../src/utils/jwtUtils');
const ticket = require('../src/services/monitorLogDownloadTicket');

const sessionId = '8c5d262d-40b5-43af-84b2-54765d817acc';
const scope = {
  deviceId: '11111111-1111-4111-8111-111111111111',
  localId: '22222222-2222-4222-8222-222222222222',
  date: '2026-10-17',
};
const actor = {
  id: 7,
  username: 'download-test',
  nickname: '下载测试',
  role: 'operator',
  status: 'active',
  sessionId,
  permissionsVersion: 3,
  orderAccess: {},
  activeSessions: [
    {
      id: sessionId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  ],
};

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function request(overrides = {}) {
  return {
    method: 'GET',
    originalUrl: `${ticket.COOKIE_PATH}?${new URLSearchParams(scope)}`,
    path: '/server-monitor/logs/export',
    ip: '127.0.0.1',
    headers: {},
    ...overrides,
  };
}

describe('日志原生下载短期凭证', () => {
  beforeEach(() => {
    User.findByPk.mockResolvedValue(actor);
    permissionService.getEffectivePermissions.mockResolvedValue(['monitor.logs.read']);
  });

  test('凭证只匹配签发时的服务器、实例和日期', () => {
    const value = ticket.issue(actor, scope);
    const decoded = verifyToken(value);
    expect(decoded.purpose).toBe(ticket.PURPOSE);
    expect(ticket.matches({ source: 'download-cookie', ...decoded }, scope)).toBe(true);
    expect(
      ticket.matches({ source: 'download-cookie', ...decoded }, { ...scope, date: '2026-10-16' })
    ).toBe(false);
    expect(
      ticket.matches({ source: 'download-cookie', ...decoded }, { ...scope, account: '1' })
    ).toBe(false);
  });

  test('跨日短期凭证绑定完整秒范围且拒绝缺失或额外字段', () => {
    const range = {
      deviceId: scope.deviceId,
      localId: scope.localId,
      startAt: '2026-10-16T23:59:59',
      endAt: '2026-10-17T00:00:00',
    };
    const auth = { source: 'download-cookie', ...verifyToken(ticket.issue(actor, range)) };
    expect(ticket.matches(auth, range)).toBe(true);
    for (const change of [
      { endAt: '2026-10-17T00:00:01' },
      { startAt: undefined },
      { date: scope.date },
      { account: '1' },
    ])
      expect(ticket.matches(auth, { ...range, ...change })).toBe(false);
    expect(ticket.matches(auth, scope)).toBe(false);
  });

  test('原生下载入口用HttpOnly Cookie重新校验有效会话和权限', async () => {
    const value = ticket.issue(actor, scope);
    const req = request({ headers: { cookie: `${ticket.COOKIE_NAME}=${value}` } });
    const res = response();
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({ id: actor.id, sessionId, permissions: ['monitor.logs.read'] });
    expect(req.authContext).toMatchObject({
      source: 'download-cookie',
      purpose: ticket.PURPOSE,
      scope,
    });
  });

  test('限定用途凭证不能作为普通Bearer访问其他接口', async () => {
    const value = ticket.issue(actor, scope);
    const req = request({
      method: 'POST',
      originalUrl: '/api/server-monitor/rules',
      path: '/server-monitor/rules',
      headers: { authorization: `Bearer ${value}` },
    });
    const res = response();
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('普通Bearer认证保持原行为', async () => {
    const value = generateToken({
      userId: actor.id,
      username: actor.username,
      role: actor.role,
      sessionId,
    });
    const req = request({
      originalUrl: '/api/server-monitor/logs',
      path: '/server-monitor/logs',
      headers: { authorization: `Bearer ${value}` },
    });
    const res = response();
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.authContext).toMatchObject({ source: 'authorization-header', purpose: null });
  });
});

describe('日志原生下载HTTP链路', () => {
  let server;
  let base;

  beforeAll(async () => {
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api', authenticate);
    app.use('/api/server-monitor', require('../src/routes/serverMonitor'));
    app.use(require('../src/middleware/errorHandler'));
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    User.findByPk.mockResolvedValue(actor);
    permissionService.getEffectivePermissions.mockResolvedValue(['monitor.logs.read']);
  });

  test.each([
    scope,
    {
      deviceId: scope.deviceId,
      localId: scope.localId,
      startAt: '2026-10-16T23:59:59',
      endAt: '2026-10-17T00:00:00',
    },
  ])('Bearer签发Cookie后由浏览器请求原生流式附件并清除Cookie %j', async downloadScope => {
    const bearer = generateToken({
      userId: actor.id,
      username: actor.username,
      role: actor.role,
      sessionId,
    });
    const authorized = await fetch(`${base}/api/server-monitor/logs/export-ticket`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(downloadScope),
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      success: true,
      data: { expiresInSeconds: 60 },
    });
    const setCookie = authorized.headers.get('set-cookie');
    expect(setCookie).toContain(`${ticket.COOKIE_NAME}=`);
    expect(setCookie).toContain(`Path=${ticket.COOKIE_PATH}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    const downloaded = await fetch(
      `${base}${ticket.COOKIE_PATH}?${new URLSearchParams(downloadScope)}`,
      {
        headers: { Cookie: setCookie.split(';')[0] },
      }
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-disposition')).toBe(
      'attachment; filename="aos-synthetic.log"'
    );
    expect(downloaded.headers.get('set-cookie')).toContain(`${ticket.COOKIE_NAME}=`);
    expect(await downloaded.text()).toBe('第一行\n第二行\n');
  });

  test('下载Cookie不能改换日期且权限撤销立即生效', async () => {
    const value = ticket.issue(actor, scope);
    const cookie = `${ticket.COOKIE_NAME}=${value}`;
    const mismatch = await fetch(
      `${base}${ticket.COOKIE_PATH}?${new URLSearchParams({ ...scope, date: '2026-10-16' })}`,
      { headers: { Cookie: cookie } }
    );
    expect(mismatch.status).toBe(403);
    expect((await mismatch.json()).error.code).toBe('DOWNLOAD_SCOPE_MISMATCH');

    permissionService.getEffectivePermissions.mockResolvedValue([]);
    const revoked = await fetch(`${base}${ticket.COOKIE_PATH}?${new URLSearchParams(scope)}`, {
      headers: { Cookie: cookie },
    });
    expect(revoked.status).toBe(403);
    expect((await revoked.json()).error.code).toBe('FORBIDDEN');
  });
});
