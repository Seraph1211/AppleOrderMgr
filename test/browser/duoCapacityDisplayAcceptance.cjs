/* eslint-env node, browser */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chooseSelect, selectValue } = require('./responsiveSelectSupport.cjs');
const base = 'http://127.0.0.1:5173';
const output = '.tmp/iphone-capacity-display-20261015/independent-test';
const capacities = [256, 512, 1024, 2048];
const label = value => (value >= 1024 ? `${value / 1024}TB` : `${value}GB`);
const products = capacities.map(value => ({
  id: `p${value}`,
  modelName: 'iPhone Duo',
  storageGb: value,
  colorName: '夜空色',
  entryEligible: true,
  fixedCostAmount: '15999.00',
}));
const units = products.map((product, index) => ({
  id: `u${index}`,
  serialNumber: `CP1234567${index}`,
  product,
  state: 'in_stock',
  deviceNumber: index + 1,
  version: 1,
  allowedActions: [],
  warehouse: { id: 'w1', name: '独立合成仓' },
  receivedOn: '2026-10-15',
}));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const evidence = [];
  try {
    fs.mkdirSync(output, { recursive: true });
    for (const width of [1440, 375]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        serviceWorkers: 'block',
      });
      page.setDefaultTimeout(12000);
      const errors = [],
        requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await page.addInitScript(() => localStorage.setItem('token', 'synthetic-capacity'));
      await page.route('**/*', async route => {
        const req = route.request(),
          url = new URL(req.url());
        if (url.origin !== base) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        requests.push({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          method: req.method(),
        });
        assert.equal(req.method(), 'GET', '独立容量展示验收不得提交业务写入');
        let data = {};
        if (url.pathname.endsWith('/auth/me'))
          data = {
            id: 1,
            role: 'admin',
            username: '容量独立验收',
            permissions: [
              'stock.read',
              'stock.receive',
              'stock.sales.read',
              'stock.sales.edit',
              'stock.sales.ship',
              'stock.cost.read',
            ],
          };
        else if (url.pathname.endsWith('/ledger/catalog'))
          data = {
            enabled: true,
            products,
            filterOptions: {
              modelNames: ['iPhone Duo'],
              storageGbs: capacities,
              colorNames: ['夜空色'],
            },
            warehouses: [{ id: 'w1', name: '独立合成仓' }],
            people: [],
          };
        else if (url.pathname.endsWith('/ledger/statistics'))
          data = {
            total: 4,
            models: [{ modelName: 'iPhone Duo', count: 4 }],
            items: products.map(product => ({ ...product, count: 1 })),
            states: [{ state: 'in_stock', count: 4 }],
            warehouses: [{ warehouseId: 'w1', warehouseName: '独立合成仓', count: 4 }],
          };
        else if (/\/ledger\/u\d$/.test(url.pathname))
          data = { ...units[Number(url.pathname.at(-1))], events: [] };
        else if (url.pathname.endsWith('/ledger/receive-preview'))
          data = { canReceive: true, unit: null };
        else if (url.pathname.endsWith('/ledger/dispatch-preview'))
          data = { needsReceive: true, unit: null };
        else if (url.pathname.endsWith('/ledger'))
          data = {
            items: units,
            total: 4,
            counts: { inStock: 4, sold: 0, pending: 0, returned: 0 },
          };
        await route.fulfill({ json: { success: true, data } });
      });
      await page.goto(`${base}/stock`);
      await page.getByRole('button', { name: units[2].serialNumber, exact: true }).waitFor();
      const body = await page.locator('body').innerText();
      for (const value of capacities)
        assert.match(body, new RegExp(`iPhone Duo ${label(value)} 夜空色`));
      assert.doesNotMatch(body, /(?:1024|2048)\s*GB/);
      await page.screenshot({ path: `${output}/容量列表-${width}.png`, fullPage: true });

      await page.getByRole('button', { name: '按容量筛选', exact: true }).click();
      const filtered = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/ledger') && url.searchParams.get('storageGbs') === '[1024]';
      });
      await page.getByRole('option', { name: '1TB', exact: true }).click();
      await filtered;
      assert.equal(
        requests.filter(request => request.path.endsWith('/ledger')).at(-1).query.storageGbs,
        '[1024]'
      );
      if (width < 768)
        await page.getByRole('dialog').getByRole('button', { name: /^完成/ }).click();
      else await page.getByRole('button', { name: '按容量筛选', exact: true }).click();

      await page.getByRole('button', { name: units[2].serialNumber, exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '设备详情', exact: true });
      await dialog.getByText('iPhone Duo 1TB 夜空色', { exact: true }).waitFor();
      assert.doesNotMatch(await dialog.innerText(), /1024\s*GB/);
      await dialog.getByRole('button', { name: '关闭设备详情', exact: true }).click();
      await page.getByRole('button', { name: '统计分析', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '统计分析', exact: true });
      await dialog.getByText('总计 4 台', { exact: true }).waitFor();
      for (const value of capacities)
        await dialog.getByRole('cell', { name: label(value), exact: true }).waitFor();
      assert.doesNotMatch(await dialog.innerText(), /(?:1024|2048)\s*GB/);
      await page.screenshot({ path: `${output}/容量统计-${width}.png`, fullPage: true });
      await dialog.getByRole('button', { name: '关闭统计分析', exact: true }).click();
      for (const name of ['入库登记', '出库登记']) {
        await page.getByRole('button', { name, exact: true }).click();
        dialog = page.getByRole('dialog', { name, exact: true });
        await dialog.getByLabel('序列号（SN）', { exact: true }).fill('CP12345679');
        await dialog.getByRole('button', { name: '查询设备', exact: true }).click();
        const control = dialog.getByLabel('机器型号 / 容量 / 颜色');
        await control.waitFor();
        const options = await control.evaluate(node =>
          [...(node.tagName === 'BUTTON' ? node.nextElementSibling : node).options].map(option => ({
            value: option.value,
            text: option.text,
          }))
        );
        for (const product of products) {
          const option = options.find(item => item.value === product.id);
          assert.equal(option.text, `iPhone Duo ${label(product.storageGb)} 夜空色`);
          await chooseSelect(control, product.id);
          assert.equal(await selectValue(control), product.id);
        }
        await page.screenshot({ path: `${output}/容量${name}-${width}.png`, fullPage: true });
        await dialog.getByRole('button', { name: `关闭${name}`, exact: true }).click();
      }
      assert.deepEqual(
        products.map(product => product.storageGb),
        capacities
      );
      assert.deepEqual(errors, []);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true
      );
      evidence.push({ width, products, requests, errors });
      await page.close();
    }
    fs.writeFileSync(`${output}/容量浏览器结果.json`, JSON.stringify(evidence, null, 2));
    process.stdout.write(
      'PASS: 1440/375列表/详情/统计/入出库显示256GB/512GB/1TB/2TB，原始容量及选项值不变，无业务写入\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
