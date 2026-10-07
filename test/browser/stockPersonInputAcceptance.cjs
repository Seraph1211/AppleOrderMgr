/* eslint-env node, browser */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      hasTouch: true,
      serviceWorkers: 'block',
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('token', 'synthetic-ui-only'));
    const requests = [];
    const submissions = [];
    let people = [
      { id: 's1', name: '合成销售甲', roles: ['salesperson'] },
      { id: 's2', name: '合成销售乙', roles: ['salesperson'] },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `s${i + 3}`,
        name: `备选销售${i + 1}`,
        roles: ['salesperson'],
      })),
      { id: 'h1', name: '合成出货', roles: ['handler'] },
    ];
    const product = { id: 'p1', modelName: 'iPhone 18 Pro Max', storageGb: 256, colorName: '蓝色' };
    const warehouse = { id: 'w1', name: '重庆测试仓' };
    const units = Array.from({ length: 23 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      deviceNumber: i + 1,
      serialNumber: `TESTSN${String(i + 1).padStart(4, '0')}`,
      state: i === 22 ? 'sold' : 'in_stock',
      product,
      warehouse: i === 22 ? null : warehouse,
      sourceWarehouse: warehouse,
      receivedOn: '2026-10-01',
      soldOn: '2026-10-07',
      notes: i === 0 ? '重庆备注 AbC_%' : '普通样本',
      allowedActions: i === 22 ? ['payment'] : ['sell'],
      paymentStatus: 'unpaid',
      saleAmount: '9999.00',
    }));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let data = {};
      if (url.pathname.endsWith('/auth/me'))
        data = {
          id: 1,
          role: 'admin',
          username: '合成验收',
          permissions: [
            'stock.read',
            'stock.receive',
            'stock.sales.read',
            'stock.sales.edit',
            'stock.sales.ship',
            'stock.collections.read',
            'stock.receipts.read',
          ],
        };
      else if (url.pathname.endsWith('/ledger/catalog'))
        data = {
          enabled: true,
          products: [product],
          warehouses: [warehouse],
          people,
          filterOptions: {
            modelNames: [product.modelName],
            storageGbs: [256],
            colorNames: ['蓝色'],
          },
        };
      else if (url.pathname.endsWith('/ledger/sell')) {
        submissions.push(route.request().postDataJSON());
        data = { ok: true };
      } else if (url.pathname.endsWith('/ledger')) {
        const params = Object.fromEntries(url.searchParams);
        requests.push(params);
        let filtered = units.filter(
          unit =>
            !params.q ||
            `${unit.serialNumber} ${unit.notes}`.toLowerCase().includes(params.q.toLowerCase())
        );
        if (params.warehouseId)
          filtered = filtered.filter(
            unit => (unit.warehouse || unit.sourceWarehouse).id === params.warehouseId
          );
        const counts = {
          inStock: filtered.filter(unit => unit.state === 'in_stock').length,
          sold: filtered.filter(unit => unit.state === 'sold').length,
        };
        filtered = filtered.filter(unit => params.view === 'all' || unit.state === params.view);
        const current = Number(params.page || 1),
          size = Number(params.pageSize || 20);
        data = {
          items: filtered.slice((current - 1) * size, current * size),
          total: filtered.length,
          page: current,
          pageSize: size,
          counts,
        };
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
    });
    const base = process.env.STOCK_UI_BASE_URL || 'http://127.0.0.1:5327';
    const output = process.env.STOCK_UI_OUTPUT_DIR || 'tmp';
    await page.goto(`${base}/stock`);
    await page.getByRole('button', { name: '售出', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    const sales = modal.getByRole('combobox', { name: '销售人', exact: true });
    const handler = modal.getByRole('combobox', { name: '出货人', exact: true });
    assert.equal(await modal.locator('input[list],datalist').count(), 0);
    assert.equal(await sales.evaluate(el => el.validity.valueMissing), true);
    await sales.click();
    const list = page.getByRole('listbox', { name: '销售人候选' });
    assert.equal(await list.getByRole('option').count(), 14);
    const [fieldRect, listRect] = await Promise.all([sales.boundingBox(), list.boundingBox()]);
    assert(Math.abs(fieldRect.width - listRect.width) < 1);
    assert(Math.abs(fieldRect.x - listRect.x) < 1);
    assert(listRect.y > fieldRect.y);
    await page.screenshot({ path: `${output}/dropdown-desktop.png` });
    await sales.fill('销售乙');
    assert.equal(await list.getByRole('option').count(), 1);
    await sales.press('ArrowDown');
    await sales.press('Enter');
    assert.equal(await sales.inputValue(), '合成销售乙');
    await list.waitFor({ state: 'hidden' });
    assert.equal(submissions.length, 0);
    await modal.getByRole('button', { name: '展开销售人候选' }).click();
    await list.getByRole('option', { name: '合成销售乙', selected: true }).waitFor();
    await page.screenshot({ path: `${output}/dropdown-selected.png` });
    await sales.press('Escape');
    await list.waitFor({ state: 'hidden' });
    assert(await modal.isVisible());
    await handler.click();
    const handlers = page.getByRole('listbox', { name: '出货人候选' });
    assert.equal(await handlers.getByRole('option').count(), 1);
    await handlers.getByRole('option', { name: '合成出货' }).click();
    assert.equal(await handler.inputValue(), '合成出货');
    await handler.fill('手动出货姓名');
    await page.getByText('无匹配姓名，可直接使用输入的姓名', { exact: true }).waitFor();
    await handler.dispatchEvent('compositionstart');
    await handler.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    assert.equal(submissions.length, 0);
    assert.equal(await handler.inputValue(), '手动出货姓名');
    await handler.dispatchEvent('compositionend');
    await handler.press('Tab');
    await handlers.waitFor({ state: 'hidden' });
    await modal.getByLabel('TESTSN0001 售价', { exact: true }).fill('9999');
    for (const width of [768, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await sales.click();
      await list.waitFor();
      const rect = await list.boundingBox();
      assert(
        rect.x >= 0 && rect.x + rect.width <= width && rect.y >= 0 && rect.y + rect.height <= 800
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      if (width === 375) {
        await page.screenshot({ path: `${output}/dropdown-mobile.png` });
        await list.getByRole('option', { name: '合成销售甲', exact: true }).tap();
        assert.equal(await sales.inputValue(), '合成销售甲');
      } else await sales.press('Escape');
    }
    await page.setViewportSize({ width: 375, height: 360 });
    await handler.click();
    await handlers.waitFor();
    const shortRect = await handlers.boundingBox();
    assert(shortRect.y >= 0 && shortRect.y + shortRect.height <= 360);
    await modal.getByText('负责成交的人', { exact: true }).click();
    await handlers.waitFor({ state: 'hidden' });
    await modal.getByRole('button', { name: '确认售出 1 台' }).click();
    await modal.waitFor({ state: 'hidden' });
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].salespersonName, '合成销售甲');
    assert.equal(submissions[0].handlerName, '手动出货姓名');
    people = [];
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/stock?view=in_stock`);
    await page.getByRole('tab', { name: /在库/ }).click();
    await page.getByRole('button', { name: '售出', exact: true }).first().click();
    await sales.fill('无候选手填');
    await page.getByText('无匹配姓名，可直接使用输入的姓名', { exact: true }).waitFor();
    assert.equal(await sales.inputValue(), '无候选手填');
    assert.deepEqual(errors, []);
    process.stdout.write(
      JSON.stringify({
        passed: true,
        widths: [1440, 768, 375],
        checks:
          'custom-popup/alignment/selected/search/keyboard/IME/touch/short-screen/empty/custom/submission',
      }) + '\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
