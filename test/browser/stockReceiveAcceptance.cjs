const { chooseSelect, selectValue } = require('./responsiveSelectSupport.cjs');
/* eslint-env node, browser */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.STOCK_BASE_URL || 'http://127.0.0.1:5332';
const output = process.env.OUTPUT_DIR || '.tmp/stock-receive-ui';
const freshSn = 'XY12CD34EF';
const registeredSn = 'AB12CD34EF';
const product = {
  id: 'p1',
  modelName: 'iPhone 18 Pro Max',
  storageGb: 256,
  colorName: '银色',
  entryEligible: true,
};
const second = { ...product, id: 'p2', storageGb: 512 };
const permissions = ['stock.read', 'stock.receive', 'stock.source.link', 'orders.read'];
async function setup(browser, width, readonly = false, permissionOverride = null) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(15000);
  const state = {
    errors: [],
    reads: [],
    writes: [],
    ocr: [],
    mode: 'success',
    sn: freshSn,
    productId: 'p1',
    failWrite: false,
    failPreview: false,
  };
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    localStorage.setItem('token', 'synthetic-receive');
    window.cameraTracks = [];
    window.cameraDenied = false;
    window.nextBarcode = 'SXY12CD34EF';
    window.MockBarcodeDetector = class {
      async detect() {
        await Promise.resolve();
        return [{ rawValue: window.nextBarcode }, { rawValue: '123456789012345' }];
      }
    };
    window.BarcodeDetector = window.MockBarcodeDetector;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        await Promise.resolve();
        if (window.cameraDenied) throw new DOMException('denied', 'NotAllowedError');
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, 640, 480);
        const stream = canvas.captureStream(10);
        window.cameraTracks.push(...stream.getTracks());
        return stream;
      },
    });
  });
  await page.route('**/api/**', async route => {
    const req = route.request(),
      url = new URL(req.url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let data = {},
      status = 200,
      error;
    if (url.pathname.endsWith('/auth/me'))
      data = {
        id: 1,
        role: 'operator',
        username: '合成入库验收',
        permissions: permissionOverride || (readonly ? ['stock.read'] : permissions),
      };
    else if (url.pathname.endsWith('/ledger/catalog'))
      data = {
        enabled: true,
        products: [
          product,
          second,
          { ...product, id: 'legacy', modelName: '旧型号', entryEligible: false },
        ],
        warehouses: [{ id: 'w1', name: '长沙 明威' }],
        people: [],
      };
    else if (url.pathname.endsWith('/ledger/receive-preview')) {
      const sn = url.searchParams.get('serialNumber');
      state.reads.push(sn);
      if (sn === 'ZZ12CD34EF' || state.failPreview) {
        status = state.failPreview ? 503 : 409;
        error = {
          code: 'UNIT_STATE_CONFLICT',
          message: state.failPreview ? '合成预览暂不可用' : '该 SN 已入库或已售，请查看原记录',
        };
      } else
        data = {
          canReceive: true,
          unit:
            sn === registeredSn
              ? {
                id: 'u1',
                version: 3,
                state: 'registered',
                serialNumber: registeredSn,
                product,
                orderLinked: true,
                orderNumber: 'W1234567890',
              }
              : null,
        };
    } else if (url.pathname.endsWith('/ledger/receive')) {
      state.writes.push(req.postDataJSON());
      if (state.failWrite) {
        status = 500;
        error = { code: 'TEST_RETRY', message: '合成提交未确认，请重试' };
      } else
        data = {
          items: [
            {
              id: 'u1',
              serialNumber: state.writes.at(-1).units[0].serialNumber,
              state: 'in_stock',
            },
          ],
        };
    } else if (url.pathname.endsWith('/box/recognize')) {
      state.ocr.push(req.postData());
      if (state.mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1800));
      if (state.mode === 'quota') {
        status = 429;
        error = { code: 'OCR_MONTHLY_LIMIT', message: '本月识别额度已用完' };
      } else
        data = {
          candidates: [
            {
              serialNumber: state.mode === 'ambiguous' ? '' : state.sn,
              productId: state.productId,
              reviewReasons: state.mode === 'low' ? ['SN 文字与条码不一致'] : [],
              sources: { serial: 'barcode' },
            },
          ],
        };
    } else if (url.pathname.endsWith('/ledger'))
      data = { items: [], total: 0, counts: { pending: 0, inStock: 0, sold: 0, returned: 0 } };
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(error ? { success: false, error } : { success: true, data }),
    });
  });
  await page.goto(`${base}/stock`);
  await page.getByRole('tab', { name: /^在库/ }).waitFor();
  return { page, state };
}
async function waitState(page, predicate) {
  for (let i = 0; i < 80; i += 1) {
    if (predicate()) return;
    await page.waitForTimeout(100);
  }
  assert.fail('等待预期请求超时');
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const barcodePage = await browser.newPage({ viewport: { width: 900, height: 300 } });
    await barcodePage.setContent(fs.readFileSync('test/fixtures/stockReceiveCode128.svg', 'utf8'));
    const barcodeImage = await barcodePage.locator('svg').screenshot();
    fs.writeFileSync(`${output}/合成SN-Code128.png`, barcodeImage);
    await barcodePage.close();
    for (const width of [1440, 375]) {
      const { page, state } = await setup(browser, width);
      const dialog = page.getByRole('dialog', { name: '入库登记', exact: true });
      const open = async () => {
        await page.getByRole('button', { name: '入库登记', exact: true }).click();
        await dialog.waitFor();
      };
      const close = async () => {
        await dialog.getByRole('button', { name: '关闭入库登记', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
      };
      const lookup = async sn => {
        await dialog.getByLabel('序列号（SN）', { exact: true }).fill(sn);
        await dialog.getByRole('button', { name: '查询设备', exact: true }).click();
      };
      const fillWarehouse = async () => {
        await chooseSelect(dialog.getByLabel('入库仓库'), 'w1');
        await dialog.getByLabel('入库日期', { exact: true }).fill('2026-10-09');
      };
      const save = dialog.getByRole('button', { name: '确认入库 1 台', exact: true });
      const checkbox = dialog.getByRole('checkbox');
      const image = barcodeImage;
      await page.evaluate(() => {
        window.BarcodeDetector = undefined;
      });
      await open();
      assert.equal(await dialog.getByRole('button', { name: /添加.*设备|添加一行/ }).count(), 0);
      assert.equal(
        await dialog.getByLabel('机器型号 / 容量 / 颜色').locator('option[value="legacy"]').count(),
        0
      );
      await fillWarehouse();
      await dialog.getByLabel('订单号（可选）').fill('W1888888888');
      state.mode = 'low';
      await dialog
        .getByLabel('上传盒标照片')
        .setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: image });
      await dialog.getByText('这是新设备，确认后创建入库记录。', { exact: true }).waitFor();
      await dialog.getByText(/识别需核对：SN 文字与条码不一致/).waitFor();
      assert.equal(
        await dialog.getByRole('img', { name: '本次盒标照片', exact: true }).isVisible(),
        true
      );
      assert.equal(await dialog.getByLabel('序列号（SN）', { exact: true }).inputValue(), freshSn);
      assert.equal(await selectValue(dialog.getByLabel('机器型号 / 容量 / 颜色')), 'p1');
      assert.equal(await selectValue(dialog.getByLabel('入库仓库')), 'w1');
      assert.equal(await dialog.getByLabel('入库日期', { exact: true }).inputValue(), '2026-10-09');
      assert.equal(await dialog.getByLabel('订单号（可选）').inputValue(), 'W1888888888');
      assert.match(state.ocr[0], /SXY12CD34EF/);
      assert.doesNotMatch(state.ocr[0], /123456789012345/);
      await page.evaluate(() => {
        window.BarcodeDetector = window.MockBarcodeDetector;
      });
      assert.equal(state.writes.length, 0);
      assert.equal(await save.isDisabled(), true);
      await checkbox.check();
      await chooseSelect(dialog.getByLabel('机器型号 / 容量 / 颜色'), 'p2');
      assert.equal(await checkbox.isChecked(), false);
      await dialog.getByText(/当前规格与识别结果不同/).waitFor();
      await chooseSelect(dialog.getByLabel('机器型号 / 容量 / 颜色'), 'p1');
      await checkbox.check();
      await dialog.locator('.stock-dialog-scroll').evaluate(node => {
        node.scrollTop = 0;
      });
      assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${output}/入库识别-${width}.png` });
      await dialog.locator('.stock-dialog-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
      const confirmBox = await checkbox.boundingBox();
      const footerBox = await dialog.locator('.ledger-form-actions').boundingBox();
      assert.ok(confirmBox.y + confirmBox.height <= footerBox.y, '确认框不可被底栏遮挡');
      const dateBox = await dialog.getByLabel('入库日期', { exact: true }).boundingBox();
      const headerBox = await dialog.locator('header').boundingBox();
      const orderBox = await dialog.getByLabel('订单号（可选）').boundingBox();
      for (const box of [dateBox, orderBox, confirmBox]) {
        assert.ok(box.y >= headerBox.y + headerBox.height && box.y + box.height <= footerBox.y, '日期、订单及核对框须完整可见');
      }
      await page.screenshot({ path: `${output}/入库确认-${width}.png` });
      state.failWrite = true;
      await save.click();
      await dialog.getByText('合成提交未确认，请重试', { exact: true }).waitFor();
      assert.equal(await selectValue(dialog.getByLabel('入库仓库')), 'w1');
      const failed = state.writes.at(-1);
      state.failWrite = false;
      await save.click();
      await dialog.waitFor({ state: 'hidden' });
      const saved = state.writes.at(-1);
      assert.equal(saved.requestKey, failed.requestKey);
      assert.equal(saved.units.length, 1);
      assert.deepEqual(saved.units[0], {
        serialNumber: freshSn,
        expectedVersion: null,
        productId: 'p1',
        warehouseId: 'w1',
        receivedOn: '2026-10-09',
        orderNumber: 'W1888888888',
      });
      await open();
      await lookup('ZZ12CD34EF');
      await dialog.getByText('该 SN 已入库或已售，请查看原记录', { exact: true }).waitFor();
      assert.equal(await save.isDisabled(), true);
      state.failPreview = true;
      await lookup(freshSn);
      await dialog.getByText('合成预览暂不可用', { exact: true }).waitFor();
      state.failPreview = false;
      await lookup(registeredSn);
      await dialog.getByText(/已关联订单：W1234567890/).waitFor();
      assert.equal(await dialog.getByLabel('订单号（可选）').count(), 0);
      await fillWarehouse();
      await chooseSelect(dialog.getByLabel('机器型号 / 容量 / 颜色'), 'p2');
      await dialog.getByText(/设备规格与已有记录不一致/).waitFor();
      assert.equal(await checkbox.isDisabled(), true);
      assert.equal(await save.isDisabled(), true);
      await chooseSelect(dialog.getByLabel('机器型号 / 容量 / 颜色'), 'p1');
      await checkbox.check();
      await save.click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(state.writes.at(-1).units[0].expectedVersion, 3);
      assert.equal(state.writes.at(-1).units[0].orderNumber, undefined);
      // 新设备允许不填写订单，一次一台；修改SN后必须重新查询。
      await open();
      await lookup(freshSn);
      await fillWarehouse();
      await chooseSelect(dialog.getByLabel('机器型号 / 容量 / 颜色'), 'p1');
      await checkbox.check();
      await dialog.getByLabel('序列号（SN）', { exact: true }).fill('CD12EF34GH');
      assert.equal(await save.isDisabled(), true);
      await dialog.getByRole('button', { name: '查询设备', exact: true }).click();
      await dialog.getByText('这是新设备，确认后创建入库记录。', { exact: true }).waitFor();
      await checkbox.check();
      await save.click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(state.writes.at(-1).units[0].orderNumber, undefined);
      state.mode = 'success';
      state.sn = registeredSn;
      await page.evaluate(() => {
        window.nextBarcode = 'SAB12CD34EF';
      });
      await open();
      await dialog.getByRole('button', { name: '开启实时识别', exact: true }).click();
      await dialog.getByText('已匹配未入库设备，确认后登记至所选仓库。', { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            window.cameraTracks.length > 0 &&
            window.cameraTracks.every(track => track.readyState === 'ended')
        ),
        true
      );
      await close();
      await open();
      await page.evaluate(() => {
        window.cameraDenied = true;
      });
      await dialog.getByRole('button', { name: '开启实时识别', exact: true }).click();
      await dialog.getByText(/相机权限未开启/).waitFor();
      await page.evaluate(() => {
        window.cameraDenied = false;
      });
      await close();
      // 停止及关闭隔离迟到OCR，不触发新的设备查询。
      for (const stopByClose of [false, true]) {
        await open();
        state.mode = 'slow';
        const readsBefore = state.reads.length,
          ocrBefore = state.ocr.length;
        await dialog.getByRole('button', { name: '开启实时识别', exact: true }).click();
        await waitState(page, () => state.ocr.length > ocrBefore);
        if (stopByClose) await close();
        else await dialog.getByRole('button', { name: '停止实时识别', exact: true }).click();
        await page.waitForTimeout(2100);
        assert.equal(state.reads.length, readsBefore);
        assert.equal(
          await page.evaluate(() =>
            window.cameraTracks.every(track => track.readyState === 'ended')
          ),
          true
        );
        if (!stopByClose) await close();
      }
      await open();
      state.mode = 'ambiguous';
      await dialog
        .getByLabel('上传盒标照片')
        .setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: image });
      await dialog
        .getByText('未识别出唯一 SN，请对照照片补充 SN 后查询设备', { exact: true })
        .waitFor();
      assert.equal(await save.isDisabled(), true);
      await close();
      await open();
      await lookup(freshSn);
      await fillWarehouse();
      await chooseSelect(dialog.getByLabel('机器型号 / 容量 / 颜色'), 'p1');
      await checkbox.check();
      state.mode = 'quota';
      await dialog
        .getByLabel('上传盒标照片')
        .setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: image });
      await dialog.getByText(/本月识别额度已用完.*本次识别未应用/).waitFor();
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(await dialog.getByLabel('序列号（SN）', { exact: true }).inputValue(), freshSn);
      assert.equal(await save.isDisabled(), true);
      await close();
      assert.deepEqual(state.errors, []);
      await page.close();
    }
    const sourceOnly = await setup(browser, 375, false, [
      'stock.read',
      'stock.receive',
      'stock.source.link',
    ]);
    await sourceOnly.page.getByRole('button', { name: '入库登记', exact: true }).click();
    assert.equal(await sourceOnly.page.getByLabel('订单号（可选）').count(), 0);
    await sourceOnly.page.close();
    const limited = await setup(browser, 375, true);
    assert.equal(
      await limited.page.getByRole('button', { name: '入库登记', exact: true }).count(),
      0
    );
    assert.deepEqual(limited.state.ocr, []);
    assert.deepEqual(limited.state.writes, []);
    await limited.page.close();
    process.stdout.write(
      'PASS: 单台入库1440/375，上传/相机、条码传递、低可信确认、幂等重试、状态/规格拦截、订单可空、权限与停止清理\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
