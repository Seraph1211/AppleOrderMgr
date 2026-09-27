/* eslint-env node, browser */
// 云响应和绑定均为合成请求，不访问真实订单、不消耗 OCR 额度。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const output = '/tmp/pickup-ocr-browser';
  fs.mkdirSync(output, { recursive: true });
  const errors = [];
  const posts = [];
  let ocrMode = 'multiple';
  let readOnly = false;
  let failSerial = '';
  let delayBinding = true;
  let releaseBinding;
  let releaseOcr;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('token', 'synthetic-ocr-token'));
    const order = {
      orderId: 9001,
      orderNumber: 'W9701000672',
      recipientName: 'OCR测试',
      tag: 'OCR测试',
      products: [],
      status: 'pending',
      version: 0,
      evidence: [],
    };
    const devices = [];
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let data = {};
      if (url.pathname === '/api/auth/me')
        data = {
          id: 7,
          role: 'pickupStaff',
          username: 'ocr_test',
          permissions: readOnly ? ['pickups.read'] : ['pickups.read', 'pickups.edit'],
          orderAccess: { mode: 'tags', tags: ['OCR测试'] },
          availableHome: '/pickups',
        };
      else if (url.pathname === '/api/pickups')
        data = { items: [order], total: 1, page: 1, limit: 20 };
      else if (url.pathname === '/api/pickups/filter-options') data = { tags: ['OCR测试'] };
      else if (url.pathname === '/api/pickups/9001/devices/ocr') {
        assert.match(request.headers()['content-type'], /^multipart\/form-data; boundary=/);
        if (ocrMode === 'delay')
          await new Promise(resolve => {
            releaseOcr = resolve;
          });
        if (ocrMode === 'fail')
          return route.fulfill({
            status: 502,
            json: { error: { message: '云端识别失败，请重试' } },
          });
        data = {
          candidates:
            ocrMode === 'single' ? ['S234567890'] : ['TEST000001', 'TEST000002', 'TEST000003'],
          provider: 'aliyun',
          requestId: 'synthetic',
        };
      } else if (url.pathname === '/api/pickups/9001/devices') {
        if (request.method() === 'POST') {
          const payload = request.postDataJSON();
          posts.push(payload);
          if (delayBinding) {
            delayBinding = false;
            await new Promise(resolve => {
              releaseBinding = resolve;
            });
          }
          if (payload.serialBarcode === failSerial)
            return route.fulfill({
              status: 409,
              json: { error: { message: '该序列号已绑定其他订单' } },
            });
          let device = devices.find(item => item.serialNumber === payload.serialBarcode);
          const alreadyBound = Boolean(device);
          if (!device) {
            device = {
              id: String(devices.length + 1),
              serialNumber: payload.serialBarcode,
              createdAt: new Date().toISOString(),
            };
            devices.push(device);
          }
          data = { device, alreadyBound };
        } else data = { items: devices, orderId: 9001 };
      }
      await route.fulfill({ json: { success: true, data } });
    });
    await page.goto(process.env.PICKUP_OCR_TEST_URL || 'http://localhost:5173/pickups');
    await page
      .getByRole('button', { name: '设备扫码', exact: true })
      .filter({ visible: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '设备扫码登记' });
    const openOcr = () =>
      dialog.getByRole('button', { name: '拍照 / 图片识别 Serial No.', exact: true }).click();
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 300;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 1000, 300);
      ctx.fillStyle = 'black';
      ctx.font = '32px monospace';
      ctx.fillText('Serial No. TEST000001', 20, 150);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const file = {
      name: 'synthetic-label.png',
      mimeType: 'image/png',
      buffer: Buffer.from(image, 'base64'),
    };
    const upload = () => dialog.getByLabel('选择序列号图片').setInputFiles(file);
    const fields = () => dialog.getByRole('textbox', { name: /^核对 Serial No\./ });
    const confirm = count =>
      dialog.getByRole('button', { name: `确认绑定 ${count} 台`, exact: true });
    await openOcr();
    await upload();
    await dialog.getByRole('table', { name: '待绑定序列号' }).waitFor();
    assert.equal(await fields().count(), 3);
    assert.equal(posts.length, 0);
    await dialog.getByRole('button', { name: '删除序列号 2', exact: true }).click();
    await fields().nth(0).fill('S234567890');
    await fields().nth(1).fill('S234567890');
    assert.equal(await confirm(2).isEnabled(), false);
    await dialog.getByRole('alert').filter({ hasText: '序列号重复' }).waitFor();
    await fields().nth(1).fill('BAD');
    assert.equal(await confirm(2).isEnabled(), false);
    await fields().nth(1).fill('TEST000003');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth));
      assert(
        await dialog
          .getByRole('table', { name: '待绑定序列号' })
          .evaluate(element => element.scrollWidth <= element.clientWidth)
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/批量核对-390.png` });
    await confirm(2).click();
    while (!releaseBinding) await page.waitForTimeout(20);
    assert.equal(
      await dialog.getByRole('button', { name: '正在绑定…', exact: true }).isEnabled(),
      false
    );
    assert.equal(await dialog.getByRole('button', { name: '关闭设备扫码' }).isEnabled(), false);
    assert.equal(
      await dialog.getByRole('button', { name: '删除序列号 1', exact: true }).isEnabled(),
      false
    );
    releaseBinding();
    await dialog.getByText('已登记 2 台').waitFor();
    assert.deepEqual(
      posts.map(item => item.serialBarcode),
      ['S234567890', 'TEST000003']
    );
    await openOcr();
    await upload();
    await confirm(3).waitFor();
    failSerial = 'TEST000002';
    await confirm(3).click();
    await dialog.getByRole('alert').filter({ hasText: '该序列号已绑定其他订单' }).waitFor();
    await dialog.getByText('本次已确认 2 台，剩余 1 台未确认绑定。', { exact: true }).waitFor();
    assert.equal(await fields().count(), 1);
    assert.equal(await fields().inputValue(), 'TEST000002');
    assert.equal(posts.length, 5);
    failSerial = '';
    await confirm(1).click();
    await dialog.getByText('已登记 4 台').waitFor();
    assert.equal(posts.length, 6);
    assert.equal(posts[5].serialBarcode, 'TEST000002');
    await openOcr();
    await upload();
    await confirm(3).waitFor();
    for (let index = 0; index < 3; index++)
      await dialog.getByRole('button', { name: '删除序列号 1', exact: true }).click();
    assert.equal(await confirm(0).isEnabled(), false);
    assert.equal(posts.length, 6);
    await dialog.getByRole('button', { name: '手动添加序列号', exact: true }).click();
    await fields().fill('S234567890');
    assert.equal(await confirm(1).isEnabled(), true);
    ocrMode = 'fail';
    await upload();
    await dialog.getByRole('alert').filter({ hasText: '云端识别失败' }).waitFor();
    ocrMode = 'single';
    await upload();
    await confirm(1).waitFor();
    assert.equal(await fields().inputValue(), 'S234567890');
    await dialog.getByRole('button', { name: '返回条码扫描', exact: true }).click();
    await openOcr();
    ocrMode = 'delay';
    await upload();
    while (!releaseOcr) await page.waitForTimeout(20);
    await dialog.getByRole('button', { name: '取消识别', exact: true }).click();
    releaseOcr();
    await dialog.getByRole('button', { name: '拍照 / 图片识别 Serial No.', exact: true }).waitFor();
    assert.equal(posts.length, 6);
    await dialog.getByRole('button', { name: '关闭设备扫码' }).click();
    readOnly = true;
    await page.reload();
    await page.getByRole('button', { name: '设备', exact: true }).filter({ visible: true }).click();
    assert.equal(
      await dialog.getByRole('button', { name: '拍照 / 图片识别 Serial No.', exact: true }).count(),
      0
    );
    assert.deepEqual(errors, []);
    process.stdout.write(
      'OCR 批量验收通过：全部列出、删除、修改、重复/非法/空列表拦截、一键多台、部分失败仅重试剩余、绑定中禁操作、真实 S、取消、只读及 320–1440 布局。\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
