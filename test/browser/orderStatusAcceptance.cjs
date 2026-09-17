/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成响应遵循订单 API 的 snake_case 契约 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const errors = [];
    const queries = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-order-status'));
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: '合成状态验收',
            role: 'readOnly',
            permissions: ['orders.read'],
            availableHome: '/orders',
          };
        else if (url.pathname === '/api/orders/filter-options')
          data = { productNames: [], stores: [] };
        else if (url.pathname === '/api/system/auto-refresh') data = { isRunning: false };
        else if (url.pathname === '/api/orders') {
          queries.push(url.searchParams.get('statuses'));
          data = {
            total: 3,
            orders: ['pending', 'unknown', 'completed'].map((status, index) => ({
              id: index + 1,
              order_number: `W722222222${index}`,
              status,
              products: [{ name: '合成商品', quantity: 1 }],
              validation_status: 'valid',
            })),
          };
        } else throw new Error(`未预期请求 ${url.pathname}`);
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    await page.goto('http://127.0.0.1:5173/orders');
    await page.getByText('W7222222220', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('columnheader', { name: '官网状态', exact: true }).count(),
      1
    );
    for (const [index, label] of [
      [0, '待处理'],
      [1, 'unknown'],
      [2, 'unknown'],
    ]) {
      assert(
        await page
          .locator('tbody tr')
          .filter({ hasText: `W722222222${index}` })
          .getByText(label, { exact: true })
          .isVisible()
      );
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByRole('button', { name: '官网状态筛选', exact: true }).click();
      const options = page.getByRole('listbox');
      assert.equal(await options.getByRole('option').count(), 12);
      assert.equal(await options.getByRole('option', { name: /历史|已完成/ }).count(), 0);
      await options.getByRole('option', { name: 'unknown', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.screenshot({ path: `/tmp/apple-order-status-${width}.png`, fullPage: true });
    }
    assert(queries.some(query => query === '["unknown"]'));
    assert.deepEqual(errors, []);
    process.stdout.write(
      'PASS: 订单页官网状态列、pending/unknown文案、非法值兜底、12项多选与桌面/390px\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
