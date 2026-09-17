/* global localStorage, window */
const assert = require('node:assert/strict');
const logger = require('../src/utils/logger');

/** 使用合成 API 验证用户授权弹窗，不连接真实业务 API。 */
async function main() {
  let browser;
  let context;
  try {
    if (!process.env.ORDER_TAG_BROWSER_WS) throw new Error('需要专用临时浏览器地址');
    browser = await require('playwright-core').chromium.connectOverCDP(
      process.env.ORDER_TAG_BROWSER_WS,
      { headers: { Host: '127.0.0.1' } }
    );
    context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    let authUser = {
      id: 1,
      username: 'synthetic_admin',
      nickname: '测试管理员',
      role: 'admin',
      permissions: ['users.read', 'users.permissions.manage'],
      permissionsVersion: 1,
      availableHome: '/users',
    };
    const errors = [];
    let failSave = false;
    let failLoad = false;
    let config = {
      permissions: ['orders.read'],
      orderAccess: { mode: 'all', tags: [] },
      version: 1,
      editable: true,
    };
    const writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-order-tag-token'));
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        let data;
        let status = 200;
        if (url.pathname === '/api/auth/me') data = authUser;
        else if (url.pathname === '/api/channels')
          data = {
            channels: authUser.orderAccess?.tags.length
              ? [
                {
                  tag: 'TAG-A',
                  channelName: '可撤销渠道',
                  totalOrders: 1,
                  paidOrders: 0,
                  deliveredOrders: 0,
                  totalAmount: 100,
                },
              ]
              : [],
          };
        else if (url.pathname === '/api/users')
          data = {
            users: [
              {
                id: 2,
                username: 'synthetic_staff',
                nickname: '测试员工',
                role: 'operator',
                status: 'active',
                accountId: 'U0002',
              },
            ],
            total: 1,
            page: 1,
            limit: 10,
          };
        else if (url.pathname === '/api/users/permission-catalog')
          data = {
            permissions: [
              {
                code: 'orders.read',
                module: 'orders',
                moduleLabel: '订单',
                label: '查看授权范围订单',
                dependencies: [],
                adminReserved: false,
              },
              {
                code: 'orders.export',
                module: 'orders',
                moduleLabel: '订单',
                label: '导出订单',
                dependencies: ['orders.read'],
                adminReserved: false,
              },
            ],
          };
        else if (url.pathname === '/api/users/order-tag-options') {
          if (failLoad) {
            status = 500;
            data = { error: { message: '候选加载失败' } };
          } else data = { tags: ['TAG-A', 'TAG-B', 'TAG-A-1', '复杂 / 中文 TAG'] };
        } else if (url.pathname === '/api/users/2/permissions') {
          if (route.request().method() === 'PUT') {
            const input = route.request().postDataJSON();
            writes.push(input);
            if (failSave) {
              status = 409;
              data = { error: { message: '权限配置已被其他操作更新，请刷新后重试' } };
            } else {
              config = { ...config, ...input, version: config.version + 1 };
              data = config;
            }
          } else data = config;
        } else {
          errors.push(`意外 API: ${url.pathname}`);
          status = 404;
          data = {};
        }
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(status === 200 ? { success: true, data } : data),
        });
      } catch (error) {
        errors.push(error.message);
      }
    });
    await page.goto('http://127.0.0.1:5173/users');
    await page.getByTitle('权限配置').click();
    await page.getByRole('radio', { name: '指定 TAG' }).check();
    await page.getByLabel('搜索订单 TAG').fill('TAG-B');
    await page.getByLabel('TAG-B', { exact: true }).check();
    await page.getByLabel('搜索订单 TAG').fill('TAG-A');
    await page.getByLabel('TAG-A', { exact: true }).check();
    await page.getByRole('button', { name: '保存权限', exact: true }).click();
    await page.getByTitle('权限配置').click();
    assert.deepEqual(config.orderAccess.tags.sort(), ['TAG-A', 'TAG-B']);
    assert.equal(await page.getByRole('radio', { name: '指定 TAG' }).isChecked(), true);
    await page.screenshot({ path: '/app/uploads/order-tag-access-desktop.png', fullPage: true });
    for (const width of [375, 768, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.getByRole('button', { name: '保存权限', exact: true }).isVisible(),
        true
      );
      const size = await page.getByText('订单数据范围', { exact: true }).boundingBox();
      assert.ok(size.x >= 0 && size.x + size.width <= width);
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await page.screenshot({ path: '/app/uploads/order-tag-access-mobile.png', fullPage: true });
    await page.getByLabel('TAG-A', { exact: true }).uncheck();
    await page.getByLabel('TAG-B', { exact: true }).uncheck();
    failSave = true;
    await page.getByRole('button', { name: '保存权限', exact: true }).click();
    await page.getByText('权限配置已被其他操作更新，请刷新后重试', { exact: true }).waitFor();
    assert.equal(await page.getByRole('radio', { name: '指定 TAG' }).isChecked(), true);
    failSave = false;
    await page.getByRole('button', { name: '保存权限', exact: true }).click();
    assert.deepEqual(writes.at(-1).orderAccess, { mode: 'tags', tags: [] });
    await page.getByTitle('权限配置').click();
    await page.getByRole('radio', { name: '全部订单' }).check();
    await page.getByRole('button', { name: '保存权限', exact: true }).click();
    assert.equal(writes.at(-1).orderAccess.mode, 'all');
    failLoad = true;
    await page.getByTitle('权限配置').click();
    await page.getByText('候选加载失败', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存权限', exact: true }).count(), 0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    authUser = {
      id: 2,
      username: 'synthetic_staff',
      role: 'operator',
      permissions: ['channels.read', 'orders.read'],
      permissionsVersion: 1,
      availableHome: '/channels',
      orderAccess: { mode: 'tags', tags: ['TAG-A'] },
    };
    await page.goto('http://127.0.0.1:5173/channels');
    await page.getByText('可撤销渠道', { exact: true }).waitFor();
    authUser = { ...authUser, permissionsVersion: 2, orderAccess: { mode: 'tags', tags: [] } };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByText('可撤销渠道', { exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    logger.info('订单 TAG 浏览器合成验收通过', {
      widths: [1440, 375, 768, 1024],
      writes: writes.length,
      scenarios: [
        '搜索多选',
        '保存回读',
        '空范围',
        '全部范围',
        '冲突保留草稿',
        '加载失败禁止保存',
        '撤权清空旧视图',
      ],
    });
  } catch (error) {
    logger.error('订单 TAG 浏览器验收失败', { error: error.message });
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}
main().catch(error => {
  logger.error('浏览器验收启动失败', { error: error.message });
  process.exitCode = 1;
});
