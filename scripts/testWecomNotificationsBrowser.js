/* global localStorage, document, window */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const logger = require('../src/utils/logger');

/** 专用浏览器的全模拟验收，不访问真实 API、企微或支付地址。 */
async function main() {
  let browser;
  let context;
  try {
    const { chromium } = require('playwright-core');
    if (!process.env.WECOM_BROWSER_WS) throw new Error('需要专用临时浏览器地址');
    browser = await chromium.connectOverCDP(process.env.WECOM_BROWSER_WS, {
      headers: { Host: 'localhost' },
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-wecom-token'));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const writes = [];
    let fail = false;
    let empty = false;
    let permitted = true;
    const settings = {
      enabled: false,
      groupName: '',
      configured: false,
      destinationId: 'synthetic',
      enabledAt: null,
      version: 1,
      pausedReason: null,
      workerHeartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      waitSeconds: 60,
      ratePerMinute: 18,
    };
    const row = {
      id: '10000000-0000-4000-8000-000000000001',
      orderId: 335,
      groupName: '内部测试群',
      kind: 'order',
      status: 'unknown',
      attempts: 1,
      version: 3,
      createdAt: new Date().toISOString(),
      errorCode: 'TRANSPORT_UNKNOWN',
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        let data = {};
        const method = route.request().method();
        if (method !== 'GET')
          writes.push({ path: url.pathname, body: route.request().postDataJSON() });
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: '合成管理员',
            role: 'admin',
            permissions: permitted ? ['wecom.read', 'wecom.configure', 'wecom.retry'] : [],
            availableHome: '/wecom-notifications',
          };
        else if (url.pathname.endsWith('/wecom-notifications/settings')) {
          if (method === 'PUT') {
            const body = route.request().postDataJSON();
            assert.equal(body.expectedVersion, settings.version);
            Object.assign(settings, {
              groupName: body.groupName,
              enabled: body.enabled,
              configured: settings.configured || Boolean(body.webhook),
              version: settings.version + 1,
            });
          }
          data = settings;
        } else if (url.pathname.endsWith('/wecom-notifications/deliveries')) {
          if (fail) {
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, error: { message: '合成加载失败' } }),
            });
            return;
          }
          data = {
            rows: empty ? [] : [row],
            total: empty ? 0 : 1,
            page: 1,
            totalPages: 1,
            summary: {
              backlog: 12,
              failed: 1,
              unknown: 1,
              skipped: 2,
              oldestPendingAt: row.createdAt,
            },
          };
        } else if (url.pathname.endsWith('/wecom-notifications/test'))
          data = { id: 'synthetic-test', status: 'pending' };
        else if (url.pathname.endsWith('/retry')) {
          assert.equal(route.request().postDataJSON().acknowledgeUnknown, true);
          data = { ...row, status: 'pending' };
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    await page.goto('http://127.0.0.1:5173/wecom-notifications');
    await page.getByRole('heading', { name: '企微订单通知', exact: true }).waitFor();
    await page.getByText('自动通知已关闭', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '发送测试消息', exact: true }).isEnabled(),
      false
    );
    await page.getByLabel('目标群名称').fill('内部测试群');
    await page
      .getByLabel('机器人 Webhook')
      .fill('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-key-1234');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.getByText('配置已保存，自动通知处于关闭状态。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('机器人 Webhook').inputValue(), '');
    await page.getByRole('button', { name: '发送测试消息', exact: true }).click();
    await page
      .getByText('测试消息已入队，请在投递记录及目标群中核对结果。', { exact: true })
      .waitFor();
    assert.equal(writes.filter(x => x.path.endsWith('/test')).length, 1);
    await page.getByLabel('目标群名称').fill('未保存群名');
    assert.equal(
      await page.getByRole('button', { name: '发送测试消息', exact: true }).isEnabled(),
      false
    );
    await page.getByRole('button', { name: '刷新记录', exact: true }).click();
    assert.equal(await page.getByLabel('目标群名称').inputValue(), '未保存群名');
    await page.getByLabel('目标群名称').fill('内部测试群');
    await page.getByLabel('启用新订单自动通知').check();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.getByText('自动通知已启用', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('机器人 Webhook').isEnabled(), false);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: '确认重试', exact: true }).isEnabled(),
      false
    );
    await page.getByLabel('我已核对群消息，确认重新发送并接受重复消息的可能').check();
    await page.getByRole('button', { name: '确认重试', exact: true }).click();
    await page
      .getByText('已处理重试请求，发送前仍会检查订单状态和时效。', { exact: true })
      .waitFor();
    const output = '/app/test-artifacts/wecom-notifications';
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: output + '/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: output + '/mobile.png', fullPage: true });
    await page.getByRole('button', { name: '重试', exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    fail = true;
    await page.getByRole('button', { name: '刷新记录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '合成加载失败' }).waitFor();
    fail = false;
    empty = true;
    await page.getByRole('button', { name: '刷新记录', exact: true }).click();
    await page.getByText('暂无投递记录。配置后可发送测试消息。', { exact: true }).waitFor();
    permitted = false;
    await page.reload();
    await page
      .getByRole('heading', { name: '企微订单通知', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('link', { name: '企微订单通知', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    logger.info('企微通知合成浏览器验收通过', {
      widths: [1440, 375],
      writes: writes.length,
      cases: [
        '默认关闭',
        '密钥不回显',
        '关闭时测试',
        '草稿保留',
        '启用',
        '未知重试确认',
        '加载失败',
        '空列表',
        '权限隐藏',
        '手机布局',
      ],
    });
  } catch (error) {
    logger.error('企微通知合成浏览器验收失败', { message: error.message });
    process.exitCode = 1;
  } finally {
    await context?.close();
    await browser?.close();
  }
}
main();
