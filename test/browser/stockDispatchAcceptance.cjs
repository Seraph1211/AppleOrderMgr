/* eslint-env node, browser */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const output = process.env.STOCK_UI_OUTPUT_DIR || '.tmp/stock-dispatch';
const base = process.env.STOCK_UI_BASE_URL || 'http://127.0.0.1:5329';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(() => {
      localStorage.setItem('token', 'synthetic-stock-dispatch');
      window.cameraTracks = [];
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 1280;
          canvas.height = 720;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, 1280, 720);
          ctx.fillStyle = '#111111';
          ctx.font = '32px sans-serif';
          ctx.fillText('Synthetic box label', 50, 60);
          const stream = canvas.captureStream(10);
          window.cameraTracks.push(...stream.getTracks());
          return stream;
        },
      });
    });
    const product = {
      id: 'p1',
      modelName: 'iPhone 18 Pro Max',
      storageGb: 256,
      colorName: '银色',
      entryEligible: true,
      fixedCostAmount: '10999.00',
    };
    const other = { ...product, id: 'p2', storageGb: 512, fixedCostAmount: '12999.00' };
    const unit = {
      id: 'u1',
      version: 3,
      serialNumber: 'AB12CD34EF',
      state: 'in_stock',
      product,
      warehouse: { id: 'w1', name: '测试仓库' },
      officialCostAmount: '10000.00',
      receivedOn: '2026-10-01',
      allowedActions: ['sell'],
    };
    let ocrMode = 'success';
    let dispatchFails = false;
    let ocrCount = 0;
    const submissions = [];
    const reads = [];
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let data = {};
      let status = 200;
      let error;
      if (url.pathname.endsWith('/auth/me'))
        data = {
          id: 1,
          username: '合成验收',
          role: 'admin',
          permissions: [
            'stock.read',
            'stock.receive',
            'stock.sales.read',
            'stock.sales.edit',
            'stock.sales.ship',
            'stock.cost.read',
            'stock.cost.edit',
            'stock.expenses.edit',
            'stock.collections.edit',
            'stock.receipts.edit',
          ],
        };
      else if (url.pathname.endsWith('/ledger/catalog'))
        data = {
          enabled: true,
          products: [product, other],
          warehouses: [unit.warehouse],
          people: [],
        };
      else if (url.pathname.endsWith('/ledger/dispatch-preview')) {
        const sn = url.searchParams.get('serialNumber');
        reads.push(sn);
        if (sn === 'ZZ12CD34EF') {
          status = 409;
          error = { code: 'UNIT_STATE_CONFLICT', message: '该设备已售出或不在可出库状态' };
        } else
          data =
            sn === unit.serialNumber
              ? { needsReceive: false, unit }
              : { needsReceive: true, unit: null };
      } else if (url.pathname.endsWith('/ledger/dispatch')) {
        submissions.push(route.request().postDataJSON());
        if (dispatchFails) {
          status = 409;
          error = { code: 'VERSION_CONFLICT', message: '记录已变化' };
        } else data = { items: [{ ...unit, state: 'sold' }] };
      } else if (url.pathname.endsWith('/box/recognize')) {
        ocrCount += 1;
        if (ocrMode === 'quota') {
          status = 429;
          error = { code: 'OCR_MONTHLY_LIMIT', message: '本月识别额度已用完' };
        } else {
          if (ocrMode === 'slow') await new Promise(resolve => setTimeout(resolve, 1500));
          data = {
            candidates: [
              {
                serialNumber: unit.serialNumber,
                productId: ocrMode === 'conflict' ? 'p2' : 'p1',
                reviewReasons: [],
              },
            ],
          };
        }
      } else if (url.pathname.endsWith('/ledger'))
        data = { items: [], total: 0, counts: { inStock: 0, sold: 0 } };
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(error ? { success: false, error } : { success: true, data }),
      });
    });
    await page.goto(`${base}/stock`);
    assert.equal(await page.getByRole('button', { name: '补录历史销售', exact: true }).count(), 0);
    const open = async () => {
      await page
        .getByRole('button', { name: '出库登记', exact: true })
        .click()
        .catch(async error => {
          process.stderr.write((await page.locator('body').innerText()) + JSON.stringify(errors));
          throw error;
        });
    };
    const dialog = page.getByRole('dialog');
    const lookup = async sn => {
      await dialog.getByLabel('序列号（SN）', { exact: true }).fill(sn);
      await dialog.getByRole('button', { name: '查询设备', exact: true }).click();
    };
    const people = async () => {
      await dialog.getByRole('combobox', { name: '销售人', exact: true }).fill('合成销售');
      await dialog.getByRole('combobox', { name: '出货人', exact: true }).fill('合成出货');
      await dialog.getByLabel('售价（元）', { exact: true }).fill('12000');
    };
    await open();
    await lookup('XY12CD34EF');
    await dialog.getByText('此设备尚未入库，本次将一并创建入库记录。').waitFor();
    await dialog.getByLabel('机器型号 / 容量 / 颜色').selectOption('p1');
    await dialog.getByLabel('入库仓库').selectOption('w1');
    await people();
    assert.equal(await dialog.getByLabel('成本价（元）').inputValue(), '10999.00');
    await dialog.getByLabel('出售日期').fill('2026-10-08');
    assert.equal(await dialog.getByLabel('入库日期').inputValue(), '2026-10-08');
    await dialog.getByLabel('入库日期').fill('2026-10-06');
    await dialog.getByLabel('出售日期').fill('2026-10-09');
    assert.equal(await dialog.getByLabel('入库日期').inputValue(), '2026-10-06');
    await dialog.getByRole('checkbox').check();
    await dialog.getByLabel('货款状况').selectOption('company_received');
    assert.equal(await dialog.getByRole('button', { name: '确认出库' }).isDisabled(), true);
    await dialog.getByLabel('货款状况').selectOption('agent_pending');
    await page.screenshot({ path: `${output}/出库登记-PC.png`, fullPage: true });
    await dialog.getByRole('button', { name: '确认出库' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(submissions[0].unit.needsReceive, true);
    assert.equal(submissions[0].unit.settlementAmount, null);
    assert.equal(submissions[0].payment.status, 'agent_pending');
    assert.equal(submissions[0].unit.officialCostAmount, undefined);

    // 自动相机识别完整规格，成功后释放所有轨道；手机表单无横向溢出。
    await page.setViewportSize({ width: 375, height: 812 });
    await open();
    await dialog.getByRole('button', { name: '开启实时识别' }).click();
    await dialog.getByText('已匹配库存设备 · 测试仓库').waitFor();
    assert.equal(ocrCount, 1);
    assert.equal(await dialog.getByLabel('机器型号 / 容量 / 颜色').inputValue(), 'p1');
    assert.equal(await dialog.getByLabel('成本价（元）').inputValue(), '10000.00');
    assert.equal(
      await page.evaluate(() => window.cameraTracks.every(track => track.readyState === 'ended')),
      true
    );
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await people();
    await dialog.getByLabel('货款状况').selectOption('unpaid');
    await dialog.getByLabel('成本价（元）').fill('10100');
    await dialog.getByRole('checkbox').check();
    await dialog.locator('.stock-dialog-scroll').evaluate(el => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: `${output}/出库登记-H5.png`, fullPage: true });
    dispatchFails = true;
    await dialog.getByRole('button', { name: '确认出库' }).click();
    await dialog.getByText(/记录已被其他人修改/).waitFor();
    const failed = submissions.at(-1);
    await dialog.getByRole('button', { name: '确认出库' }).click();
    await page.waitForFunction(() => document.querySelector('[role="alert"]') !== null);
    assert.equal(submissions.at(-1).requestKey, failed.requestKey);
    assert.equal(failed.unit.officialCostAmount, '10100.00');
    assert.equal(failed.unit.expectedVersion, 3);
    await dialog.getByRole('button', { name: '关闭出库登记' }).click();
    dispatchFails = false;

    const image = await page.screenshot();
    await open();
    ocrMode = 'conflict';
    await dialog
      .getByLabel('上传盒标照片')
      .setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: image });
    await dialog.getByText('盒标规格与库存记录不一致，请核对盒标或先更正库存资料').waitFor();
    assert.equal(await dialog.getByRole('button', { name: '确认出库' }).isDisabled(), true);
    await lookup('ZZ12CD34EF');
    await dialog.getByText('该设备已售出或不在可出库状态').waitFor();
    await dialog.getByRole('button', { name: '关闭出库登记' }).click();

    await open();
    ocrMode = 'quota';
    await dialog.getByRole('button', { name: '开启实时识别' }).click();
    await dialog.getByText('本月识别额度已用完').waitFor();
    assert.equal(
      await page.evaluate(() => window.cameraTracks.every(track => track.readyState === 'ended')),
      true
    );
    await dialog.getByRole('button', { name: '关闭出库登记' }).click();

    // 关闭时取消请求，迟到 OCR 不触发新设备查询。
    await open();
    ocrMode = 'slow';
    const before = reads.length;
    const countBefore = ocrCount;
    await dialog.getByRole('button', { name: '开启实时识别' }).click();
    for (let attempt = 0; ocrCount === countBefore && attempt < 50; attempt += 1)
      await page.waitForTimeout(100);
    assert(ocrCount > countBefore);
    await dialog.getByRole('button', { name: '关闭出库登记' }).click();
    assert.equal(
      await page.evaluate(() => window.cameraTracks.every(track => track.readyState === 'ended')),
      true
    );
    await page.waitForTimeout(1800);
    assert.equal(reads.length, before);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open();
    ocrMode = 'success';
    await dialog
      .getByLabel('上传盒标照片')
      .setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: image });
    await dialog.getByText('已匹配库存设备 · 测试仓库').waitFor();
    assert.equal(
      await dialog.getByLabel('序列号（SN）', { exact: true }).inputValue(),
      unit.serialNumber
    );
    await dialog.getByRole('button', { name: '关闭出库登记' }).click();
    assert.deepEqual(errors, []);
    process.stdout.write(
      'PC/H5 单台表单、实时取帧、图片冲突、成本、日期、货款拦截、版本冲突幂等及相机清理通过（合成接口/相机）。\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
