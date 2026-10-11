/* eslint-env node, browser */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const base = process.env.PICKUP_RETIREMENT_BASE_URL || 'http://127.0.0.1:5333';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(10000);
      const calls = [];
      const errors = [];
      let permissions = ['orders.read', 'stock.read', 'pickups.read'];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('token', 'synthetic-retirement'));
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) return route.continue();
        calls.push(url.pathname);
        let data = {};
        if (url.pathname === '/api/auth/me') {
          data = {
            id: 1,
            role: 'operator',
            username: '合成验收',
            permissions,
            availableHome: '/profile',
          };
        } else if (url.pathname.endsWith('/ledger/catalog')) {
          data = { enabled: true, products: [], warehouses: [], people: [] };
        } else if (url.pathname.endsWith('/ledger')) {
          data = { items: [], total: 0, counts: { pending: 0, inStock: 0, sold: 0, returned: 0 } };
        } else if (url.pathname === '/api/orders/123') {
          data = {
            id: 123,
            order_number: 'W9700000123',
            products: [],
            display_order_status: 'picked_up',
          };
        } else if (url.pathname === '/api/pickups') {
          data = {
            items: [
              {
                orderId: 123,
                orderNumber: 'W9700000123',
                evidence: [
                  {
                    id: 'photo',
                    kind: 'pickup',
                    originalName: '合成照片.png',
                    contentType: 'image/png',
                  },
                ],
              },
            ],
            total: 1,
          };
        } else if (url.pathname === '/api/pickups/123/evidence/photo') {
          data = {
            url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
          };
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      await page.goto(`${base}/pickups?search=123`);
      await page.waitForURL(url => url.pathname === '/stock');
      await page.getByRole('heading', { name: '库存管理', exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: '取货记录', exact: true }).count(), 0);
      assert.equal(
        calls.some(path => path.startsWith('/api/pickups')),
        false
      );
      await page.goto(`${base}/orders/123`);
      await page.getByRole('button', { name: '查看照片 合成照片.png' }).click();
      await page.getByRole('dialog', { name: '取货照片' }).waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector('[role="dialog"] img');
        return image?.complete && image.naturalWidth > 0;
      });
      assert.equal(await page.getByRole('button', { name: '查看取货记录' }).count(), 0);
      await page.getByRole('button', { name: '关闭取货照片' }).click();
      permissions = ['pickups.read', 'pickups.edit', 'pickups.export'];
      calls.length = 0;
      await page.goto(`${base}/pickups`);
      await page.waitForURL(url => url.pathname === '/profile');
      assert.equal(
        calls.some(path => path.startsWith('/api/stock')),
        false
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
    process.stdout.write(
      'PASS: 1440/375 旧地址跳转、菜单移除、照片读取预览、无库存权限隔离，无页面异常。\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
