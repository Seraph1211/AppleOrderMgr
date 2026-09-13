/* global localStorage */
const assert = require('node:assert/strict');
const logger = require('../src/utils/logger');
const { makePng } = require('../test/fixtures/paymentCode');
/** 专用 Chrome 合成 API 验证付款码弹窗，不读取业务数据或打开支付地址。 */
async function main() {
  let browser;
  let context;
  try {
    const { chromium } = require('playwright-core');
    browser = await chromium.connectOverCDP(process.env.PAYMENT_BROWSER_WS, {
      headers: { Host: '127.0.0.1' },
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    let mode = 'payment-tasks';
    let permitted = true;
    let state = 'available';
    let status = 'payment_due';
    const requests = [];
    const errors = [];
    const task = id => ({
      id,
      orderId: 100 + id,
      orderNumber: `W${String(id).padStart(10, '0')}`,
      products: [{ name: '合成手机 白色 256G', model: 'TEST', quantity: 2 }],
      paymentMethod: id === 1 ? '微信' : '支付宝',
      officialOrderStatus: 'payment_due',
      officialPaymentStatus: 'unpaid',
      processingStatus: 'pending',
      version: 0,
      payerVersion: 0,
      orderDate: '2026-09-13T08:00:00Z',
      officialOrderAmount: '15998.00',
    });
    page.on('pageerror', e => errors.push(e.message));
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-code-token'));
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        requests.push(url.pathname);
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: '合成验收',
            role: mode === 'payment-dispatch' ? 'admin' : 'readOnly',
            permissions:
              mode === 'payment-dispatch'
                ? ['payment_dispatch.read']
                : ['payment_tasks.read_own', ...(permitted ? ['payment_tasks.link.read_own'] : [])],
            availableHome: '/' + mode,
          };
        else if (url.pathname === '/api/payment-dispatch/overview')
          data = { settings: { enabled: true, mode: 'manual', version: 0 }, staff: [] };
        else if (
          url.pathname === '/api/payment-tasks' ||
          url.pathname === '/api/payment-dispatch/tasks'
        )
          data = {
            items: [task(1), task(2)],
            pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
            recipientTagOptions: [],
            serverTime: new Date().toISOString(),
          };
        else if (url.pathname.endsWith('/payment-code')) {
          if (state === 'error') {
            await route.fulfill({
              status: 404,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: '付款任务不存在或已转派' } }),
            });
            return;
          }
          const id = Number(url.pathname.split('/').at(-2));
          data =
            id === 2
              ? { availability: 'unsupported', message: '支付宝暂无法获取付款码' }
              : {
                ...task(id),
                availability: state,
                message: state === 'missing' ? '暂未采集到付款码，请稍后重试' : null,
                amount: '15998.00',
                officialOrderStatus: status,
                imageDataUrl: state === 'available' ? makePng() : null,
              };
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
    for (mode of ['payment-tasks', 'payment-dispatch']) {
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 950 });
        await page.goto('http://127.0.0.1:5173/' + mode);
        const buttons = page.getByRole('button', { name: '查看付款码', exact: true });
        await buttons.first().waitFor();
        assert.equal(await buttons.count(), 2);
        state = 'available';
        status = 'payment_due';
        await buttons.first().click();
        let dialog = page.getByRole('dialog', { name: '查看付款码' });
        await dialog.getByRole('img').waitFor();
        assert.match(await dialog.innerText(), /101/);
        assert.match(await dialog.innerText(), /W0000000001/);
        assert.match(await dialog.innerText(), /15998/);
        assert.match(await dialog.innerText(), /合成手机/);
        assert.equal(
          await dialog.getByRole('img').evaluate(img => img.complete && img.naturalWidth > 0),
          true
        );
        const box = await dialog.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width);
        await page.screenshot({ path: `/tmp/payment-code-${mode}-${width}.png` });
        await page.keyboard.press('Escape');
        assert.equal(await dialog.count(), 0);
        await buttons.nth(1).click();
        dialog = page.getByRole('dialog', { name: '查看付款码' });
        await dialog.getByText('支付宝暂无法获取付款码', { exact: true }).waitFor();
        assert.equal(await dialog.getByRole('img').count(), 0);
        assert.equal(await dialog.getByRole('link').count(), 0);
        assert.doesNotMatch(await dialog.innerText(), /订单序号/);
        await dialog.getByRole('button', { name: '关闭付款码' }).click();
        for (status of ['cancelled', 'payment_expired', 'payment_received']) {
          await buttons.first().click();
          dialog = page.getByRole('dialog', { name: '查看付款码' });
          await dialog.getByRole('img').waitFor();
          await dialog.getByRole('alert').waitFor();
          assert.match(await dialog.getByRole('alert').innerText(), /请勿继续付款/);
          await page.keyboard.press('Escape');
        }
        state = 'missing';
        await buttons.first().click();
        await page.getByText('暂未采集到付款码，请稍后重试').waitFor();
        await page.keyboard.press('Escape');
        state = 'error';
        await buttons.first().click();
        await page.getByText('付款任务不存在或已转派').waitFor();
        await page.keyboard.press('Escape');
        state = 'available';
      }
    }
    mode = 'payment-tasks';
    permitted = false;
    await page.goto('http://127.0.0.1:5173/payment-tasks');
    await page.getByText('W0000000001', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '查看付款码', exact: true }).count(), 0);
    assert.equal(
      requests.some(url => url.includes('payment-link') || url.includes('/refresh')),
      false
    );
    assert.deepEqual(errors, []);
    logger.info('付款码两页合成浏览器验收通过', {
      widths: [375, 1440],
      scenarios: [
        '微信信息与图片',
        '支付宝仅提示',
        '终态可查看',
        '缺码',
        '转派错误',
        '权限隐藏',
        'Escape关闭',
        '无官网或付款请求',
      ],
    });
  } catch (error) {
    logger.error('付款码浏览器验收失败', { message: error.message });
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}
main();
