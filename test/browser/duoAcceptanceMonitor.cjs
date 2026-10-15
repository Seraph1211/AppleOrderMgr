/* eslint-env node, browser */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const duo = require('../../src/data/stockCatalogV20261015.json');
const old = require('../../src/data/inventoryCatalog.json').products.filter(item =>
  ['iPhone 18 Pro', 'iPhone 18 Pro Max'].includes(item.model)
);
const { DEFAULT_CONFIG } = require('../../src/services/inventoryPolicy');
const base = 'http://127.0.0.1:5173';
const output = '.tmp/iphone-duo-implementation-20261015/independent-test';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    const errors = [],
      writes = [],
      queryEvidence = [];
    let products = [...old, ...duo].map(item => ({
      id: item.sku,
      ...item,
      enabled: false,
      supported: true,
    }));
    const settings = {
      version: 1,
      config: { ...DEFAULT_CONFIG, enabled: false, notificationsEnabled: false },
      hasWebhook: false,
      webhookTested: false,
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('token', 'duo-synthetic-monitor'));
    await page.route('**/*', async route => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin !== base) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let data = {};
      if (url.pathname === '/api/auth/me')
        data = { id: 1, role: 'admin', username: 'Duo独立验收', permissions: ['inventory.read'] };
      else if (url.pathname.endsWith('/catalog') && req.method() === 'GET')
        data = {
          products,
          stores: [
            {
              id: 'R001',
              storeCode: 'R001',
              storeName: '独立合成店',
              city: '合成城市',
              enabled: false,
            },
          ],
        };
      else if (url.pathname.endsWith('/catalog') && req.method() === 'PUT') {
        const body = req.postDataJSON();
        writes.push(body);
        products = products.map(item =>
          body.ids.includes(item.id) ? { ...item, enabled: body.enabled } : item
        );
        data = { count: body.ids.length };
      } else if (req.method() !== 'GET') throw new Error(`禁止非目录写入：${url.pathname}`);
      else if (url.pathname.endsWith('/settings')) data = settings;
      else if (url.pathname.endsWith('/health'))
        data = { state: 'disabled', paused: false, hourCount: 0, dayCount: 0 };
      else if (url.pathname.endsWith('/scope'))
        data = { products: [], stores: [], combinations: 0, enabled: false, state: 'disabled' };
      else if (url.pathname.endsWith('/latest')) {
        queryEvidence.push(Object.fromEntries(url.searchParams));
        data = {
          items: [],
          total: 0,
          page: 1,
          pageSize: 50,
          summary: { combinations: 0, inStock: 0, fresh: 0 },
        };
      } else if (url.pathname.endsWith('/rounds'))
        data = { items: [], total: 0, page: 1, pageSize: 50 };
      await route.fulfill({ json: { success: true, data } });
    });
    await page.goto(`${base}/inventory-monitor/manage`);
    await page.getByRole('button', { name: '商品 (40)', exact: true }).waitFor();
    await page.getByText('· iPhone 18 Pro 系列 / iPhone Duo · 北京时间', { exact: true }).waitFor();
    for (const item of duo)
      await page.getByRole('checkbox', { name: `选择目录 ${item.sku}`, exact: true }).check();
    await page.getByText('已选 8', { exact: true }).waitFor();
    await page.getByRole('button', { name: '启用所选', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '启用' }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].kind, 'products');
    assert.equal(writes[0].enabled, true);
    assert.deepEqual(writes[0].ids.sort(), duo.map(item => item.sku).sort());
    assert.equal(products.filter(item => item.enabled).length, 8);
    assert.equal(settings.config.enabled, false);
    assert.equal(settings.config.notificationsEnabled, false);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${output}/Duo监控目录-1440.png`, fullPage: true });
    await page.reload();
    await page.getByRole('button', { name: '商品 (40)', exact: true }).waitFor();
    for (const item of duo) {
      const row = page
        .getByRole('checkbox', { name: `选择目录 ${item.sku}`, exact: true })
        .locator('xpath=ancestor::tr');
      await row.getByText('正常', { exact: true }).waitFor();
    }
    await page.goto(`${base}/inventory-monitor`);
    await page.getByRole('button', { name: '型号', exact: true }).click();
    await page.getByRole('checkbox', { name: 'iPhone Duo', exact: true }).check();
    await page.getByRole('button', { name: '完成 (1)', exact: true }).click();
    const loaded = page.waitForResponse(response => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith('/inventory/latest') &&
        url.searchParams.get('models') === 'iPhone Duo'
      );
    });
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await loaded;
    assert.equal(queryEvidence.at(-1).models, 'iPhone Duo');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/Duo监控筛选-1440.png`, fullPage: true });
    fs.writeFileSync(
      `${output}/监控浏览器结果.json`,
      JSON.stringify({ writes, queryEvidence, settings, errors }, null, 2)
    );
    process.stdout.write('PASS: 40目录选择Duo8项、保存重载、型号筛选，采集通知关闭\n');
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
