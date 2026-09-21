/* global localStorage, window, navigator */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const logger = require('../src/utils/logger');
const { PAYMENT_METHODS } = require('../src/utils/paymentMethod');
const fixture = require('../frontend/test/fixtures/paymentQr.json');

/** 专用临时 Chrome 与合成 API 验证 15 种支付方式，不访问业务或支付地址。 */
async function main() {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => {
      localStorage.setItem('token', 'synthetic-payment-methods');
      window.copiedText = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write: async items => {
            window.copiedText = await (await items[0].getType('text/plain')).text();
          },
          writeText: text => {
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
    let denyLink = false;
    const tasks = PAYMENT_METHODS.map((paymentMethod, index) => ({
      id: index + 1,
      orderId: index + 101,
      orderNumber: `W${String(index + 1).padStart(10, '0')}`,
      products: [{ name: '合成测试手机', quantity: 1 }],
      paymentMethod,
      officialOrderStatus: 'payment_due',
      officialPaymentStatus: 'unpaid',
      processingStatus: 'pending',
      version: 0,
      payerVersion: 0,
      orderDate: '2026-09-21T01:27:25Z',
    }));
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        assert.equal(route.request().method(), 'GET');
        requests.push(url.pathname);
        let data;
        if (url.pathname === '/api/auth/me') {
          data = {
            id: 1,
            username: '合成验收',
            role: 'readOnly',
            permissions:
              mode === 'payment-tasks'
                ? ['payment_tasks.read_own', 'payment_tasks.link.read_own']
                : ['payment_dispatch.read'],
            availableHome: '/' + mode,
          };
        } else if (url.pathname === '/api/payment-dispatch/overview') {
          data = { settings: { enabled: false, mode: 'manual', version: 0 }, staff: [] };
        } else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(url.pathname)) {
          data = {
            items: tasks,
            recipientTagOptions: [],
            productOptions: [],
            pagination: { page: 1, limit: 20, total: tasks.length, totalPages: 1 },
          };
        } else if (url.pathname.endsWith('/payment-code')) {
          const task = tasks[Number(url.pathname.split('/').at(-2)) - 1];
          data =
            task.paymentMethod === '微信'
              ? { ...task, availability: 'available', imageDataUrl: fixture.valid }
              : { availability: 'unsupported', message: `${task.paymentMethod}暂无法获取付款码` };
        } else if (url.pathname.endsWith('/payment-link')) {
          if (denyLink) {
            await route.fulfill({
              status: 403,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: '合成权限已撤销' } }),
            });
            return;
          }
          data = { paymentUrl: `https://example.test/order/${url.pathname.split('/').at(-2)}` };
        } else throw new Error('未配置合成接口 ' + url.pathname);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    const expected = task =>
      `${task.orderId} || 合成测试手机 x 1 || ${task.paymentMethod} || 26/09/21 09:57 || ${task.paymentMethod === '微信' ? fixture.payload : `https://example.test/order/${task.id}`}`;
    for (mode of ['payment-tasks', 'payment-dispatch']) {
      for (const width of [1440, 375]) {
        denyLink = false;
        await page.setViewportSize({ width, height: 950 });
        await page.goto('http://127.0.0.1:5173/' + mode);
        for (const task of tasks) {
          const row = page
            .locator('tbody tr')
            .filter({
              has: page.getByRole('button', {
                name: `复制订单链接 ${task.orderNumber}`,
                exact: true,
              }),
            });
          await row.getByRole('button', { name: '查看付款码', exact: true }).waitFor();
          requests.length = 0;
          await row.getByRole('button', { name: /^复制订单信息/ }).click();
          await page.waitForFunction(value => window.copiedText === value, expected(task));
          assert.equal(
            requests.some(path => path.endsWith('/payment-code')),
            task.paymentMethod === '微信'
          );
          if (task.paymentMethod !== '微信') {
            await row.getByRole('button', { name: '查看付款码', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: '查看付款码' });
            await dialog
              .getByText(`${task.paymentMethod}暂无法获取付款码`, { exact: true })
              .waitFor();
            assert.equal(await dialog.locator('img').count(), 0);
            if (task.paymentMethod === '微信分付24期') {
              await page.getByTestId('center-toast').waitFor({ state: 'hidden' });
              await page.screenshot({ path: `/tmp/payment-methods-${mode}-${width}.png` });
            }
            await dialog.getByRole('button', { name: '关闭付款码' }).click();
          }
          await page
            .getByRole('checkbox', { name: `选择订单 ${task.orderNumber}`, exact: true })
            .check();
        }
        requests.length = 0;
        await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
        await page.waitForFunction(
          value => window.copiedText === value,
          tasks.map(expected).join('\n\n')
        );
        assert.equal(requests.filter(path => path.endsWith('/payment-code')).length, 1);
        const before = await page.evaluate(() => window.copiedText);
        denyLink = true;
        await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
        await page
          .getByText(/合成权限已撤销/)
          .first()
          .waitFor();
        assert.equal(await page.evaluate(() => window.copiedText), before);
      }
    }
    assert.deepEqual(errors, []);
    logger.info('支付方式合成浏览器验收通过', {
      pages: 2,
      widths: [1440, 375],
      methods: tasks.length,
    });
  } catch (error) {
    logger.error('支付方式合成浏览器验收失败', { error: error.message });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}
main();
