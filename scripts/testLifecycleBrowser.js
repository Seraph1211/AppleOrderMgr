/* eslint-disable camelcase -- 合成 API 数据保留既有字段契约 */
/* global localStorage, sessionStorage, document, location */
const assert = require('node:assert/strict');
const logger = require('../src/utils/logger');

/** 用独立空白浏览器和全量 API 拦截验证前端，不访问真实业务后端。 */
async function main() {
  let browser;
  let context;
  let page;
  try {
    if (process.env.RUN_LIFECYCLE_BROWSER !== 'true' || !process.env.LIFECYCLE_BROWSER_WS) {
      throw new Error('需要显式启用并提供专用临时浏览器 WebSocket 地址');
    }
    const baseUrl = new URL(process.env.LIFECYCLE_BROWSER_URL || 'http://127.0.0.1:5173');
    if (baseUrl.protocol !== 'http:' || baseUrl.hostname !== '127.0.0.1') {
      throw new Error('浏览器测试仅允许本机回环地址');
    }
    const { chromium } = require('playwright-core');
    logger.info('连接专用临时浏览器');
    browser = await chromium.connectOverCDP(process.env.LIFECYCLE_BROWSER_WS, {
      headers: { Host: '127.0.0.1' },
      timeout: 15000,
    });
    logger.info('创建隔离浏览器上下文');
    context = await browser.newContext({ serviceWorkers: 'block' });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const apiCalls = [];
    const pageErrors = [];
    let authMode = 'normal';
    page.on('pageerror', error => pageErrors.push(error.message));
    const product = { name: '合成测试手机', model: 'MODEL-1', quantity: 1 };
    const order = {
      id: 1,
      order_number: 'W1234567890',
      status: 'payment_received',
      payment_status: 'paid',
      pickup_status: 'not_ready',
      products: [product],
      official_products: [
        { ...product, status: 'PAYMENT_RECEIVED', fulfillmentMessage: '合成履约提示' },
      ],
      official_raw_status: 'PAYMENT_RECEIVED',
      official_status_observed_at: '2026-09-09T00:00:00Z',
      official_payment_expires_at: '2026-09-09T00:30:00Z',
      official_fulfillment_message: '合成履约提示',
      official_order_amount: '8999.00',
      official_order_amount_currency: 'CNY',
      payment_method: '支付宝',
      validation_status: 'abnormal',
      validation_issues: [
        {
          type: 'source_conflict',
          field: 'products.0.quantity',
          sourceValue: 2,
          officialValue: 1,
          resolution: 'official',
          message: '商品数量与官网不一致，已采用官网值',
        },
      ],
      created_at: '2026-09-09T00:00:00Z',
      refresh: { freshness_status: 'fresh' },
    };
    await page.route('**/*', async route => {
      const request = route.request();
      try {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/')) {
          apiCalls.push({ path: url.pathname, method: request.method(), query: url.search });
          let data;
          if (url.pathname === '/api/auth/me' && authMode === 'expired') {
            await route.fulfill({
              status: 401,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED' } }),
            });
            return;
          }
          if (url.pathname === '/api/auth/me')
            data = {
              id: 1,
              username: 'synthetic',
              role: 'readOnly',
              forcePasswordChange: authMode === 'force-change',
              permissions: ['orders.read'],
              availableHome: '/orders',
            };
          else if (url.pathname === '/api/orders/filter-options')
            data = { productModels: [], stores: [], recipients: [], payers: [] };
          else if (url.pathname === '/api/orders') data = { orders: [order], total: 1 };
          else if (url.pathname === '/api/orders/1') data = order;
          else if (url.pathname === '/api/system/auto-refresh')
            data = { isRunning: false, isPaused: false };
          else {
            logger.warn('未配置的合成 API 路径', { path: url.pathname });
            await route.fulfill({
              status: 404,
              contentType: 'application/json',
              body: JSON.stringify({ success: false }),
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data }),
          });
        } else if (url.origin === baseUrl.origin) await route.continue();
        else await route.abort();
      } catch (error) {
        pageErrors.push(error.message);
      }
    });
    await context.addInitScript(() => {
      if (sessionStorage.getItem('synthetic-anonymous') !== 'true') {
        localStorage.setItem('token', 'synthetic-not-a-real-token');
      }
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    logger.info('验证合成订单列表');
    await page.goto(`${baseUrl.origin}/orders`, { waitUntil: 'networkidle' });
    const selector = 'button[aria-label="查看 1 项订单冲突"]';
    await page.waitForSelector(selector);
    assert.equal(await page.$eval(selector, button => button.closest('td').cellIndex), 0);
    await page.hover(selector);
    await page.waitForSelector('[role="tooltip"]');
    assert.match(
      await page.$eval('[role="tooltip"]', node => node.textContent),
      /导入：2；官网：1/
    );
    await page.screenshot({ path: '/tmp/lifecycle-order-list.png', fullPage: true });
    await page.focus(selector);
    await page.keyboard.press('Escape');
    assert.equal(await page.$('[role="tooltip"]'), null);
    const options = await page.$$eval('select option', nodes => nodes.map(node => node.value));
    for (const status of ['payment_due', 'payment_received', 'picked_up', 'payment_expired'])
      assert.ok(options.includes(status));
    assert.equal(await page.$('button[title="刷新订单"]'), null);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => document.querySelector('aside').getBoundingClientRect().right <= 0
    );
    logger.info('验证窄屏点击提示');
    await page.click(selector);
    await page.waitForSelector('[role="tooltip"]');
    const bounds = await page.$eval('[role="tooltip"]', node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= 390 && bounds.top >= 0 && bounds.bottom <= 844);
    await page.screenshot({ path: '/tmp/lifecycle-order-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl.origin}/orders/1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.textContent.includes('官网状态与来源核对'));
    const detail = await page.$eval('body', node => node.textContent);
    assert.match(detail, /PAYMENT_RECEIVED/);
    assert.match(detail, /尚未准备就绪/);
    assert.match(detail, /合成履约提示/);
    assert.match(detail, /导入：2；官网：1/);
    await page.screenshot({ path: '/tmp/lifecycle-order-detail.png', fullPage: true });
    // 升级路由库后，深链接、客户端导航、越权回退与认证跳转必须保持原契约。
    await page.locator('a[href="/orders"]').first().click();
    await page.waitForSelector(selector);
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.textContent.includes('官网状态与来源核对'));
    await page.goto(`${baseUrl.origin}/users`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => location.pathname === '/orders');
    assert.equal(apiCalls.filter(call => call.path === '/api/users').length, 0);
    authMode = 'force-change';
    await page.goto(`${baseUrl.origin}/orders`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => location.pathname === '/change-password');
    authMode = 'expired';
    await page.goto(`${baseUrl.origin}/orders`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => location.pathname === '/login');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('synthetic-anonymous', 'true');
    });
    authMode = 'normal';
    await page.goto(`${baseUrl.origin}/orders`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => location.pathname === '/login');
    assert.equal(
      apiCalls.filter(call => call.method !== 'GET' || /page-open-refresh/.test(call.path)).length,
      0
    );
    assert.deepEqual(pageErrors, []);
    logger.info('生命周期浏览器开发自测通过', {
      checks: [
        '行首图标',
        '悬停差异',
        '键盘关闭',
        '新状态筛选',
        '只读账号',
        '窄屏浮层',
        '详情字段',
        '页面无自动刷新',
        '客户端导航与后退',
        '越权路由回退',
        '强制改密跳转',
        '过期会话跳转',
        '未登录跳转',
      ],
      mockedApiCalls: apiCalls.length,
    });
  } catch (error) {
    if (page) await page.screenshot({ path: '/tmp/lifecycle-browser-failure.png' });
    logger.error('生命周期浏览器开发自测失败', { error: error.message });
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

main();
