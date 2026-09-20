/* global localStorage, window, navigator */
const assert = require('node:assert/strict');
const logger = require('../src/utils/logger');
const fixture = require('../frontend/test/fixtures/paymentQr.json');

/** 专用 Chrome 和合成 API 验证付款地址识读与复制，不访问真实业务或支付地址。 */
async function main() {
  let browser;
  let context;
  try {
    if (!process.env.PAYMENT_BROWSER_WS) throw new Error('需要专用临时浏览器地址');
    const { chromium } = require('playwright-core');
    browser = await chromium.connectOverCDP(process.env.PAYMENT_BROWSER_WS, {
      headers: { Host: '127.0.0.1' },
    });
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => {
      localStorage.setItem('token', 'synthetic-copy-test');
      window.copiedText = 'original-clipboard';
      window.clipboardFails = false;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write: async items => {
            const blob = await items[0].getType('text/plain');
            if (window.clipboardFails) throw new Error('合成剪贴板拒绝');
            window.copiedText = await blob.text();
          },
          writeText: text => {
            if (window.clipboardFails) return Promise.reject(new Error('合成剪贴板拒绝'));
            window.copiedText = text;
            return Promise.resolve();
          },
        },
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const requests = [];
    let mode = 'payment-tasks';
    let permitted = true;
    let state = 'available';
    let image = fixture.valid;
    const orderUrl = id => `https://example.com/order/${id}`;
    const task = id => ({
      id,
      orderId: 100 + id,
      orderNumber: `W${String(id).padStart(10, '0')}`,
      products: [{ name: '合成测试手机', quantity: 2 }],
      paymentMethod: id === 1 ? '微信' : '支付宝',
      officialOrderStatus: 'payment_due',
      officialPaymentStatus: 'unpaid',
      processingStatus: 'pending',
      version: 0,
      payerVersion: 0,
      orderDate: '2026-09-20T13:02:00Z',
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else {
            if (url.hostname !== 'fonts.googleapis.com' && url.hostname !== 'fonts.gstatic.com')
              errors.push('意外外部请求 ' + url.origin + url.pathname);
            await route.abort();
          }
          return;
        }
        assert.equal(route.request().method(), 'GET');
        requests.push(url.pathname);
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: '合成验收',
            role: 'readOnly',
            permissions:
              mode === 'payment-dispatch'
                ? ['payment_dispatch.read']
                : ['payment_tasks.read_own', ...(permitted ? ['payment_tasks.link.read_own'] : [])],
            availableHome: '/' + mode,
          };
        else if (url.pathname === '/api/payment-dispatch/overview') {
          data = { settings: { enabled: false, mode: 'manual', version: 0 }, staff: [] };
        } else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(url.pathname)) {
          data = {
            items: [task(1), task(2)],
            recipientTagOptions: [],
            productOptions: [],
            pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
          };
        } else if (url.pathname.endsWith('/payment-code')) {
          const id = Number(url.pathname.split('/').at(-2));
          if (state === 'denied') {
            await route.fulfill({
              status: 404,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: '合成任务已转派' } }),
            });
            return;
          }
          data = { availability: id === 2 ? 'unsupported' : state, imageDataUrl: image };
        } else if (url.pathname.endsWith('/payment-link')) {
          data = { paymentUrl: orderUrl(Number(url.pathname.split('/').at(-2))) };
        } else throw new Error('未配置合成 API ' + url.pathname);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    const clipboard = () => page.evaluate(() => window.copiedText);
    const waitCopied = expected =>
      page.waitForFunction(value => window.copiedText === value, expected);
    const expected = (id, url) =>
      `${100 + id} || 合成测试手机 x 2 || ${id === 1 ? '微信' : '支付宝'} || 26/09/20 21:32 || ${url}`;
    for (mode of ['payment-tasks', 'payment-dispatch']) {
      for (const width of [1440, 375]) {
        state = 'available';
        image = fixture.valid;
        await page.setViewportSize({ width, height: 950 });
        await page.goto('http://127.0.0.1:5173/' + mode);
        const first = page.locator('tbody tr').filter({
          has: page.getByRole('button', { name: '复制订单链接 W0000000001', exact: true }),
        });
        const copy = first.getByRole('button', { name: /^复制订单信息/ });
        await copy.waitFor();
        requests.length = 0;
        await copy.click();
        await waitCopied(expected(1, fixture.payload));
        assert.ok(!requests.some(path => path.endsWith('/payment-link')));
        await page.getByRole('button', { name: '复制订单链接 W0000000001', exact: true }).click();
        await waitCopied(orderUrl(1));
        await page.getByRole('checkbox', { name: '选择订单 W0000000001', exact: true }).check();
        await page.getByRole('checkbox', { name: '选择订单 W0000000002', exact: true }).check();
        await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
        await waitCopied(expected(1, fixture.payload) + '\n\n' + expected(2, orderUrl(2)));
        for (const sample of [null, 'data:image/png;base64,AAAA', fixture.unrelated]) {
          state = sample === null ? 'missing' : 'available';
          image = sample;
          await page.evaluate(() => {
            window.copiedText = 'before-fallback';
          });
          await copy.click();
          await waitCopied(expected(1, orderUrl(1)));
        }
        state = 'denied';
        requests.length = 0;
        const before = await clipboard();
        await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
        await page
          .getByText(/合成任务已转派/)
          .first()
          .waitFor();
        assert.equal(await clipboard(), before);
        assert.ok(!requests.some(path => path.endsWith('/payment-link')));
        state = 'available';
        image = fixture.valid;
        await page.evaluate(() => {
          window.clipboardFails = true;
        });
        await copy.click();
        await page
          .getByText(/合成剪贴板拒绝/)
          .first()
          .waitFor();
        assert.equal(await clipboard(), before);
        await page.evaluate(() => {
          window.clipboardFails = false;
        });
        await page.screenshot({ path: `/tmp/payment-copy-${mode}-${width}.png` });
      }
    }
    // writeText 回退浏览器，同样识读真实合成二维码。
    await page.evaluate(() => {
      window.ClipboardItem = undefined;
      window.copiedText = '';
    });
    await page
      .locator('tbody tr')
      .first()
      .getByRole('button', { name: /^复制订单信息/ })
      .click();
    await waitCopied(expected(1, fixture.payload));
    mode = 'payment-tasks';
    permitted = false;
    await page.goto('http://127.0.0.1:5173/payment-tasks');
    await page.getByText('W0000000001', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^复制订单链接/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /^复制订单信息/ }).count(), 0);
    assert.deepEqual(errors, []);
    logger.info('付款链接复制合成浏览器验收通过', {
      pages: 2,
      widths: [1440, 375],
      cases: [
        '真实二维码识读',
        '单条和混合批量',
        '订单号复制原链接',
        '缺码坏图非付款码回退',
        '转派拒绝不覆盖剪贴板',
        '剪贴板拒绝',
        'writeText回退',
        '无权限入口隐藏',
      ],
    });
  } catch (error) {
    logger.error('付款链接复制合成浏览器验收失败', { message: error.message });
    process.exitCode = 1;
  } finally {
    await context?.close();
    await browser?.close();
  }
}
main();
