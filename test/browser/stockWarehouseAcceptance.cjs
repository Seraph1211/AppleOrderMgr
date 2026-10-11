/* eslint-env node, browser */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const baseUrl = process.env.STOCK_UI_URL || 'http://127.0.0.1:5338';
const output = process.env.OUTPUT_DIR || '.tmp/stock-warehouse-multiselect';
const warehouses = [
  { id: 'w1', name: '重庆 - 凯德九章' },
  { id: 'w2', name: '重庆 - 天邻风景' },
  { id: 'w3', name: '长沙 - 明威' },
];

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  try {
    for (const width of [1440, 768, 375, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const queries = [];
      const errors = [];
      const writes = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('token', 'synthetic-warehouse'));
      await page.route('**/api/**', async route => {
        try {
          const req = route.request();
          const url = new URL(req.url());
          if (req.method() !== 'GET') writes.push(req.method());
          let data = {};
          if (url.pathname.endsWith('/auth/me')) {
            data = {
              id: 1,
              role: 'operator',
              username: '合成验收',
              permissions: ['stock.read', 'stock.sales.edit', 'stock.sales.ship'],
            };
          } else if (url.pathname.endsWith('/ledger/catalog')) {
            data = {
              enabled: true,
              warehouses,
              products: [],
              people: [],
              filterOptions: {
                modelNames: ['iPhone 18 Pro Max'],
                storageGbs: [512],
                colorNames: [],
              },
            };
          } else if (url.pathname.endsWith('/stock/ledger')) {
            const query = Object.fromEntries(url.searchParams);
            queries.push(query);
            data = {
              items: [
                {
                  id: 'u1',
                  deviceNumber: 1,
                  serialNumber: 'TEST123456',
                  state: 'in_stock',
                  allowedActions: ['sell'],
                  warehouse: warehouses[0],
                },
              ],
              total: 41,
              counts: { registered: 0, ['in_stock']: 41, sold: 0, returned: 0 },
            };
          }
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data }),
          });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      await page.goto(`${baseUrl}/stock`);
      const trigger = page.getByRole('button', { name: '按仓库筛选', exact: true });
      await trigger.waitFor();
      const waitQuery = async predicate => {
        for (let i = 0; i < 100 && !predicate(queries.at(-1) || {}); i++)
          await page.waitForTimeout(50);
        assert.ok(predicate(queries.at(-1) || {}), JSON.stringify(queries.at(-1)));
      };
      await waitQuery(q => q.warehouseIds === '[]');
      await page.getByRole('checkbox', { name: '选择 TEST123456', exact: true }).check();
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await waitQuery(q => q.page === '2');
      await trigger.click();
      await page.getByRole('option', { name: warehouses[0].name, exact: true }).click();
      await page.getByRole('option', { name: warehouses[1].name, exact: true }).click();
      await waitQuery(q => q.warehouseIds === '["w1","w2"]' && q.page === '1');
      assert.match(await trigger.innerText(), /已选 2 项/);
      await page.getByText('已选 1 台（最多 100 台）', { exact: true }).waitFor();
      const search = page.getByPlaceholder('搜索 仓库', { exact: true });
      await search.fill('长沙');
      await page.getByRole('button', { name: '按仓库筛选全选搜索结果', exact: true }).click();
      await waitQuery(q => JSON.parse(q.warehouseIds).length === 3);
      await page.getByRole('button', { name: '按仓库筛选取消全选搜索结果', exact: true }).click();
      await waitQuery(q => q.warehouseIds === '["w1","w2"]');
      await search.fill('没有此仓库');
      assert.ok(
        await page.getByRole('button', { name: '按仓库筛选全选搜索结果', exact: true }).isDisabled()
      );
      await search.fill('');
      await page.screenshot({ path: `${output}/warehouse-${width}.png` });
      if (width < 768)
        await page.getByRole('button', { name: '完成（已选 2 项）', exact: true }).click();
      else await search.press('Escape');
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      await page.getByRole('tab', { name: /^已售/ }).click();
      await waitQuery(q => q.view === 'sold' && q.warehouseIds === '["w1","w2"]');
      await trigger.click();
      await page.getByRole('button', { name: '清空选择', exact: true }).click();
      await waitQuery(q => q.warehouseIds === '[]');
      await page.getByRole('button', { name: '按仓库筛选全选', exact: true }).click();
      await waitQuery(q => JSON.parse(q.warehouseIds).length === 3);
      await page.getByRole('button', { name: '按仓库筛选取消全选', exact: true }).click();
      await waitQuery(q => q.warehouseIds === '[]');
      if (width < 768) await page.getByRole('button', { name: '完成', exact: true }).click();
      else await page.getByRole('heading', { name: '库存管理' }).click();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      await trigger.click();
      await page.getByRole('option', { name: warehouses[0].name, exact: true }).click();
      if (width < 768)
        await page.getByRole('button', { name: '完成（已选 1 项）', exact: true }).click();
      else await search.press('Escape');
      await page.getByRole('button', { name: '重置筛选', exact: true }).click();
      await waitQuery(q => q.warehouseIds === '[]' && q.page === '1');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, []);
      results.push({
        width,
        multiple: true,
        searchSelectAll: true,
        clear: true,
        tabPreserved: true,
        reset: true,
        writes: 0,
      });
      await page.close();
    }
    process.stdout.write(JSON.stringify(results));
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(error.stack);
  process.exitCode = 1;
});
