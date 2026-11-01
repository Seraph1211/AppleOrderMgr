/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const createFixture = require('./fixtures/proxyOrdersUiFixture.cjs');
const { PERMISSIONS } = require('../../src/constants/business');
const before = process.env.LOG_QUERY_BASELINE || 'http://127.0.0.1:5196';
const after = process.env.LOG_QUERY_ORIGIN || 'http://127.0.0.1:5195';
const output = 'output/log-query-implementation/isolation';

/** 最新main原版与重构版同数据像素对比；完整保留外壳，版本号使用同一合成值。 */
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const evidence = [];
  try {
    for (const width of [1440, 390]) {
      for (const path of [
        '/orders',
        '/proxy-orders',
        '/server-monitor',
        '/stock',
        '/users',
        '/inventory-monitor/manage?tab=settings',
        '/profile',
        '/login',
      ]) {
        const images = [];
        for (const [label, origin] of [
          ['before', before],
          ['after', after],
        ]) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            timezoneId: 'Asia/Shanghai',
          });
          const errors = [];
          const fixture = createFixture();
          await context.addInitScript(() => {
            localStorage.setItem('token', 'synthetic-ui-isolation');
            localStorage.setItem(
              'navigation-groups:v1:1',
              JSON.stringify(['orders', 'inventory', 'payments', 'resources', 'messages', 'system'])
            );
          });
          await context.route('**/api/**', async route => {
            try {
              const url = new URL(route.request().url());
              if (!url.pathname.startsWith('/api/')) return route.continue();
              let data = { rows: [], items: [], count: 0, total: 0, orders: [], apple_ids: [] };
              if (url.pathname === '/api/auth/me')
                data = {
                  id: 1,
                  username: '隔离验收',
                  role: 'admin',
                  permissions: Object.values(PERMISSIONS),
                  availableHome: '/orders',
                };
              else if (url.pathname === '/api/users')
                data = { users: [], total: 0, page: 1, limit: 10 };
              else if (url.pathname.startsWith('/api/proxy-orders'))
                data = fixture.handle('GET', url);
              else if (url.pathname === '/api/orders/filter-options')
                data = {
                  productOptions: [],
                  productModels: [],
                  stores: [],
                  recipientTags: [],
                  sourceTags: [],
                };
              else if (url.pathname === '/api/server-monitor/overview')
                data = { instances: [], rules: [], devices: [], revision: 1 };
              else if (url.pathname === '/api/server-monitor/traffic')
                data = {
                  devices: [],
                  buckets: [],
                  rows: [],
                  totals: { rxBytes: 0, txBytes: 0 },
                  summary: { rxBytes: 0, txBytes: 0 },
                };
              else if (url.pathname === '/api/server-monitor/logs/states')
                data = { devices: [], instances: [], today: '2026-11-01', first: '2026-08-04' };
              else if (url.pathname.endsWith('/ledger/catalog'))
                data = { products: [], warehouses: [], people: [], enabled: true };
              else if (url.pathname === '/api/inventory/settings')
                data = {
                  version: 1,
                  hasWebhook: false,
                  config: {
                    enabled: false,
                    intervalSeconds: 60,
                    notificationsEnabled: false,
                    notificationFilters: {},
                    groupName: '',
                    silentStart: '00:00',
                    silentEnd: '00:00',
                  },
                };
              else if (/filter-options|catalog|settings|profile|preferences/.test(url.pathname))
                data = {
                  products: [],
                  stores: [],
                  warehouses: [],
                  people: [],
                  items: [],
                  rows: [],
                  enabled: true,
                };
              else if (/tags|sources|devices|stores/.test(url.pathname)) data = [];
              await route.fulfill({ json: { success: true, data } });
            } catch (error) {
              errors.push(error.message);
              await route.abort();
            }
          });
          const page = await context.newPage();
          page.on('pageerror', e => errors.push(e.message));
          await page.goto(origin + path);
          await page.locator('main, form').first().waitFor();
          if (label === 'after' && path !== '/login') {
            // 先加载日志专属CSS，再返回原页，核对样式不会残留污染。
            await page.evaluate(() => {
              history.pushState({}, '', '/server-monitor/logs');
              window.dispatchEvent(new PopStateEvent('popstate'));
            });
            await page.getByRole('heading', { name: '日志查询', exact: true }).waitFor();
            await page.evaluate(destination => {
              history.pushState({}, '', destination);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }, path);
            await page.locator('main, form').first().waitFor();
          }
          await page.evaluate(async () => {
            await document.fonts.ready;
            const version = document.querySelector('.app-version');
            if (version) version.textContent = 'v20261101-验收';
          });
          await page.mouse.move(0, 899);
          await page.waitForTimeout(500);
          const name = `${width}-${path.slice(1).replace(/[/?=]/g, '-')}-${label}`;
          const image = await page.screenshot({
            path: `${output}/${name}.png`,
            animations: 'disabled',
          });
          images.push(PNG.sync.read(image));
          assert.deepEqual(errors, [], `${name}:页面错误`);
          await context.close();
        }
        let pixels = 0;
        for (let i = 0; i < images[0].data.length; i += 4)
          if (!images[0].data.subarray(i, i + 4).equals(images[1].data.subarray(i, i + 4)))
            pixels++;
        evidence.push({ width, path, pixels });
        assert.ok(pixels <= 12, `${width} ${path}: ${pixels}像素变化`);
      }
    }
    fs.writeFileSync(`${output}/results.json`, JSON.stringify({ passed: true, evidence }, null, 2));
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
