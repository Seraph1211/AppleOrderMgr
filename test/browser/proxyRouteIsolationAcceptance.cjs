/* eslint-env node, browser */
/* eslint-disable camelcase -- 普通账号列表沿用既有API的apple_ids字段 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const createFixture = require('./fixtures/proxyOrdersUiFixture.cjs');
const origin = process.env.PROXY_UI_ORIGIN || 'http://127.0.0.1:5191';
const output = process.env.PROXY_ISOLATION_OUTPUT || 'output/proxy-ui/2026-10-31/本轮验收/路由隔离';

/** 允许图标抗锯齿的极少量像素抖动，不允许布局或文字变化。 */
function comparePixels(left, right, message) {
  const a = PNG.sync.read(left),
    b = PNG.sync.read(right);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let pixels = 0;
  for (let offset = 0; offset < a.data.length; offset += 4)
    if (!a.data.subarray(offset, offset + 4).equals(b.data.subarray(offset, offset + 4))) pixels++;
  assert.ok(pixels <= 12, `${message}: ${pixels} 像素不同`);
  return pixels;
}

/** 对比直接访问与离开代抢后的页面，并保存本轮修改前后截图；仅合成API。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [1440, 390]) {
      for (const path of ['/orders', '/server-monitor', '/apple-ids', '/login']) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const errors = [];
        const fixture = createFixture();
        await context.addInitScript(() => {
          localStorage.setItem('token', 'synthetic-isolation');
          localStorage.setItem(
            'navigation-groups:v1:1',
            JSON.stringify(['orders', 'inventory', 'payments', 'resources', 'messages', 'system'])
          );
        });
        await context.route('**/*', async route => {
          try {
            const url = new URL(route.request().url());
            if (!url.pathname.startsWith('/api/'))
              return url.origin === origin ? await route.continue() : await route.abort();
            let data = { rows: [], count: 0, total: 0, orders: [], apple_ids: [] };
            if (url.pathname === '/api/auth/me')
              data = {
                id: 1,
                username: '合成验收',
                role: 'admin',
                permissions: [
                  'orders.read',
                  'proxy_orders.read',
                  'monitor.manage',
                  'apple_ids.read',
                ],
                availableHome: '/orders',
              };
            else if (url.pathname.startsWith('/api/proxy-orders'))
              data = fixture.handle('GET', url);
            else if (url.pathname.endsWith('/overview'))
              data = { instances: [], rules: [], devices: [], revision: 1 };
            else if (/tags|sources|products|devices/.test(url.pathname)) data = [];
            return await route.fulfill({ json: { success: true, data } });
          } catch (error) {
            errors.push(error.message);
            return route.abort();
          }
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        const capture = async name => {
          await page.locator('h1').first().waitFor();
          await page.mouse.move(0, 899);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(700);
          return page.screenshot({
            path: `${output}/${width}-${path.slice(1)}-${name}.png`,
            animations: 'disabled',
            mask: [page.locator('.app-version')],
            maskColor: '#f8fafc',
          });
        };
        await page.goto(origin + path);
        const direct = await capture('直接访问');
        if (path !== '/login') {
          // 使用历史事件驱动React Router，保留已加载的代抢CSS，检验作用域残留。
          await page.evaluate(() => {
            history.pushState({}, '', '/proxy-orders');
            window.dispatchEvent(new PopStateEvent('popstate'));
          });
          await page.getByRole('heading', { name: '代抢管理', exact: true }).waitFor();
          await page.getByRole('button', { name: '登记代抢', exact: true }).click();
          await page.getByRole('dialog').waitFor();
          await page.evaluate(target => {
            history.pushState({}, '', target);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }, path);
          const after = await capture('离开代抢');
          assert.equal(await page.locator('.proxy-workspace, .proxy-dialog').count(), 0);
          assert.equal(await page.evaluate(() => document.body.style.overflow), '');
          comparePixels(direct, after, `${width} ${path} 离开代抢后画面变化`);
        }
        const baseline = `${output}/${width}-${path.slice(1)}-修改前.png`;
        if (process.env.PROXY_ISOLATION_RECORD === 'true') fs.writeFileSync(baseline, direct);
        else comparePixels(direct, fs.readFileSync(baseline), `${width} ${path} 与修改前不同`);
        assert.deepEqual(errors, []);
        process.stdout.write(`PASS ${width}px ${path} 前后截图/作用域/背景滚动\n`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
