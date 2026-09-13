/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const output = '/tmp/apple-order-date-acceptance';
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const mode of ['orders', 'channels/DATE/orders', 'payment-tasks', 'payment-dispatch']) {
      const payment = mode.startsWith('payment-');
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      const queries = [];
      const errors = [];
      const productName = 'iPhone 18 Pro Max 512GB 勃艮第酒红色';
      const tasks = [1, 2].map(id => ({
        id, orderId: 182 + id, orderNumber: `W000000000${id}`,
        order_number: `W000000000${id}`, order_date: '2026-09-13T00:00:00Z',
        products: [{ name: productName, quantity: 1 }, { name: productName, quantity: 1 }],
        paymentMethod: 'WECHAT', recipientTag: 'DATE', status: 'payment_due',
        officialOrderStatus: 'payment_due', officialPaymentStatus: 'unpaid',
        processingStatus: 'pending', version: 0,
      }));
      page.on('pageerror', error => errors.push(error.message));
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-date');
        window.__copy = '';
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async text => { window.__copy = text; },
        } });
      });
      await context.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === 'http://127.0.0.1:5173') await route.continue();
            else await route.abort();
            return;
          }
          const query = Object.fromEntries(url.searchParams);
          queries.push({ path: url.pathname, ...query });
          const filtered = query.dateFrom || query.dateTo ? tasks.slice(0, 1) : tasks;
          let data;
          if (url.pathname === '/api/auth/me') data = { id: 1, role: 'admin', username: '合成验收',
            permissions: ['orders.read', 'orders.export', 'channels.read', 'payment_dispatch.read',
              'payment_dispatch.assign', 'payment_tasks.read_own', 'payment_tasks.link.read_own'],
            availableHome: `/${mode}` };
          else if (url.pathname === '/api/orders/filter-options')
            data = { productModels: [], stores: [], recipients: [], payers: [] };
          else if (url.pathname === '/api/system/auto-refresh') data = { enabled: false };
          else if (url.pathname === '/api/orders/export') {
            await route.fulfill({ body: 'synthetic export', contentType: 'application/octet-stream' });
            return;
          } else if (url.pathname === '/api/orders') data = { orders: filtered, total: filtered.length };
          else if (url.pathname === '/api/channels/DATE/stats')
            data = { channelName: '合成渠道', totalOrders: filtered.length, readyOrders: 0, completedOrders: 0, cancelledOrders: 0 };
          else if (url.pathname === '/api/channels/DATE/orders') data = { items: filtered, total: filtered.length };
          else if (url.pathname === '/api/payment-dispatch/overview')
            data = { settings: { enabled: true, mode: 'auto', version: 0 }, staff: [] };
          else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(url.pathname))
            data = { items: filtered, pagination: { page: 1, limit: 20, total: filtered.length, totalPages: 1 },
              recipientTagOptions: ['DATE'], serverTime: new Date().toISOString() };
          else if (url.pathname.endsWith('/payment-link'))
            data = { paymentUrl: `https://example.com/order/${url.pathname.split('/').at(-2)}` };
          else throw new Error(`未预期接口 ${url.pathname}`);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) { errors.push(error.message); await route.abort(); }
      });
      await page.goto(`http://127.0.0.1:5173/${mode}`);
      await page.getByText('W0000000002', { exact: true }).first().waitFor();
      await page.getByLabel('下单开始日期', { exact: true }).fill('2026-09-13');
      await page.getByLabel('下单结束日期', { exact: true }).fill('2026-09-13');
      if (payment) await page.getByRole('button', { name: '筛选', exact: true }).click();
      await page.waitForFunction(() => !document.body.innerText.includes('W0000000002'));
      const listPath = `/api/${mode === 'payment-dispatch' ? 'payment-dispatch/tasks' : mode}`;
      const latest = () => queries.filter(query => query.path === listPath).at(-1);
      assert.equal(latest().dateFrom, '2026-09-13');
      assert.equal(latest().dateTo, '2026-09-13');
      assert.equal(latest().page, '1');
      if (mode.startsWith('channels/')) {
        const stats = queries.filter(query => query.path.endsWith('/stats')).at(-1);
        assert.equal(stats.dateFrom, latest().dateFrom);
        assert.equal(stats.dateTo, latest().dateTo);
      }
      if (mode === 'orders') {
        await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: '导出', exact: true }).click(),
        ]);
        const exported = queries.filter(query => query.path.endsWith('/export')).at(-1);
        assert.equal(exported.dateFrom, latest().dateFrom);
        assert.equal(exported.dateTo, latest().dateTo);
      }
      if (payment) {
        await page.getByRole('button', { name: mode === 'payment-tasks' ? '复制订单信息' : '复制订单信息 W0000000001', exact: true }).click();
        await page.waitForFunction(() => window.__copy.length > 0);
        assert.equal(await page.evaluate(() => window.__copy), `183 || ${productName} x 2 || 微信 || https://example.com/order/1`);
      }
      await page.screenshot({ path: `${output}/${mode.replaceAll('/', '-')}-desktop.png`, fullPage: true, animations: 'disabled' });
      await page.getByRole('button', { name: '清空日期', exact: true }).click();
      if (payment) await page.getByRole('button', { name: '筛选', exact: true }).click();
      await page.getByText('W0000000002', { exact: true }).first().waitFor();
      assert.ok(!latest().dateFrom && !latest().dateTo);
      if (payment) {
        for (const id of [1, 2]) await page.getByRole('checkbox', { name: `选择订单 W000000000${id}`, exact: true }).check();
        await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
        await page.waitForFunction(() => window.__copy.includes('\n\n'));
        const copied = await page.evaluate(() => window.__copy);
        assert.equal(copied, `183 || ${productName} x 2 || 微信 || https://example.com/order/1\n\n184 || ${productName} x 2 || 微信 || https://example.com/order/2`);
      }
      await page.setViewportSize({ width: 375, height: 812 });
      if (mode === 'payment-tasks') await page.getByRole('button', { name: '筛选任务', exact: true }).click();
      await page.getByLabel('下单结束日期', { exact: true }).fill('2026-09-13');
      await page.getByLabel('下单结束日期', { exact: true }).scrollIntoViewIfNeeded();
      const inputBox = await page.getByLabel('下单结束日期', { exact: true }).boundingBox();
      assert.ok(inputBox.x >= 0 && inputBox.x + inputBox.width <= 375);
      assert.ok(inputBox.width >= 130, '手机日期输入框必须保持可读宽度');
      await page.screenshot({ path: `${output}/${mode.replaceAll('/', '-')}-mobile.png`, fullPage: true, animations: 'disabled' });
      if (payment) await page.getByRole('button', { name: '筛选', exact: true }).click();
      await page.waitForFunction(() => !document.body.innerText.includes('W0000000002'));
      assert.equal(latest().dateTo, '2026-09-13');
      assert.ok(!latest().dateFrom);
      assert.deepEqual(errors, []);
      await context.close();
    }
    process.stdout.write('PASS: 四页日期传参/清空/375px操作、渠道统计、导出及两付款页单条/批量合并复制\n');
  } finally { await browser.close(); }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
