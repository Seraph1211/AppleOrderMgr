/* eslint-env node, browser */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chooseSelect, selectValue } = require('./responsiveSelectSupport.cjs');
const { CATALOG } = require('../../src/services/stockFixedCatalog');
const base = 'http://127.0.0.1:5173';
const output = '.tmp/iphone-duo-implementation-20261015/independent-test';
const products = CATALOG.map(item => ({
  id: item.skuCode,
  ...item,
  entryEligible: true,
  fixedCostAmount: item.amount,
}));
const duo = products.filter(item => item.modelName === 'iPhone Duo');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const evidence = [];
  try {
    assert.equal(duo.length, 8);
    for (const width of [1440, 375]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        serviceWorkers: 'block',
      });
      page.setDefaultTimeout(12000);
      const errors = [],
        writes = [],
        reads = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await page.addInitScript(() => localStorage.setItem('token', 'duo-independent-synthetic'));
      await page.route('**/*', async route => {
        const req = route.request(),
          url = new URL(req.url());
        if (url.origin !== new URL(base).origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        reads.push(url.pathname);
        let data = {};
        if (url.pathname.endsWith('/auth/me'))
          data = {
            id: 1,
            username: 'Duo独立合成验收',
            role: 'admin',
            permissions: [
              'stock.read',
              'stock.receive',
              'stock.sales.read',
              'stock.sales.edit',
              'stock.sales.ship',
              'stock.cost.read',
              'stock.cost.edit',
            ],
          };
        else if (url.pathname.endsWith('/ledger/catalog'))
          data = {
            enabled: true,
            products,
            warehouses: [{ id: 'w1', name: '独立合成仓' }],
            people: [],
          };
        else if (url.pathname.endsWith('/ledger/receive-preview'))
          data = { canReceive: true, unit: null };
        else if (url.pathname.endsWith('/ledger/dispatch-preview'))
          data = { needsReceive: true, unit: null };
        else if (
          url.pathname.endsWith('/ledger/receive') ||
          url.pathname.endsWith('/ledger/dispatch')
        ) {
          writes.push({ path: url.pathname, body: req.postDataJSON() });
          data = { items: [] };
        } else if (url.pathname.endsWith('/box/recognize'))
          data = {
            candidates: [
              {
                serialNumber: 'AO12CD34EF',
                productId: 'MK2M4CH/A',
                reviewReasons: ['SN 文字与条码不一致'],
                sources: { serial: 'serial_label' },
              },
            ],
          };
        else if (url.pathname.endsWith('/ledger'))
          data = { items: [], total: 0, counts: { inStock: 0, sold: 0, pending: 0, returned: 0 } };
        await route.fulfill({ json: { success: true, data } });
      });
      await page.goto(`${base}/stock`);
      await page.getByRole('button', { name: '入库登记', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '入库登记', exact: true });
      await dialog.getByLabel('序列号（SN）', { exact: true }).fill('AO12CD34EF');
      await dialog.getByRole('button', { name: '查询设备', exact: true }).click();
      await dialog.getByText('这是新设备，确认后创建入库记录。', { exact: true }).waitFor();
      const labelImage = await page.screenshot();
      await dialog
        .getByLabel('上传盒标照片')
        .setInputFiles({ name: 'synthetic-label.png', mimeType: 'image/png', buffer: labelImage });
      await dialog.getByText(/识别需核对：SN 文字与条码不一致/).waitFor();
      assert.equal(
        await dialog.getByLabel('序列号（SN）', { exact: true }).inputValue(),
        'AO12CD34EF'
      );
      assert.equal(await selectValue(dialog.getByLabel('机器型号 / 容量 / 颜色')), 'MK2M4CH/A');
      assert.equal(await dialog.getByRole('button', { name: '确认入库 1 台' }).isDisabled(), true);
      assert.equal(writes.length, 0);
      for (const item of duo) {
        await chooseSelect(dialog.getByLabel('机器型号 / 容量 / 颜色'), item.id);
        assert.equal(await selectValue(dialog.getByLabel('机器型号 / 容量 / 颜色')), item.id);
      }
      await chooseSelect(dialog.getByLabel('入库仓库'), 'w1');
      await dialog.getByLabel('入库日期', { exact: true }).fill('2026-10-15');
      await dialog.getByRole('checkbox').check();
      assert.equal(await dialog.getByRole('button', { name: '确认入库 1 台' }).isEnabled(), true);
      assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      await page.screenshot({ path: `${output}/Duo入库-${width}.png`, fullPage: true });
      await dialog.getByRole('button', { name: '确认入库 1 台' }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(writes[0].body.units[0].productId, duo.at(-1).id);
      assert.equal(writes[0].body.units[0].serialNumber, 'AO12CD34EF');

      await page.getByRole('button', { name: '出库登记', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '出库登记', exact: true });
      await dialog.getByLabel('序列号（SN）', { exact: true }).fill('AI12CD34EF');
      await dialog.getByRole('button', { name: '查询设备', exact: true }).click();
      await dialog.getByText('此设备尚未入库，本次将一并创建入库记录。').waitFor();
      for (const item of duo) {
        await chooseSelect(dialog.getByLabel('机器型号 / 容量 / 颜色'), item.id);
        assert.equal(await dialog.getByLabel('成本价（元）').inputValue(), item.amount);
      }
      await chooseSelect(dialog.getByLabel('入库仓库'), 'w1');
      await dialog.getByRole('combobox', { name: '销售人', exact: true }).fill('合成销售');
      await dialog.getByRole('combobox', { name: '出货人', exact: true }).fill('合成经手');
      await dialog.getByLabel('售价（元）', { exact: true }).fill('30000');
      await chooseSelect(dialog.getByLabel('货款状况'), 'unpaid');
      await dialog.getByRole('checkbox').check();
      assert.equal(await dialog.getByRole('button', { name: '确认出库' }).isEnabled(), true);
      assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true
      );
      await page.screenshot({ path: `${output}/Duo出库-${width}.png`, fullPage: true });
      await dialog.getByRole('button', { name: '确认出库' }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(writes[1].body.unit.productId, duo.at(-1).id);
      assert.equal(writes[1].body.unit.needsReceive, true);
      assert.equal(writes[1].body.unit.serialNumber, 'AI12CD34EF');
      assert.deepEqual(errors, []);
      evidence.push({ width, skuSelections: 16, writes, pageErrors: errors, reads });
      await page.close();
    }
    fs.writeFileSync(`${output}/浏览器结果.json`, JSON.stringify(evidence, null, 2));
    process.stdout.write(
      'PASS: 1440/375px Duo全部规格入库/出库选择、单价、确认与载荷、横溢和pageerror\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
