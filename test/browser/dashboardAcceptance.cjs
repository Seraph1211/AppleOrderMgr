/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright-core');

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-dashboard-only'));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const requests = [];
    const writes = [];
    let fail = false;
    let delayOld = false;
    const productName = 'iPhone 18 Pro Max 勃艮第酒红色 256G';
    const key = `sku:TEST1CH/A:${'a'.repeat(64)}`;
    const products = [
      { key, name: productName, value: 3 },
      { key: 'second', name: 'iPhone 18 Pro Max 冰川蓝色 512G', value: 2 },
    ];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        if (route.request().method() !== 'GET') writes.push(url.pathname);
        let data = {};
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: '合成验收',
            role: 'operator',
            permissions: ['dashboard.read'],
            availableHome: '/',
          };
        else if (url.pathname.startsWith('/api/dashboard/')) {
          const query = Object.fromEntries(url.searchParams);
          requests.push({ path: url.pathname, query });
          const tags = JSON.parse(query.recipientTags || '[]');
          const statuses = JSON.parse(query.emailOrderStatuses || '[]');
          const zero = statuses.includes('confirmed');
          const count = zero ? 0 : tags.length ? 3 : 5;
          if (delayOld && !tags.length) await new Promise(resolve => setTimeout(resolve, 600));
          if (fail) {
            await route.fulfill({ status: 503, json: { error: { message: '合成查询失败' } } });
            return;
          }
          if (url.pathname.endsWith('/stats'))
            data = {
              totalOrders: count,
              paidOrders: zero ? 0 : count - 1,
              totalAmount: count * 9999,
              availableRecipients: tags.length ? 2 : 16,
              missingAmountOrders: 1,
              orderGrowth: 0,
              amountGrowth: null,
            };
          if (url.pathname.endsWith('/daily-trend'))
            data = [
              { date: '2026-09-22', count: 1 },
              { date: '2026-09-23', count: count - 1 },
            ];
          if (url.pathname.endsWith('/product-distribution')) data = zero ? [] : products;
          if (url.pathname.endsWith('/city-distribution'))
            data = zero
              ? []
              : [
                  { name: '北京', value: count - 1 },
                  { name: '天津', value: 1 },
                ];
          if (url.pathname.endsWith('/filter-options'))
            data = {
              productOptions: [
                { value: key, label: productName, keys: [key], aliases: [productName], count },
              ],
              recipientTags: ['团队A', '团队B'],
            };
        }
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
      }
    });
    await page.goto('http://127.0.0.1:5173/');
    const metric = name =>
      page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await metric('订单总数').getByText('5', { exact: true }).waitFor();
    for (const title of [
      '订单总数',
      '已付款订单数',
      '订单总金额',
      '可用取机人',
      '商品分布',
      '城市分布',
    ])
      assert.equal(await page.getByRole('heading', { name: title, exact: true }).count(), 1);
    await page.getByRole('button', { name: '取机人 TAG 筛选' }).click();
    await page.getByRole('option', { name: '团队A', exact: true }).click();
    await page.keyboard.press('Escape');
    await metric('可用取机人').getByText('2', { exact: true }).waitFor();
    await page.getByRole('button', { name: '商品信息筛选' }).click();
    await page.getByRole('option').filter({ hasText: productName }).click();
    await page.keyboard.press('Escape');
    await metric('订单总数').getByText('3', { exact: true }).waitFor();
    for (const suffix of [
      'stats',
      'daily-trend',
      'product-distribution',
      'city-distribution',
      'filter-options',
    ]) {
      assert(
        requests.some(
          item =>
            item.path.endsWith(`/${suffix}`) &&
            item.query.productKeys === JSON.stringify([key]) &&
            item.query.recipientTags === '["团队A"]'
        )
      );
    }
    await page.getByLabel('下单开始日期').fill('2026-09-01');
    await metric('订单总数').getByText('3', { exact: true }).waitFor();
    assert(requests.some(item => item.query.startDate === '2026-09-01'));
    await page.screenshot({
      path: 'test-artifacts/dashboard-20260923/desktop.png',
      fullPage: true,
    });
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(350);
      await page.getByRole('heading', { name: '城市分布', exact: true }).waitFor();
      if (!(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))) {
        await page.screenshot({
          path: 'test-artifacts/dashboard-20260923/overflow.png',
          fullPage: true,
        });
        process.stdout.write(
          JSON.stringify(
            await page.evaluate(() =>
              [...document.querySelectorAll('*')]
                .filter(element => element.getBoundingClientRect().right > window.innerWidth)
                .slice(0, 16)
                .map(element => ({
                  tag: element.tagName,
                  class: element.className,
                  right: element.getBoundingClientRect().right,
                }))
            )
          )
        );
        throw new Error(`横向溢出 ${width}`);
      }
      if (width === 375)
        await page.screenshot({
          path: 'test-artifacts/dashboard-20260923/mobile.png',
          fullPage: true,
        });
    }
    await page.getByRole('button', { name: '邮件订单状态筛选' }).click();
    await page.getByRole('option', { name: '订单已确认', exact: true }).click();
    await page.keyboard.press('Escape');
    await metric('订单总数').getByText('0', { exact: true }).waitFor();
    assert.equal(await page.getByText('暂无符合条件的订单', { exact: true }).count(), 3);
    fail = true;
    await page.getByRole('button', { name: '重置筛选', exact: true }).click();
    await page.getByRole('alert').waitFor();
    fail = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await metric('订单总数').getByText('5', { exact: true }).waitFor();
    delayOld = true;
    await page.getByRole('button', { name: '重置筛选', exact: true }).click();
    await page.getByRole('button', { name: '取机人 TAG 筛选' }).click();
    await page.getByRole('option', { name: '团队A', exact: true }).click();
    await page.keyboard.press('Escape');
    await metric('订单总数').getByText('3', { exact: true }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(await metric('订单总数').getByText('3', { exact: true }).count(), 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    await fs.writeFile(
      'test-artifacts/dashboard-20260923/browser-result.json',
      JSON.stringify(
        {
          passed: true,
          viewports: [320, 375, 768, 1440],
          scenarios: [
            'filters',
            'tag-metric',
            'full-product',
            'date',
            'empty',
            'error-retry',
            'stale-response',
          ],
          requests: requests.length,
          errors,
          writes,
        },
        null,
        2
      )
    );
    process.stdout.write('仪表板合成浏览器验收通过\n');
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
