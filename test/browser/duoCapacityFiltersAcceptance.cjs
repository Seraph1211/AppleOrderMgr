/* eslint-env node, browser */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:5173';
const output = '.tmp/iphone-capacity-display-20261015/independent-test';
const key = `name:${'a'.repeat(64)}`;
const rawProduct = {
  name: 'iPhone Duo 1024GB 夜空色',
  model: 'iPhone Duo 1024GB 夜空色',
  quantity: 1,
  filterKeys: [key],
};
const product = {
  id: 'MK2U4CH/A',
  sku: 'MK2U4CH/A',
  model: 'iPhone Duo',
  capacity: '1024GB',
  color: '夜空色',
  title: 'iPhone Duo 1024GB 夜空色',
  enabled: false,
  supported: true,
};
const store = {
  id: 'R001',
  storeCode: 'R001',
  storeName: '独立合成店',
  city: '合成城市',
  enabled: false,
};
const order = {
  id: 1,
  order_number: 'W7999999999',
  products: [rawProduct],
  order_amount: '21499.00',
  status: 'pending',
  order_date: '2026-10-15T01:00:00Z',
  validation_status: 'unavailable',
  payment_status: 'unpaid',
  payment_method: '微信',
  refresh: {},
};
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  try {
    for (const width of [1440, 375]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        serviceWorkers: 'block',
      });
      page.setDefaultTimeout(10000);
      const queries = [],
        errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('token', 'synthetic-capacity-filters'));
      await page.route('**/*', async route => {
        const req = route.request(),
          url = new URL(req.url());
        if (url.origin !== base) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        assert.equal(req.method(), 'GET');
        queries.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
        let data = {};
        if (url.pathname.endsWith('/auth/me'))
          data = {
            id: 1,
            role: 'admin',
            username: '容量筛选独立验收',
            permissions: ['orders.read', 'inventory.read'],
          };
        else if (url.pathname === '/api/orders/filter-options')
          data = {
            productOptions: [{ value: key, label: rawProduct.name, count: 1 }],
            recipientTags: [],
            stores: [],
          };
        else if (url.pathname === '/api/orders') data = { orders: [order], total: 1 };
        else if (url.pathname === '/api/orders/1') data = order;
        else if (url.pathname.endsWith('/catalog')) data = { products: [product], stores: [store] };
        else if (url.pathname.endsWith('/scope'))
          data = {
            products: [product],
            stores: [store],
            combinations: 1,
            enabled: false,
            state: 'disabled',
          };
        else if (url.pathname.endsWith('/health')) data = { state: 'disabled', paused: false };
        else if (url.pathname.endsWith('/settings'))
          data = { version: 1, config: { enabled: false, notificationsEnabled: false } };
        else if (url.pathname.endsWith('/latest'))
          data = {
            items: [{ ...product, ...store, id: 'sample', displayStatus: 'disabled' }],
            total: 1,
            page: 1,
            pageSize: 50,
            summary: { combinations: 1, inStock: 0, fresh: 0 },
          };
        await route.fulfill({ json: { success: true, data } });
      });
      await page.goto(`${base}/orders`);
      await page
        .getByText('iPhone Duo 1TB 夜空色 ×1', { exact: true })
        .locator('visible=true')
        .first()
        .waitFor();
      if (width < 768) await page.getByRole('button', { name: /筛选条件.*展开/ }).click();
      await page.getByRole('button', { name: '商品信息筛选', exact: true }).click();
      const search = page.locator('input[placeholder^="搜索 "]');
      const options = page.getByRole('listbox').getByRole('option');
      for (const token of ['1024GB', '1TB']) {
        await search.fill(token);
        assert.equal(await options.count(), 1);
        assert.match(await options.innerText(), /iPhone Duo 1TB 夜空色/);
        assert.doesNotMatch(await options.innerText(), /1024GB/);
      }
      const selected = page.waitForResponse(response => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/orders' &&
          url.searchParams.get('productKeys') === JSON.stringify([key])
        );
      });
      await options.click();
      await selected;
      if (width < 768)
        await page.getByRole('dialog').getByRole('button', { name: /^完成/ }).click();
      else await search.press('Escape');
      await page.screenshot({ path: `${output}/订单容量筛选-${width}.png`, fullPage: true });
      await page.goto(`${base}/orders/1`);
      await page.getByText('iPhone Duo 1TB 夜空色', { exact: true }).first().waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), /1024\s*GB/);

      await page.goto(`${base}/inventory-monitor`);
      await page.getByRole('region', { name: '全国库存列表' }).waitFor();
      assert.match(await page.locator('body').innerText(), /1TB/);
      assert.doesNotMatch(await page.locator('body').innerText(), /1024\s*GB/);
      if (width < 768)
        await page.getByRole('button', { name: '商品与门店筛选', exact: true }).click();
      await page.getByRole('button', { name: '容量', exact: true }).click();
      await page.getByRole('checkbox', { name: '1TB', exact: true }).check();
      await page.getByRole('button', { name: '完成 (1)', exact: true }).click();
      const applied = page.waitForResponse(response => {
        const url = new URL(response.url());
        return (
          url.pathname.endsWith('/inventory/latest') &&
          url.searchParams.get('capacities') === '1024GB'
        );
      });
      await page.getByRole('button', { name: '应用筛选', exact: true }).click();
      await applied;
      await page.screenshot({ path: `${output}/监控容量筛选-${width}.png`, fullPage: true });
      assert.equal(product.capacity, '1024GB');
      assert.equal(rawProduct.name, 'iPhone Duo 1024GB 夜空色');
      assert.deepEqual(errors, []);
      results.push({ width, queries, errors, rawProduct, product });
      await page.close();
    }
    fs.writeFileSync(`${output}/容量筛选浏览器结果.json`, JSON.stringify(results, null, 2));
    process.stdout.write(
      'PASS: 1440/375订单1TB展示及双搜索保留原key；监控1TB显示筛选请求仍1024GB，无写入\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
