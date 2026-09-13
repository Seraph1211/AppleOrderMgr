/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const output = '/tmp/apple-payment-status-acceptance';
  fs.mkdirSync(output, { recursive: true });
  try {
    const badgeClasses = [];
    for (const mode of ['payment-tasks', 'payment-dispatch']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      const queries = [];
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const tasks = Array.from({ length: 42 }, (_, i) => ({
        id: i + 1, orderId: i + 100, orderNumber: `W${String(i + 1).padStart(10, '0')}`,
        products: [{ name: '合成手机', quantity: 1 }], recipientTag: 'TAG-A',
        officialOrderStatus: ['payment_due', 'payment_received', 'cancelled'][i % 3],
        officialPaymentStatus: i % 3 === 1 ? 'paid' : 'unpaid',
        processingStatus: 'pending', version: 0,
      }));
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-status'));
      await context.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === 'http://127.0.0.1:5173') await route.continue();
            else await route.abort();
            return;
          }
          let data;
          if (url.pathname === '/api/auth/me') data = { id: 1,
            role: mode === 'payment-dispatch' ? 'admin' : 'operator', username: '合成验收',
            permissions: ['payment_dispatch.read', 'payment_dispatch.assign',
              'payment_tasks.read_own', 'payment_tasks.link.read_own'], availableHome: `/${mode}` };
          else if (url.pathname === '/api/payment-dispatch/overview')
            data = { settings: { enabled: true, mode: 'auto', version: 0 }, staff: [] };
          else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(url.pathname)) {
            const statuses = JSON.parse(url.searchParams.get('officialOrderStatuses') || '[]');
            const pageNo = Number(url.searchParams.get('page') || 1);
            const limit = Number(url.searchParams.get('limit') || 20);
            queries.push({ statuses, page: pageNo });
            const filtered = tasks.filter(t => !statuses.length || statuses.includes(t.officialOrderStatus));
            data = { items: filtered.slice((pageNo - 1) * limit, pageNo * limit),
              pagination: { page: pageNo, limit, total: filtered.length, totalPages: Math.ceil(filtered.length / limit) },
              recipientTagOptions: ['TAG-A', 'constructor'], serverTime: new Date().toISOString() };
          } else throw new Error(`未预期请求 ${url.pathname}`);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) { errors.push(error.message); await route.abort(); }
      });
      await page.goto(`http://127.0.0.1:5173/${mode}`);
      await page.getByText('W0000000001', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'TAG 筛选', exact: true }).click();
      await page.getByPlaceholder('搜索 TAG').fill('constructor');
      await page.getByRole('option', { name: 'constructor', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '重置', exact: true }).click();
      await page.getByText('W0000000001', { exact: true }).waitFor();

      const paidRow = page.locator('tbody tr').filter({ hasText: 'W0000000002' }).first();
      badgeClasses.push(await paidRow.locator('span.rounded-md').first().getAttribute('class'));
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.getByText('W0000000021', { exact: true }).waitFor();
      const filter = page.getByRole('button', { name: '官网状态筛选', exact: true });
      await filter.click();
      await page.getByPlaceholder('搜索 官网状态').fill('付款');
      await page.getByRole('option', { name: '等待付款', exact: true }).click();
      await page.getByPlaceholder('搜索 官网状态').fill('');
      await page.getByRole('option', { name: '官网已收款', exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal(await filter.getAttribute('aria-expanded'), 'false');
      assert.equal(queries.at(-1).page, 2);
      await page.getByRole('button', { name: '筛选', exact: true }).click();
      await page.getByText('W0000000001', { exact: true }).waitFor();
      assert.deepEqual(queries.at(-1), { statuses: ['payment_due', 'payment_received'], page: 1 });
      assert.equal(await page.getByText('W0000000003', { exact: true }).count(), 0);
      await filter.click();
      await page.getByRole('button', { name: '清空选择', exact: true }).click();
      await page.getByRole('option', { name: '可取货', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '筛选', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('tbody tr input[type="checkbox"]').length === 0);
      await filter.click();
      await page.getByRole('option', { name: '等待付款', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '重置', exact: true }).click();
      await page.getByText('W0000000001', { exact: true }).waitFor();
      assert.deepEqual(queries.at(-1).statuses, []);
      await filter.click();
      await page.screenshot({ path: `${output}/${mode}-desktop.png`, fullPage: true, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 375, height: 812 });
      if (mode === 'payment-tasks') await page.getByRole('button', { name: '筛选任务', exact: true }).click();
      await filter.click();
      await page.getByRole('option', { name: '等待付款', exact: true }).click();
      await page.getByRole('option', { name: '官网已收款', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '筛选', exact: true }).click();
      await page.getByText('W0000000001', { exact: true }).waitFor();
      assert.deepEqual(queries.at(-1).statuses, ['payment_due', 'payment_received']);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `${output}/${mode}-mobile.png`, fullPage: true, animations: 'disabled' });
      assert.deepEqual(errors, []);
      await context.close();
    }
    assert.equal(badgeClasses[0], badgeClasses[1]);
    process.stdout.write('PASS: 两页官网状态多选、搜索、OR、分页归一、空结果后可选、清空重置、标签一致、375px操作\n');
  } finally { await browser.close(); }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
