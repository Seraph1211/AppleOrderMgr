/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const baseUrl = process.env.FILTER_BASE_URL || 'http://127.0.0.1:5173';
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

/** 合成浏览器验证六组全选、搜索后全选和官网状态组合，不触发生产业务。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const output = process.env.FILTER_OUTPUT || '/tmp/order-filter-select-all';
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const width of [375, 768, 1440, 1904]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-filter-all'));
      const queries = [];
      const errors = [];
      await context.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === baseUrl) await route.continue();
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
      await page.goto(`${baseUrl}/orders`);
      if (width < 1100) await page.getByRole('button', { name: /筛选条件.*展开/ }).click();
      const waitQuery = async predicate => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (predicate(queries.at(-1) || {})) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert(predicate(queries.at(-1) || {}), '预期筛选参数未提交');
      };
      assert.equal(await page.getByPlaceholder('输入姓名').count(), 0);
      for (const [label, key] of [
        ['邮件订单状态筛选', 'displayOrderStatuses'],
        ['商品信息筛选', 'productKeys'],
        ['官网订单状态筛选', 'officialOrderStatuses'],
        ['订单 TAG 筛选', 'recipientTags'],
        ['取货门店筛选', 'pickupStores'],
        ['付款人筛选', 'payerNames'],
      ]) {
        await page.getByRole('button', { name: label, exact: true }).click();
        if (width >= 768) {
          const menu = await page.locator('.tag-select-panel').boundingBox();
          assert(menu.x >= 0 && menu.x + menu.width <= width, '筛选菜单不能越出视口');
          const trigger = await page
            .getByRole('button', { name: label, exact: true })
            .boundingBox();
          assert(Math.abs(menu.width - trigger.width) <= 1, `${label}菜单必须与触发器等宽`);
          assert(Math.abs(menu.x - trigger.x) <= 1, `${label}菜单必须与触发器左边界对齐`);
          const row = await page.getByRole('option').first().boundingBox();
          // 商品规格保留原有完整换行，短状态为单行，长商品最多三行。
          const maxRowHeight = label === '商品信息筛选' ? 66 : 34;
          assert(
            row.height >= 32 && row.height <= maxRowHeight,
            `${label}选项高度异常：${row.height}`
          );
        } else {
          const primary = page.getByRole('dialog').locator('.mobile-picker-footer .btn-primary');
          assert.equal(
            await primary.evaluate(node => getComputedStyle(node).backgroundColor),
            'rgb(36, 107, 220)',
            '手机完成操作使用订单配色'
          );
        }
        const count = await page.getByRole('option').count();
        assert(count > 1);
        await page.getByRole('button', { name: `${label}全选`, exact: true }).click();
        await waitQuery(query => JSON.parse(query[key] || '[]').length === count);
        assert.equal(await page.getByRole('option', { selected: true }).count(), count);
        const checkColor = await page
          .getByRole('option', { selected: true })
          .first()
          .locator('.tag-select-checkbox')
          .evaluate(element => getComputedStyle(element).backgroundColor);
        assert.equal(checkColor, 'rgb(36, 107, 220)', '选中使用品牌蓝勾选');
        if (width >= 768 && label === '官网订单状态筛选')
          await page.screenshot({ path: `${output}/紧凑多选-${width}.png` });
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
      await page.getByRole('button', { name: '邮件订单状态筛选', exact: true }).click();
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
      await page
        .locator('#orders-filters')
        .getByRole('button', { name: '清空筛选', exact: true })
        .click();
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
