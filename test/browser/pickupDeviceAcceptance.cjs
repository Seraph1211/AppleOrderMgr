/* eslint-env node, browser */
// 合成条码经真实 ZXing 解码；只拦截相机来源和 API，不替换解码结果。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const fixtures = require('../fixtures/pickupCode128.json');

(async () => {
  const output = process.env.PICKUP_DEVICE_ARTIFACT_DIR || '/tmp/pickup-device-browser';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const errors = [];
  const posts = [];
  let page;
  let devices = [];
  let failAfterCommit = true;
  let readOnly = false;
  const order = {
    orderId: 9001,
    orderNumber: 'W9701000672',
    recipientName: '扫码测试人员',
    tag: '扫码测试',
    products: [{ name: '测试手机', quantity: 2 }],
    status: 'pending',
    version: 0,
    evidence: [],
    settlementAmount: null,
  };
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(
      ({ fixtures }) => {
        localStorage.setItem('token', 'synthetic-device-token');
        window.fixtureKey = 'serial';
        window.cameraMode = 'normal';
        window.cameraTracks = [];
        navigator.mediaDevices.getUserMedia = async () => {
          if (window.cameraMode === 'denied')
            throw new DOMException('synthetic denial', 'NotAllowedError');
          if (window.cameraMode === 'pending')
            await new Promise(resolve => {
              window.releaseCamera = resolve;
            });
          const canvas = document.createElement('canvas');
          canvas.width = 1280;
          canvas.height = 720;
          const ctx = canvas.getContext('2d');
          const paint = () => {
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, 1280, 720);
            const widths = fixtures[window.fixtureKey].widths;
            const scale = Math.min(4, 1000 / widths.reduce((sum, x) => sum + x, 0));
            let x = (1280 - widths.reduce((sum, w) => sum + w * scale, 0)) / 2;
            ctx.fillStyle = 'black';
            widths.forEach((width, index) => {
              if (index % 2 === 0) ctx.fillRect(x, 210, width * scale, 300);
              x += width * scale;
            });
          };
          paint();
          const stream = canvas.captureStream(12);
          const track = stream.getVideoTracks()[0];
          window.cameraTracks.push(track);
          const timer = setInterval(() => {
            if (track.readyState === 'ended') clearInterval(timer);
            else paint();
          }, 80);
          return stream;
        };
      },
      { fixtures }
    );
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let data;
      if (url.pathname === '/api/auth/me')
        data = {
          id: 7,
          username: 'scan_test',
          nickname: '测试员工',
          role: 'pickupStaff',
          permissions: readOnly
            ? ['pickups.read']
            : ['pickups.read', 'pickups.edit', 'orders.read'],
          orderAccess: { mode: 'tags', tags: ['扫码测试'] },
          availableHome: '/pickups',
        };
      else if (url.pathname === '/api/orders/filter-options')
        data = {
          recipientTags: [],
          productOptions: [],
          productModels: [],
          productNames: [],
          stores: [],
          recipients: [],
          payers: [],
        };
      else if (url.pathname === '/api/orders') {
        const keyword = url.searchParams.get('keyword') || '';
        const matches =
          !keyword ||
          devices.some(d => d.serialNumber.toLowerCase().includes(keyword.toLowerCase()));
        data = {
          orders: matches
            ? [
                {
                  id: 9001,
                  order_number: order.orderNumber,
                  serial_numbers: devices.map(d => d.serialNumber),
                  products: order.products,
                },
              ]
            : [],
          total: matches ? 1 : 0,
          page: 1,
          limit: 20,
        };
      } else if (url.pathname === '/api/pickups/filter-options') data = { tags: ['扫码测试'] };
      else if (url.pathname === '/api/pickups')
        data = { items: [order], total: 1, page: 1, pageSize: 20 };
      else if (url.pathname === '/api/pickups/9001/devices') {
        if (request.method() === 'POST') {
          const body = request.postDataJSON();
          posts.push(body);
          let device = devices.find(d => d.serialNumber === body.serialBarcode.slice(1));
          const alreadyBound = Boolean(device);
          if (!device) {
            device = {
              id: `device-${posts.length}`,
              orderId: 9001,
              serialNumber: body.serialBarcode.slice(1),
              createdAt: new Date().toISOString(),
            };
            devices.push(device);
          }
          if (failAfterCommit) {
            failAfterCommit = false;
            return route.abort('failed');
          }
          return route.fulfill({
            status: alreadyBound ? 200 : 201,
            json: { success: true, data: { device, alreadyBound } },
          });
        }
        data = { orderId: 9001, items: devices };
      } else if (
        url.pathname.startsWith('/api/pickups/9001/devices/') &&
        request.method() === 'DELETE'
      ) {
        devices = devices.filter(d => d.id !== url.pathname.split('/').pop());
        data = { removed: true };
      } else if (url.pathname === '/api/pickups/9001/events') data = [];
      else data = {};
      return route.fulfill({ json: { success: true, data } });
    });
    const base = process.env.PICKUP_DEVICE_BASE_URL || 'http://localhost:5173';
    await page.goto(`${base}/pickups`);

    await page
      .getByRole('button', { name: '设备扫码', exact: true })
      .filter({ visible: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '设备扫码登记' });
    await dialog.getByText('此订单尚未登记设备。').waitFor();
    for (const width of [320, 375, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `width ${width}`
      );
      assert(
        await dialog.evaluate(el => el.scrollWidth <= el.clientWidth),
        `dialog width ${width}`
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, '扫码入口-390.png') });
    assert.equal(await dialog.getByText('IMEI', { exact: true }).count(), 0);
    await page.evaluate(() => {
      window.fixtureKey = 'invalidImei';
    });
    await dialog.getByRole('button', { name: '扫描 Serial No.', exact: true }).click();
    await page.waitForTimeout(1200);
    assert.equal(posts.length, 0, 'numeric IMEI must not bind as serial');
    await page.evaluate(() => {
      window.fixtureKey = 'serial';
    });
    await dialog.getByRole('button', { name: '重试保存本台设备' }).waitFor({ timeout: 20000 });
    assert.equal(devices.length, 1, 'simulated server committed once');
    await page.screenshot({ path: path.join(output, '保存失败可重试-390.png') });
    await dialog.getByRole('button', { name: '重试保存本台设备' }).click();
    await dialog.getByRole('button', { name: '扫描下一台' }).waitFor();
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0], posts[1]);
    assert.deepEqual(Object.keys(posts[0]), ['serialBarcode']);
    assert.equal(devices.length, 1);
    await page.evaluate(() => {
      window.fixtureKey = 'serial2';
    });
    await dialog.getByRole('button', { name: '扫描下一台' }).click();
    await dialog.getByRole('button', { name: '扫描下一台' }).waitFor({ timeout: 20000 });
    await dialog.getByText('已登记 2 台').waitFor();
    assert.equal(devices.length, 2);
    await page.screenshot({ path: path.join(output, '两台绑定成功-390.png') });
    await page.evaluate(() => {
      window.cameraMode = 'denied';
    });
    await dialog.getByRole('button', { name: '扫描下一台' }).click();
    await dialog.getByRole('alert').filter({ hasText: '相机权限未开启' }).waitFor();
    await page.evaluate(() => {
      window.cameraMode = 'pending';
    });
    await dialog.getByRole('button', { name: '扫描 Serial No.', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.releaseCamera));
    await dialog.getByRole('button', { name: '关闭设备扫码' }).click();
    await page.evaluate(() => window.releaseCamera());
    await page.waitForFunction(() => window.cameraTracks.every(t => t.readyState === 'ended'));
    await page.evaluate(() => {
      window.cameraMode = 'normal';
    });
    await page
      .getByRole('button', { name: '设备扫码', exact: true })
      .filter({ visible: true })
      .click();
    await dialog.getByText('已登记 2 台').waitFor();
    await dialog.getByRole('button', { name: '解除绑定', exact: true }).first().click();
    const confirmation = page.getByRole('alertdialog', { name: '确认解除设备绑定' });
    await confirmation.getByText('Serial No. TEST000001', { exact: true }).waitFor();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(devices.length, 2);
    await dialog.getByRole('button', { name: '解除绑定', exact: true }).first().click();
    await confirmation.getByRole('button', { name: '确认解除绑定', exact: true }).click();
    await dialog.getByText('已登记 1 台').waitFor();
    assert.equal(devices.length, 1);
    await page.evaluate(() => {
      window.fixtureKey = 'serial';
    });
    await dialog.getByRole('button', { name: '扫描 Serial No.', exact: true }).click();
    await dialog.getByText('已登记 2 台').waitFor({ timeout: 20000 });
    await dialog.getByRole('button', { name: '关闭设备扫码' }).click();
    readOnly = true;
    await page.reload();
    await page.getByRole('button', { name: '设备', exact: true }).filter({ visible: true }).click();
    await dialog.getByText('已登记 2 台').waitFor();
    assert.equal(
      await dialog.getByRole('button', { name: '扫描 Serial No.', exact: true }).count(),
      0
    );
    readOnly = false;
    await page.evaluate(() =>
      localStorage.setItem(
        'columnConfig:orders',
        JSON.stringify({
          columns: [
            { key: 'orderNumber', visible: true, order: 0 },
            { key: 'actions', visible: true, order: 1 },
          ],
        })
      )
    );
    await page.goto(`${base}/orders`);
    await page.getByRole('columnheader', { name: 'Serial No.', exact: true }).waitFor();
    await page.getByText('TEST000001', { exact: true }).waitFor();
    await page.getByText('TEST000002', { exact: true }).waitFor();
    const search = page.getByPlaceholder('搜索订单 ID、订单号、Serial No.、Apple ID 或取机人...');
    const searched = page.waitForResponse(
      r =>
        new URL(r.url()).pathname === '/api/orders' &&
        new URL(r.url()).searchParams.get('keyword') === 'test000002'
    );
    await search.fill('test000002');
    await searched;
    await page.getByText('TEST000002', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, '订单序列号搜索-390.png') });
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          browser: 'Chromium',
          decoder: 'real ZXing Code128',
          bound: devices.length,
          postAttempts: posts.length,
          viewports: [320, 375, 390, 768, 1024, 1440],
          errors,
        },
        null,
        2
      )
    );
    process.stdout.write(
      'PASS: real Code128 decoding, automatic binding, retry idempotency, 2 devices, camera denial/late cleanup, readonly and responsive layout\n'
    );
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(output, '失败现场.png') });
      fs.writeFileSync(path.join(output, '失败现场.txt'), JSON.stringify({ errors, text: await page.locator('body').innerText() }));
    }
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
