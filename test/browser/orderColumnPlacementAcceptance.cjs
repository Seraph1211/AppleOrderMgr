/* eslint-env node, browser */
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

/** 验证默认及旧偏好升级后的取货信息／实际取货日期列位置。 */
async function main() {
  const { ordersColumns } = await import(pathToFileURL(path.resolve(__dirname, '../../frontend/src/constants/tableColumns.js')));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const legacy of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
      const saved = ordersColumns.map((column, order) => ({ key: column.key, visible: legacy ? column.key !== 'recipientName' : column.defaultVisible, order }));
      const actual = saved.splice(saved.findIndex(column => column.key === 'actualPickupDate'), 1)[0];
      saved.splice(2, 0, actual);
      saved.forEach((column, order) => { column.order = order; });
      await context.addInitScript(({ legacy, saved }) => {
        localStorage.setItem('token', 'synthetic-column');
        if (legacy) localStorage.setItem('columnConfig:orders', JSON.stringify({ officialStatusVersion: 1, actualPickupDateVersion: 1, columns: saved }));
      }, { legacy, saved });
      await context.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === 'http://127.0.0.1:5173') await route.continue(); else await route.abort();
            return;
          }
          let data;
          if (url.pathname === '/api/auth/me') data = { id: 1, role: 'operator', username: '列顺序验收', permissions: ['orders.read'], availableHome: '/orders' };
          else if (url.pathname === '/api/orders/filter-options') data = { productOptions: [], recipientTags: [], stores: [], payers: [], officialOrderStatuses: [] };
          else if (url.pathname === '/api/orders') data = { orders: [{ id: 1, order_number: 'W0000000001', products: [], actual_pickup_date: '2026-10-08' }], total: 1 };
          else { await route.abort(); return; }
          await route.fulfill({ json: { success: true, data } });
        } catch (error) { await route.abort(); throw error; }
      });
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:5173/orders');
      await page.getByRole('columnheader', { name: '实际取货日期', exact: true }).waitFor();
      const headers = await page.getByRole('columnheader').allTextContents();
      assert.equal(headers[headers.findIndex(value => value.includes('取货信息')) + 1].trim(), '实际取货日期');
      if (legacy) {
        assert(!headers.some(value => value.trim() === '取机人'));
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('columnConfig:orders')).actualPickupDateVersion), 2);
        await page.reload();
        await page.getByRole('columnheader', { name: '实际取货日期', exact: true }).waitFor();
        const after = await page.getByRole('columnheader').allTextContents();
        assert.deepEqual(after, headers);
      }
      await context.close();
    }
    process.stdout.write('PASS: 默认／旧列偏好位置、隐藏偏好及刷新稳定性\n');
  } finally { await browser.close(); }
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
