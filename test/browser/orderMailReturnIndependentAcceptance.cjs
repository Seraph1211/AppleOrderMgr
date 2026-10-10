/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成响应遵循订单 API 契约 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const BASE_URL = process.env.RETURN_BROWSER_URL || 'http://127.0.0.1:5410';
const OUTPUT = process.env.RETURN_QA_OUTPUT || '/tmp/mail-return-independent-qa';

/** 在隔离浏览器中独立检查邮件退货状态，不访问真实业务 API。 */
async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    fs.mkdirSync(OUTPUT, { recursive: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-return-qa'));
    const page = await context.newPage();
    const errors = [];
    const queries = [];
    const checks = [];
    const orders = ['partially_return_requested', 'return_requested'].map((status, index) => ({
      id: index + 101,
      order_number: `W700000000${index}`,
      email_order_status: status,
      display_order_status: status,
      email_payment_status: 'paid',
      email_status_needs_review: index === 0,
      official_order_status: 'PICKED_UP',
      products: [{ name: 'iPhone 18 Pro Max 1TB 冰川蓝色', quantity: 2 }],
      email_status_evidence_at: '2026-10-10T05:55:45Z',
      email_lifecycle_updated_at: '2026-10-10T05:56:00Z',
    }));
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === BASE_URL) await route.continue();
          else await route.abort();
          return;
        }
        let data;
        if (url.pathname === '/api/auth/me') {
          data = {
            id: 1,
            username: '独立退货验收',
            role: 'readOnly',
            permissions: ['orders.read', 'orders.export'],
            availableHome: '/orders',
          };
        } else if (url.pathname === '/api/orders/filter-options') {
          data = {
            productOptions: [],
            recipientTags: [],
            stores: [],
            payers: [],
            officialOrderStatuses: ['PICKED_UP'],
          };
        } else if (url.pathname === '/api/orders') {
          queries.push(Object.fromEntries(url.searchParams));
          data = { total: orders.length, orders };
        } else if (/^\/api\/orders\/10[12]\/devices$/.test(url.pathname)) {
          data = { items: [] };
        } else if (/^\/api\/orders\/10[12](\/link)?$/.test(url.pathname)) {
          data = orders.find(order => url.pathname.includes(`/${order.id}`));
        } else {
          throw new Error(`非预期 API ${route.request().method()} ${url.pathname}`);
        }
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    for (const width of [1440, 768, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 950 });
      await page.goto(`${BASE_URL}/orders`);
      await page.getByText('W7000000000', { exact: true }).filter({ visible: true }).waitFor();
      assert(
        await page.getByText('部分发起退货', { exact: true }).filter({ visible: true }).count()
      );
      assert(await page.getByText('已发起退货', { exact: true }).filter({ visible: true }).count());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const statusFilter = page.getByRole('button', { name: '邮件订单状态筛选', exact: true });
      if (!(await statusFilter.isVisible())) {
        await page.getByRole('button', { name: /^筛选条件/ }).click();
      }
      await statusFilter.click();
      await page.getByRole('option', { name: '部分发起退货', exact: true }).click();
      await page.getByRole('option', { name: '已发起退货', exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('listbox').count(), 0);
      await page.waitForTimeout(350);
      assert(
        queries.some(query => {
          const statuses = JSON.parse(query.displayOrderStatuses || '[]');
          return (
            statuses.includes('partially_return_requested') && statuses.includes('return_requested')
          );
        })
      );
      if (width === 1440) {
        assert.equal(await page.getByRole('columnheader', { name: /^邮件订单状态/ }).count(), 1);
        assert.equal(await page.getByRole('columnheader', { name: /^订单状态/ }).count(), 0);
      }
      assert.equal(await page.getByRole('button', { name: /刷新邮件状态/ }).count(), 0);
      await page.screenshot({ path: `${OUTPUT}/邮件退货状态-${width}.png`, fullPage: true });
      checks.push({
        viewport: width,
        noOverflow: true,
        labels: true,
        filter: true,
        readOnly: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .getByRole('button', { name: '查看', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    assert(await page.getByText('邮件订单状态', { exact: true }).filter({ visible: true }).count());
    await page.screenshot({ path: `${OUTPUT}/邮件退货状态-详情.png`, fullPage: true });
    await page.getByRole('button', { name: '关闭订单详情', exact: true }).click();
    await page.locator('tbody tr').first().getByRole('checkbox').check();
    await page.getByRole('button', { name: '导出选中订单', exact: true }).click();
    assert.equal(
      await page.getByRole('checkbox', { name: '邮件订单状态', exact: true }).count(),
      1
    );
    assert.equal(await page.getByRole('checkbox', { name: '订单状态', exact: true }).count(), 0);
    await page.screenshot({ path: `${OUTPUT}/邮件退货状态-导出字段.png`, fullPage: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      `${OUTPUT}/browser-result.json`,
      JSON.stringify({ checks, details: true, exportLabels: true, errors }, null, 2)
    );
    process.stdout.write(
      'PASS: 邮件退货状态，五种视口、状态筛选、详情、导出字段、只读权限与页面错误检查\n'
    );
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
