/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

/** 合成浏览器验证六组全选、搜索后全选和官网状态组合，不触发生产业务。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const output = process.env.FILTER_OUTPUT || '/tmp/order-filter-select-all';
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const width of [375, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-filter-all'));
      const queries = [];
      const errors = [];
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
              role: 'operator',
              username: '筛选功能验收',
              permissions: ['orders.read'],
              availableHome: '/orders',
            };
          else if (url.pathname === '/api/orders/filter-options')
            data = {
              productOptions: ['iPhone 18 Pro', 'iPhone 18 Pro Max', 'iPhone 17'].map(
                (label, index) => ({
                  value: `name:${String(index + 1).repeat(64)}`,
                  label,
                  count: 1,
                })
              ),
              recipientTags: ['重庆一组', '重庆二组', '上海一组'],
              payers: ['付款人甲', '付款人乙', '付款人丙'],
              stores: ['Apple 重庆万象城', 'Apple 解放碑', 'Apple 浦东'],
              officialOrderStatuses: [
                'PROCESSING',
                'PICKED_UP',
                'READY_FOR_PICKUP',
                '__not_observed__',
              ],
            };
          else if (url.pathname === '/api/orders') {
            queries.push(Object.fromEntries(url.searchParams));
            data = { orders: [], total: 0 };
          } else {
            errors.push(`意外 API: ${url.pathname}`);
            await route.abort();
            return;
          }
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:5173/orders');
      if (width < 768) await page.getByRole('button', { name: /筛选条件.*展开/ }).click();
      const waitQuery = async predicate => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (predicate(queries.at(-1) || {})) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert(predicate(queries.at(-1) || {}), '预期筛选参数未提交');
      };
      assert.equal(await page.getByPlaceholder('输入姓名').count(), 0);
      for (const [label, key] of [
        ['订单状态筛选', 'displayOrderStatuses'],
        ['商品信息筛选', 'productKeys'],
        ['官网订单状态筛选', 'officialOrderStatuses'],
        ['取机人 TAG 筛选', 'recipientTags'],
        ['取货门店筛选', 'pickupStores'],
        ['付款人筛选', 'payerNames'],
      ]) {
        await page.getByRole('button', { name: label, exact: true }).click();
        const count = await page.getByRole('option').count();
        assert(count > 1);
        await page.getByRole('button', { name: `${label}全选`, exact: true }).click();
        await waitQuery(query => JSON.parse(query[key] || '[]').length === count);
        assert.equal(await page.getByRole('option', { selected: true }).count(), count);
        await page.getByRole('button', { name: `${label}取消全选`, exact: true }).click();
        await waitQuery(query => !query[key]);
        assert.equal(await page.getByRole('option', { selected: true }).count(), 0);
        // 已选一个，再搜索另一项并全选，验证保留搜索外已选项。
        const options = page.getByRole('option');
        const secondLabel =
          (await options.nth(1).getAttribute('title')) || (await options.nth(1).innerText());
        await options.nth(0).click();
        const search = page.locator('input[placeholder^="搜索 "]');
        const term = secondLabel.replace(/（\d+）$/, '').trim();
        await search.fill(term);
        const matched = await page.getByRole('option').count();
        await page.getByRole('button', { name: `${label}全选搜索结果`, exact: true }).click();
        await waitQuery(query => JSON.parse(query[key] || '[]').length >= 2);
        const selectedCount = JSON.parse(queries.at(-1)[key]).length;
        await page.getByRole('button', { name: `${label}取消全选搜索结果`, exact: true }).click();
        await waitQuery(query => JSON.parse(query[key] || '[]').length === selectedCount - matched);
        await search.fill('不存在的匹配项');
        assert.equal(
          await page
            .getByRole('button', { name: `${label}全选搜索结果`, exact: true })
            .isDisabled(),
          true
        );
        await search.fill('');
        await page.getByRole('button', { name: '清空选择', exact: true }).click();
        await waitQuery(query => !query[key]);
        await search.press('Escape');
      }
      await page.getByRole('button', { name: '订单状态筛选', exact: true }).click();
      await page.getByRole('option', { name: '处理中', exact: true }).click();
      await page.locator('input[placeholder^="搜索 "]').press('Escape');
      await page.getByRole('button', { name: '官网订单状态筛选', exact: true }).click();
      await page.getByRole('option', { name: '已取货', exact: true }).click();
      await page.getByRole('option', { name: '尚未更新', exact: true }).click();
      await waitQuery(
        query =>
          JSON.parse(query.officialOrderStatuses || '[]').length === 2 &&
          JSON.parse(query.displayOrderStatuses || '[]').includes('processing')
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${output}/官网状态及全选-${width}.png` });
      await page.locator('input[placeholder^="搜索 "]').press('Escape');
      await page.getByPlaceholder(/搜索订单 ID/).fill('测试取机人');
      await waitQuery(query => query.keyword === '测试取机人' && !('recipientName' in query));
      await page.getByRole('button', { name: '清空筛选', exact: true }).click();
      await waitQuery(
        query => !query.keyword && !query.officialOrderStatuses && !query.displayOrderStatuses
      );
      assert.deepEqual(errors, []);
      process.stdout.write(
        `${width}px：六组全选／取消、搜索增量、无匹配、官网状态组合、关键词及重置通过\n`
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
