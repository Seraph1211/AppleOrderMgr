/* global document, window */
const RUN_INTEGRATION = process.env.RUN_ACCOUNT_INTEGRATION === 'true';
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

/** 使用独立数据库与合成账号，验证实际 HTTP、JWT、事务及操作日志。 */
describeIntegration('账号管理隔离库验收', () => {
  let models;
  let authService;
  let server;
  let baseUrl;
  let sequence = Date.now();
  let testIp = 0;
  beforeEach(() => {
    testIp++;
  });
  const password = 'Synthetic-pass-42';
  const newPassword = 'Synthetic-new-84';
  const freshUser = async (role = 'operator', extra = {}) => {
    try {
      return await models.User.create({
        username: `account_test_${++sequence}`,
        password,
        role,
        nickname: `测试员工${sequence}`,
        ...extra,
      });
    } catch (error) {
      require('../src/utils/logger').error('账号验收请求失败', { error: error.message });
      throw error;
    }
  };
  const request = async (path, { token, method = 'GET', body } = {}) => {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `192.0.2.${testIp}`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      require('../src/utils/logger').error('账号验收请求失败', { error: error.message });
      throw error;
    }
  };
  const login = (user, extra = {}) =>
    request('/api/auth/login', {
      method: 'POST',
      body: { username: user.username, password, ...extra },
    });

  beforeAll(async () => {
    if (!/^apple_order_mgr_accounts_test_\d+$/.test(process.env.DB_NAME || ''))
      throw new Error('必须使用账号验收专用隔离库');
    models = require('../src/models');
    authService = require('../src/services/authService');
    const express = require('express');
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    app.use(require('../src/middleware/requestLogger')());
    app.use(require('../src/middleware/operationAudit').operationAudit);
    app.use('/api/auth', require('../src/routes/auth'));
    app.use('/api', require('../src/middleware/authMiddleware').authenticate);
    app.use('/api/users', require('../src/routes/users'));
    app.use('/api/system', require('../src/routes/system'));
    app.use('/api/email-processing', require('../src/routes/emailProcessing'));
    app.use('/api/dashboard', require('../src/routes/dashboardRoutes'));
    app.use('/api/orders', require('../src/routes/orders'));
    app.use(require('../src/middleware/errorHandler'));
    server = await new Promise(resolve => {
      const listener = app.listen(0, '0.0.0.0', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
  });

  test('首次登录忽略历史改密标记；零权限进入个人设置，有权限进入第一个业务页', async () => {
    const user = await freshUser('operator', { forcePasswordChange: true });
    const result = await login(user);
    expect(result.status).toBe(200);
    expect(result.body.data.user).toMatchObject({
      accountId: `U${String(user.id).padStart(4, '0')}`,
      nickname: user.nickname,
      availableHome: '/profile',
      forcePasswordChange: false,
    });
    expect((await request('/api/auth/me', { token: result.body.data.token })).status).toBe(200);
    await models.UserPermission.create({ userId: user.id, permissionCode: 'orders.read' });
    expect(
      (await request('/api/auth/me', { token: result.body.data.token })).body.data.availableHome
    ).toBe('/orders');
    expect((await request('/api/orders', { token: result.body.data.token })).status).toBe(200);
  });

  test('前三台同时登录；第四台取消确认不影响已有设备，错误密码不签发确认', async () => {
    const user = await freshUser();
    const sessions = await Promise.all([login(user), login(user), login(user)]);
    expect(sessions.map(item => item.status)).toEqual([200, 200, 200]);
    const conflict = await login(user);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('SESSION_CONFIRMATION_REQUIRED');
    const wrong = await login(user, { password: 'Synthetic-wrong' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.details).toBeUndefined();
    for (const session of sessions)
      expect((await request('/api/auth/me', { token: session.body.data.token })).status).toBe(200);
  });

  test('第四台只替换最早会话；旧确认凭证不能重复踢出设备', async () => {
    const user = await freshUser();
    const first = await login(user);
    const second = await login(user);
    const third = await login(user);
    const conflict = await login(user);
    const confirmationToken = conflict.body.error.details.confirmationToken;
    const fourth = await login(user, { confirmationToken });
    expect(fourth.status).toBe(200);
    expect((await request('/api/auth/me', { token: first.body.data.token })).body.error.code).toBe(
      'SESSION_REPLACED'
    );
    expect((await login(user, { confirmationToken })).status).toBe(409);
    for (const session of [second, third, fourth])
      expect((await request('/api/auth/me', { token: session.body.data.token })).status).toBe(200);
  });

  test('并发登录最多三个会话，同一确认并发接管仅一次成功', async () => {
    const user = await freshUser();
    const initial = await Promise.all(Array.from({ length: 5 }, () => login(user)));
    expect(initial.map(item => item.status).sort()).toEqual([200, 200, 200, 409, 409]);
    const confirmationToken = initial.find(item => item.status === 409).body.error.details
      .confirmationToken;
    const takeover = await Promise.all([
      login(user, { confirmationToken }),
      login(user, { confirmationToken }),
    ]);
    expect(takeover.map(item => item.status).sort()).toEqual([200, 409]);
    expect((await user.reload()).activeSessions).toHaveLength(3);
  });

  test('退出仅释放本机名额；迟到退出不影响其他设备，空位无需确认', async () => {
    const user = await freshUser();
    const first = await login(user);
    const second = await login(user);
    const third = await login(user);
    const oldSessionId = require('../src/utils/jwtUtils').decodeToken(
      first.body.data.token
    ).sessionId;
    expect(
      (await request('/api/auth/logout', { method: 'POST', token: first.body.data.token })).status
    ).toBe(200);
    const fourth = await login(user);
    expect(fourth.status).toBe(200);
    await authService.logout(user.id, oldSessionId);
    expect((await request('/api/auth/me', { token: first.body.data.token })).status).toBe(401);
    for (const session of [second, third, fourth])
      expect((await request('/api/auth/me', { token: session.body.data.token })).status).toBe(200);
  });

  test('同一会话重新登录不占额外名额；过期会话自动释放', async () => {
    const user = await freshUser();
    const first = await login(user);
    const second = await login(user);
    const third = await login(user);
    const renewed = await request('/api/auth/login', {
      method: 'POST',
      token: second.body.data.token,
      body: { username: user.username, password },
    });
    expect(renewed.status).toBe(200);
    expect((await request('/api/auth/me', { token: second.body.data.token })).status).toBe(401);
    expect((await request('/api/auth/me', { token: first.body.data.token })).status).toBe(200);
    expect((await request('/api/auth/me', { token: third.body.data.token })).status).toBe(200);
    await user.reload();
    await user.update({
      activeSessions: user.activeSessions.map((session, i) =>
        i === 0 ? { ...session, expiresAt: new Date(0).toISOString() } : session
      ),
    });
    expect((await login(user)).status).toBe(200);
    expect((await user.reload()).activeSessions).toHaveLength(3);
  });

  test('所有角色可改本人昵称与密码；不能借资料接口提权', async () => {
    for (const role of ['operator', 'readOnly', 'admin']) {
      const user = await freshUser(role);
      const token = (await login(user)).body.data.token;
      const otherTokens = [
        (await login(user)).body.data.token,
        (await login(user)).body.data.token,
      ];
      const result = await request('/api/auth/profile', {
        method: 'PATCH',
        token,
        body: { nickname: ' 新昵称 ' },
      });
      expect(result.body.data.nickname).toBe('新昵称');
      expect(
        (
          await request('/api/auth/profile', {
            method: 'PATCH',
            token,
            body: { nickname: '别名', role: 'admin' },
          })
        ).status
      ).toBe(400);
      const changed = await request('/api/auth/change-password', {
        method: 'POST',
        token,
        body: { oldPassword: password, newPassword, confirmPassword: newPassword },
      });
      expect(changed.status).toBe(200);
      expect((await request('/api/auth/me', { token })).status).toBe(401);
      for (const otherToken of otherTokens)
        expect((await request('/api/auth/me', { token: otherToken })).status).toBe(401);
      expect((await login(user, { password: newPassword })).status).toBe(200);
    }
  });

  test('管理员创建、配置昵称、重置密码；不泄露哈希或原密码', async () => {
    const admin = await freshUser('admin');
    const token = (await login(admin)).body.data.token;
    const created = await request('/api/users', {
      method: 'POST',
      token,
      body: {
        username: `created_test_${++sequence}`,
        nickname: '新同事',
        password,
        permissions: ['orders.read'],
      },
    });
    expect(created.status).toBe(201);
    const user = created.body.data;
    const oldToken = (await login(user)).body.data.token;
    const otherTokens = [(await login(user)).body.data.token, (await login(user)).body.data.token];
    expect(
      (
        await request(`/api/users/${user.id}`, {
          method: 'PUT',
          token,
          body: { nickname: '管理员配置' },
        })
      ).body.data.nickname
    ).toBe('管理员配置');
    const reset = await request(`/api/users/${user.id}/reset-password`, {
      method: 'POST',
      token,
      body: { newPassword, confirmPassword: newPassword },
    });
    expect(reset.status).toBe(200);
    expect((await request('/api/auth/me', { token: oldToken })).status).toBe(401);
    for (const otherToken of otherTokens)
      expect((await request('/api/auth/me', { token: otherToken })).status).toBe(401);
    expect((await login(user, { password: newPassword })).status).toBe(200);
    const list = await request(`/api/users?keyword=${user.accountId}`, { token });
    expect(list.body.data.users).toHaveLength(1);
    expect(list.body.data.users[0]).toMatchObject({
      nickname: '管理员配置',
      accountId: user.accountId,
    });
    expect(JSON.stringify(list.body)).not.toMatch(/activeSession|password|\$2[aby]\$/);
  });

  test('普通账号无法重置他人密码或读取运行与操作日志，拒绝也留痕', async () => {
    const user = await freshUser();
    const token = (await login(user)).body.data.token;
    for (const path of ['/api/system/operation-logs', '/api/system/logs'])
      expect((await request(path, { token })).status).toBe(403);
    expect(
      (
        await request(`/api/users/${user.id}/reset-password`, {
          method: 'POST',
          token,
          body: { newPassword, confirmPassword: newPassword },
        })
      ).status
    ).toBe(403);
    const logs = await models.OperationLog.findAll({
      where: { actorUserId: user.id, statusCode: 403 },
    });
    expect(logs).toHaveLength(3);
  });

  test('审计保留昵称快照、中文动作、IP、时间且没有密码、令牌或查询值', async () => {
    const user = await freshUser('admin');
    const token = (await login(user)).body.data.token;
    await request('/api/auth/profile?secret=forbidden-query-value', {
      method: 'PATCH',
      token,
      body: { nickname: '操作后的昵称' },
    });
    const result = await request(
      `/api/system/operation-logs?keyword=U${String(user.id).padStart(4, '0')}`,
      { token }
    );
    expect(result.status).toBe(200);
    const changed = result.body.data.logs.find(item => item.action === '修改本人昵称');
    expect(changed).toMatchObject({
      nickname: user.nickname,
      username: user.username,
      resultLabel: '成功',
    });
    expect(changed.ip).toBeTruthy();
    expect(new Date(changed.createdAt).getTime()).toBeGreaterThan(0);
    const stored = JSON.stringify(await models.OperationLog.findAll());
    for (const secret of [password, newPassword, token, 'forbidden-query-value'])
      expect(stored).not.toContain(secret);
    expect((await request('/api/system/operation-logs?dateFrom=invalid', { token })).status).toBe(
      400
    );
  });

  test('会话到期、旧版本 Token、管理员锁定均拒绝访问', async () => {
    const user = await freshUser();
    const token = (await login(user)).body.data.token;
    await user.reload();
    await user.update({
      activeSessions: user.activeSessions.map(session => ({
        ...session,
        expiresAt: new Date(0).toISOString(),
      })),
    });
    expect((await request('/api/auth/me', { token })).status).toBe(401);
    const legacy = require('../src/utils/jwtUtils').generateToken({
      userId: user.id,
      username: user.username,
      role: user.role,
    });
    expect((await request('/api/auth/me', { token: legacy })).status).toBe(401);
    const admin = await freshUser('admin');
    const adminToken = (await login(admin)).body.data.token;
    const nextToken = (await login(user)).body.data.token;
    await request(`/api/users/${user.id}`, {
      method: 'PUT',
      token: adminToken,
      body: { status: 'locked' },
    });
    expect((await request('/api/auth/me', { token: nextToken })).status).toBe(401);
    expect((await login(user)).status).toBe(403);
  });
  const browserTest = process.env.ACCOUNT_BROWSER_WS ? test : test.skip;
  browserTest(
    '双浏览器真实页面：昵称、接管弹窗、旧端退出、个人改密、管理员编辑重置和日志',
    async () => {
      const { chromium } = require('playwright-core');
      const browser = await chromium.connectOverCDP(process.env.ACCOUNT_BROWSER_WS, {
        headers: { Host: '127.0.0.1' },
      });
      const contexts = [];
      const pageErrors = [];
      const open = async () => {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 960 },
          timezoneId: 'Asia/Shanghai',
        });
        contexts.push(context);
        await context.route('**/api/**', async route => {
          try {
            const incoming = route.request();
            const url = new URL(incoming.url());
            if (!url.pathname.startsWith('/api/')) {
              await route.continue();
              return;
            }
            const response = await fetch(`${baseUrl}${url.pathname}${url.search}`, {
              method: incoming.method(),
              headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': `192.0.2.${testIp}`,
                ...(incoming.headers().authorization
                  ? { Authorization: incoming.headers().authorization }
                  : {}),
              },
              body: ['GET', 'HEAD'].includes(incoming.method()) ? undefined : incoming.postData(),
            });
            await route.fulfill({
              status: response.status,
              contentType: 'application/json',
              body: await response.text(),
            });
          } catch (error) {
            pageErrors.push(error.message);
            await route.abort();
          }
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto('http://127.0.0.1:5173/login');
        await page.screenshot({ path: '/tmp/account-artifacts/account-login.png' });
        if (pageErrors.length) throw new Error(pageErrors.join('; '));
        return page;
      };
      const fillLogin = async (page, user, secret = password) => {
        await page.getByLabel('登录账号', { exact: true }).fill(user.username);
        await page.getByLabel('密码', { exact: true }).fill(secret);
        await page.getByRole('button', { name: '登录', exact: true }).click();
      };
      try {
        const employee = await freshUser('readOnly', { forcePasswordChange: true });
        const first = await open();
        await fillLogin(first, employee);
        await first.waitForURL('**/profile');
        await first.getByLabel('昵称', { exact: true }).fill('浏览器员工');
        await first.getByRole('button', { name: '保存昵称' }).click();
        await first.getByText('昵称已保存', { exact: true }).waitFor();
        await first.screenshot({
          path: '/tmp/account-artifacts/account-profile.png',
          fullPage: true,
        });
        await login(employee);
        await login(employee);
        const second = await open();
        await fillLogin(second, employee);
        await second.getByText('已达到 3 台设备登录上限', { exact: true }).waitFor();
        await second.getByRole('button', { name: '取消', exact: true }).click();
        expect(new URL(first.url()).pathname).toBe('/profile');
        await second.getByRole('button', { name: '登录', exact: true }).click();
        await second.getByText('已达到 3 台设备登录上限', { exact: true }).waitFor();
        await second.screenshot({
          path: '/tmp/account-artifacts/account-takeover.png',
          fullPage: true,
        });
        await second.getByRole('button', { name: '确定', exact: true }).click();
        await second.waitForURL('**/profile');
        await first.waitForURL('**/login');
        await first.getByText('当前设备的登录已失效，请重新登录', { exact: true }).waitFor();
        await second.getByRole('link', { name: '修改密码', exact: true }).click();
        await second.getByLabel('旧密码', { exact: true }).fill(password);
        await second.getByLabel('新密码', { exact: true }).fill(newPassword);
        await second.getByLabel('确认密码', { exact: true }).fill(newPassword);
        await second.getByRole('button', { name: '确认修改' }).click();
        await second.waitForURL('**/login');
        await second.getByRole('button', { name: '确定', exact: true }).click();
        await fillLogin(second, employee, newPassword);
        await second.waitForURL('**/profile');
        const admin = await freshUser('admin');
        const manager = await open();
        await fillLogin(manager, admin);
        await manager.waitForURL('http://127.0.0.1:5173/');
        await manager.goto('http://127.0.0.1:5173/users');
        await manager.getByRole('cell', { name: employee.username, exact: true }).waitFor();
        await manager
          .getByRole('row')
          .filter({ hasText: employee.username })
          .getByTitle('编辑', { exact: true })
          .click();
        await manager.getByLabel('昵称', { exact: true }).fill('管理员配置昵称');
        await manager.getByRole('button', { name: '确认保存' }).click();
        await manager.getByText('用户信息更新成功', { exact: true }).waitFor();
        await manager.getByRole('button', { name: '确定', exact: true }).click();
        await manager.getByRole('cell', { name: '管理员配置昵称', exact: true }).waitFor();
        await manager.screenshot({
          path: '/tmp/account-artifacts/account-users.png',
          fullPage: true,
        });
        await manager
          .getByRole('row')
          .filter({ hasText: employee.username })
          .getByTitle('重置密码', { exact: true })
          .click();
        await manager.getByLabel('新密码', { exact: true }).fill(password);
        await manager.getByLabel('确认新密码', { exact: true }).fill(password);
        await manager.getByRole('button', { name: '确认重置', exact: true }).click();
        await manager.getByText('重置成功', { exact: true }).waitFor();
        await second.waitForURL('**/login');
        await manager.goto('http://127.0.0.1:5173/operation-logs');
        await manager.getByRole('cell', { name: '重置账号密码', exact: true }).first().waitFor();
        await manager.screenshot({
          path: '/tmp/account-artifacts/account-operation-logs.png',
          fullPage: true,
        });
        const logOrder = await models.Order.create({
          orderNumber: `W${String(++sequence).slice(-10)}`,
          products: [{ name: '合成日志商品', quantity: 1 }],
          status: 'pending',
          paymentStatus: 'unpaid',
          orderDate: new Date(),
        });
        await models.CrawlLog.create({
          orderId: logOrder.id,
          event: 'order_sync_failed',
          eventType: 'crawler',
          severity: 'error',
          result: 'failed',
          success: false,
          errorMessage: 'Request failed with status code 403',
          httpStatus: 403,
        });
        await manager.goto('http://127.0.0.1:5173/system-logs');
        await manager.getByRole('cell', { name: '订单同步失败', exact: true }).first().waitFor();
        await manager
          .getByRole('cell', { name: '官网拒绝访问，请检查风控和代理状态', exact: true })
          .first()
          .waitFor();
        await manager.screenshot({
          path: '/tmp/account-artifacts/account-system-logs.png',
          fullPage: true,
        });
        await manager.setViewportSize({ width: 390, height: 844 });
        await manager.goto('http://127.0.0.1:5173/profile');
        await manager.getByRole('heading', { name: '个人设置' }).waitFor();
        await manager.screenshot({
          path: '/tmp/account-artifacts/account-profile-mobile.png',
          fullPage: true,
        });
        expect(
          await manager.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true);
        expect(pageErrors).toEqual([]);
      } finally {
        for (const context of contexts) await context.close();
        await browser.close();
      }
    },
    90000
  );

  test('三会话迁移回退再升级保留最新登录和用户资料，约束拒绝第四条', async () => {
    const user = await freshUser();
    await login(user);
    const latest = await login(user);
    const migration = require('../migrations/20260909000004-allow-three-account-sessions');
    const qi = models.sequelize.getQueryInterface();
    await migration.down(qi);
    await migration.up(qi, models.Sequelize);
    expect((await request('/api/auth/me', { token: latest.body.data.token })).status).toBe(200);
    await user.reload();
    expect(user.activeSessions).toHaveLength(1);
    await expect(
      user.update({ activeSessions: Array(4).fill(user.activeSessions[0]) })
    ).rejects.toThrow();
  });

  test('正式迁移 down/up 保留账号主键、登录名、密码及角色，清除新增会话', async () => {
    const migration = require('../migrations/20260909000003-add-account-sessions-and-audit');
    const fields = 'id, username, password, role';
    const [before] = await models.sequelize.query(`SELECT ${fields} FROM users ORDER BY id`);
    const queryInterface = models.sequelize.getQueryInterface();
    const threeSessionMigration = require('../migrations/20260909000004-allow-three-account-sessions');
    await threeSessionMigration.down(queryInterface);
    await migration.down(queryInterface);
    const schema = await queryInterface.describeTable('users');
    expect(schema.nickname).toBeUndefined();
    await migration.up(queryInterface, models.Sequelize);
    await threeSessionMigration.up(queryInterface, models.Sequelize);
    const [after] = await models.sequelize.query(`SELECT ${fields} FROM users ORDER BY id`);
    expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
    expect(await models.OperationLog.count()).toBe(0);
    const [sessions] = await models.sequelize.query(
      'SELECT active_session_id FROM users WHERE active_session_id IS NOT NULL'
    );
    expect(sessions).toHaveLength(0);
  });
});
