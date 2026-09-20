/* global localStorage */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

/** 使用专用浏览器和全合成 API，验证映射金额展示；不访问真实订单或官网。 */
async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-pricing'));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const amounts = ['21998.00', null, '0.00'];
    const products = [{ name: 'iPhone 18 Pro Max 黑色 256G', quantity: 2 }];
    const orders = amounts.map((amount, index) => ({
      id: index + 1,
      order_number: `W123456789${index}`,
      products:
        index === 1
          ? [{ name: '未映射商品', quantity: 1 }]
          : [{ ...products[0], quantity: index === 2 ? 0 : 2 }],
      order_amount: amount,
      official_order_amount: '888.00',
      status: 'pending',
      order_date: '2026-09-21T01:00:00Z',
      validation_status: 'unavailable',
      payment_status: 'unpaid',
      payment_method: '微信',
      refresh: {},
    }));
    const tasks = amounts.map((amount, index) => ({
      id: index + 1,
      orderId: index + 1,
      orderNumber: `W123456789${index}`,
      products:
        index === 1
          ? [{ name: '未映射商品', quantity: 1 }]
          : [{ ...products[0], quantity: index === 2 ? 0 : 2 }],
      orderAmount: amount,
      officialOrderAmount: '888.00',
      officialOrderStatus: 'pending',
      processingStatus: 'pending',
      officialPaymentStatus: 'unpaid',
      paymentMethod: '微信',
      orderDate: '2026-09-21T01:00:00Z',
      deadlineAt: null,
      version: 0,
      autoAssignment: {},
    }));
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://127.0.0.1:5173') return await route.abort();
        if (!url.pathname.startsWith('/api/')) return await route.continue();
        assert.equal(route.request().method(), 'GET');
        const path = url.pathname;
        let data = {};
        if (path === '/api/auth/me')
          data = {
            id: 1,
            username: 'synthetic',
            role: 'admin',
            availableHome: '/orders',
            permissions: [
              'orders.read',
              'payment_tasks.read_own',
              'payment_tasks.link.read_own',
              'payment_dispatch.read',
              'payment_dispatch.link.read',
            ],
          };
        else if (path === '/api/orders/filter-options')
          data = { productOptions: [], recipientTags: [], stores: [] };
        else if (path === '/api/orders') data = { orders, total: 3 };
        else if (/^\/api\/orders\/\d+$/.test(path))
          data = orders[Number(path.split('/').pop()) - 1];
        else if (path === '/api/system/auto-refresh') data = { isRunning: false };
        else if (path === '/api/payment-dispatch/overview')
          data = { settings: { enabled: false, mode: 'manual', version: 0 }, staff: [] };
        else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(path))
          data = {
            items: tasks,
            pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
            productOptions: [],
            recipientTagOptions: [],
            serverTime: new Date().toISOString(),
          };
        else if (path.endsWith('/payment-code'))
          data = {
            availability: 'missing',
            orderId: 1,
            orderNumber: tasks[0].orderNumber,
            products,
            amount: amounts[0],
            paymentMethod: '微信',
            officialOrderStatus: 'pending',
          };
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    const output = process.env.PRICING_ARTIFACT_DIR || '/tmp/apple-pricing-browser';
    fs.mkdirSync(output, { recursive: true });
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const path of ['orders', 'payment-tasks', 'payment-dispatch']) {
        await page.goto(`http://127.0.0.1:5173/${path}`, { waitUntil: 'networkidle' });
        await page.getByText('¥21,998.00', { exact: true }).waitFor();
        await page.getByText('¥0.00', { exact: true }).waitFor();
        await page.getByText('待确认', { exact: true }).waitFor();
        assert.equal(await page.getByText('按官方售价计算', { exact: true }).count(), 3);
        assert.equal(await page.getByText(/888\.00/).count(), 0);
        if (path === 'payment-tasks')
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
          );
        await page.screenshot({ path: `${output}/${path}-${width}.png`, fullPage: true });
        if (path === 'orders') {
          await page.getByRole('button', { name: '查看', exact: true }).first().click();
          assert.ok((await page.getByText('¥21,998.00', { exact: true }).count()) >= 2);
        } else if (path === 'payment-tasks') {
          await page.getByRole('button', { name: '查看付款码', exact: true }).first().click();
          await page.getByRole('dialog').getByText('¥21,998.00', { exact: true }).waitFor();
        }
      }
      await page.goto('http://127.0.0.1:5173/orders/1', { waitUntil: 'networkidle' });
      await page.getByText('¥21,998.00', { exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    process.stdout.write(`订单金额浏览器验收通过：三页、两种宽度、详情和付款码；截图 ${output}\n`);
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
