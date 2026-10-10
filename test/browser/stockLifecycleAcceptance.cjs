/* eslint-env node, browser */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const output = '.tmp/stock-lifecycle-ui';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    fs.mkdirSync(output, { recursive: true });
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10000);
      const errors = [],
        requests = [],
        writes = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('token', 'synthetic-lifecycle'));
      const product = {
        id: 'p1',
        modelName: 'iPhone 18 Pro Max',
        storageGb: 512,
        colorName: '蓝色',
      };
      const unit = {
        id: 'u1',
        deviceNumber: 1,
        version: 1,
        serialNumber: 'A123456789',
        state: 'registered',
        product,
        orderId: 1,
        orderNumber: 'W1234567890',
        orderLinked: true,
        allowedActions: ['confirm_return'],
        lifecycleIssue: 'return_pending',
        lifecycleMessage: '官网已发起退货，具体退货设备待确认',
        check: {
          checkedAt: '2026-10-10T01:00:00Z',
          observedAt: '2026-10-10T00:00:00Z',
          errorCode: 'HTTP_541',
          workerOnline: true,
        },
      };
      await page.route('**/api/**', async route => {
        const req = route.request(),
          url = new URL(req.url());
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
              'stock.correct',
              'stock.sales.read',
              'stock.sales.edit',
              'stock.sales.ship',
              'stock.collections.read',
              'stock.receipts.read',
              'orders.read',
            ],
          };
        else if (url.pathname.endsWith('/ledger/catalog'))
          data = {
            enabled: true,
            products: [product],
            warehouses: [{ id: 'w1', name: '合成仓库' }],
            people: [],
          };
        else if (url.pathname.endsWith('/ledger/statistics')) {
          requests.push(Object.fromEntries(url.searchParams));
          data = {
            total: 41,
            models: [{ modelName: product.modelName, count: 41 }],
            items: [{ ...product, count: 41 }],
          };
        } else if (url.pathname.endsWith('/ledger/returns/1')) {
          if (req.method() === 'POST') {
            writes.push(req.postDataJSON());
            data = { items: [{ ...unit, state: 'returned' }] };
          } else
            data = {
              orderId: 1,
              orderNumber: unit.orderNumber,
              fingerprint: 'f'.repeat(64),
              hasReturn: true,
              returnQuantity: 1,
              serialNumbers: [],
              units: [unit, { ...unit, id: 'u2', serialNumber: 'B123456789' }],
            };
        } else if (url.pathname.endsWith('/ledger')) {
          const view = url.searchParams.get('view');
          const row =
            view === 'sold'
              ? {
                  ...unit,
                  state: 'sold',
                  allowedActions: [],
                  lifecycleIssue: null,
                  lifecycleMessage: null,
                  receivedOn: '2026-10-01',
                  soldOn: '2026-10-02',
                  paymentStatus: 'unpaid',
                  saleAmount: '10000.00',
                  settlementAmount: '9900.00',
                }
              : view === 'returned'
                ? { ...unit, state: 'returned' }
                : unit;
          data = {
            items: [row],
            total: 1,
            counts: { pending: 2, inStock: 20, sold: 18, returned: 1 },
            page: 1,
            pageSize: 20,
          };
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      await page.goto('http://127.0.0.1:5330/stock?view=registered');
      await page
        .getByRole('tab', { name: /^未入库/ })
        .waitFor()
        .catch(async error => {
          process.stderr.write(
            JSON.stringify({ errors, body: await page.locator('body').innerText() })
          );
          throw error;
        });
      assert.equal(await page.getByRole('tab').count(), 5);
      await page.getByText('官网检查失败', { exact: true }).click();
      await page.getByText(/上次成功/).waitFor();
      await page.getByRole('button', { name: '核实退货', exact: true }).click();
      await page.getByRole('checkbox', { name: '退货 A123456789' }).check();
      await page.getByLabel('核实依据（必填）').fill('核对订单照片和退货凭证，仅退第一台');
      await page.getByRole('button', { name: '确认保存', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.deepEqual(writes[0].serialNumbers, ['A123456789']);
      assert.ok(writes[0].requestKey);
      await page.getByRole('tab', { name: /^已售/ }).click();
      if (width === 1440) {
        await page
          .getByRole('columnheader', { name: '入库日期 / 销售日期', exact: true })
          .waitFor();
        await page.getByRole('columnheader', { name: '货款状态', exact: true }).waitFor();
      }
      await page.screenshot({ path: `${output}/sold-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: '数量统计', exact: true }).click();
      await page.getByText('总计 41 台', { exact: true }).waitFor();
      await page.getByRole('button', { name: '统计设备状态', exact: true }).click();
      await page.getByRole('option', { name: '未入库', exact: true }).click();
      await page.getByRole('button', { name: '统计设备状态', exact: true }).click();
      await page.getByRole('button', { name: '统计仓库', exact: true }).click();
      await page.getByRole('option', { name: '未分配仓库', exact: true }).click();
      await page.getByRole('button', { name: '统计仓库', exact: true }).click();
      await page.getByText('总计 41 台', { exact: true }).waitFor();
      assert.ok(
        requests.some(r => r.states === '["registered"]' && r.warehouseIds === '["unassigned"]')
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      );
      await page.screenshot({ path: `${output}/statistics-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    }
    process.stdout.write('电脑/手机五Tab、日期货款分列、退货SN提交、全量统计筛选与视口检查通过\n');
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
