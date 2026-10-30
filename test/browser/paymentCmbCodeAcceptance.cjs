/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const logger = require('../../src/utils/logger');
const fixture = require('../../frontend/test/fixtures/paymentQr.json');
const origin = process.env.PAYMENT_CMB_BROWSER_URL || 'http://127.0.0.1:5173';

/** 合成 API 验证两页支付方式、招行付款码及失败状态，不访问外部支付地址。 */
async function main() {
  let browser;
  try {
    fs.mkdirSync('/tmp/apple-payment-cmb-20261022', { recursive: true });
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    for (const dispatch of [false, true]) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-cmb-code'));
      const page = await context.newPage();
      const errors = [];
      let availability = 'available';
      let denied = false;
      let canRead = true;
      const mode = dispatch ? 'payment-dispatch' : 'payment-tasks';
      const methods = ['微信', '支付宝', '招行24期', '招行12期', null];
      const tasks = methods.map((paymentMethod, index) => ({
        id: index + 1,
        orderId: index + 101,
        orderNumber: `W990000000${index + 1}`,
        products: [{ name: '合成测试手机', quantity: 1 }],
        paymentMethod,
        processingStatus: 'completed',
        emailOrderStatus: 'cancelled',
        orderDate: '2026-10-21T06:42:41Z',
        officialRawStatus: 'CANCELLED',
      }));
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (url.origin !== origin) {
            await route.abort();
            return;
          }
          if (!url.pathname.startsWith('/api/')) {
            await route.continue();
            return;
          }
          assert.equal(route.request().method(), 'GET');
          let data;
          if (url.pathname === '/api/auth/me') {
            data = {
              id: 2,
              username: '合成付款验收',
              role: 'operator',
              availableHome: '/' + mode,
              permissions: [
                dispatch ? 'payment_dispatch.read' : 'payment_tasks.read_own',
                ...(canRead && !dispatch ? ['payment_tasks.link.read_own'] : []),
              ],
            };
          } else if (url.pathname.endsWith('/overview')) {
            data = { settings: { enabled: false, mode: 'manual', version: 0 }, staff: [] };
          } else if (url.pathname.endsWith('/pending-overview')) data = { count: 0 };
          else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(url.pathname)) {
            data = {
              items: tasks,
              pagination: { page: 1, limit: 20, total: tasks.length, totalPages: 1 },
              productOptions: [],
              recipientTagOptions: [],
              serverTime: new Date().toISOString(),
            };
          } else if (url.pathname.endsWith('/payment-code')) {
            assert.equal(
              url.pathname,
              dispatch
                ? '/api/payment-dispatch/tasks/3/payment-code'
                : '/api/payment-tasks/3/payment-code'
            );
            if (denied) {
              await route.fulfill({
                status: 404,
                json: { success: false, error: { message: '付款任务不存在或已转派' } },
              });
              return;
            }
            data = {
              ...tasks[2],
              availability,
              imageDataUrl: availability === 'available' ? fixture.valid : null,
              message: availability === 'missing' ? '暂未采集到付款码，请稍后重试' : null,
            };
          } else throw new Error('未配置接口 ' + url.pathname);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      for (const width of [1440, 768, 375]) {
        await page.setViewportSize({ width, height: 900 });
        availability = 'available';
        denied = false;
        await page.goto(origin + '/' + mode);
        await page.locator('tbody tr').filter({ hasText: tasks[2].orderNumber }).waitFor();
        assert.equal(await page.locator('th[data-column="支付方式"]').count(), 1);
        for (const [index, method] of methods.entries()) {
          const row = page.locator('tbody tr').filter({ hasText: tasks[index].orderNumber });
          assert.equal(await row.locator('td[data-label="支付方式"]').innerText(), method || '—');
        }
        const row = page.locator('tbody tr').filter({ hasText: tasks[2].orderNumber });
        const trigger = row.getByRole('button', { name: '查看付款码', exact: true });
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: '查看付款码' });
        const img = dialog.getByRole('img', { name: '订单 W9900000003 的招行24期付款码' });
        await img.waitFor();
        await img.evaluate(image => image.decode());
        assert.equal(await img.getAttribute('src'), fixture.valid);
        await dialog.getByText('请勿继续付款。', { exact: false }).waitFor();
        assert.equal(
          await dialog.evaluate(element => element.scrollWidth <= element.clientWidth),
          true
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true
        );
        await page.screenshot({ path: `/tmp/apple-payment-cmb-20261022/${mode}-${width}.png` });
        await dialog.getByRole('button', { name: '关闭付款码' }).click();
        availability = 'missing';
        await trigger.click();
        await dialog.getByText('暂未采集到付款码，请稍后重试', { exact: true }).waitFor();
        assert.equal(await dialog.locator('img').count(), 0);
        await page.keyboard.press('Escape');
        denied = true;
        await trigger.click();
        await dialog.getByText('付款任务不存在或已转派', { exact: true }).waitFor();
        assert.equal(await dialog.locator('img').count(), 0);
        await dialog.getByRole('button', { name: '关闭付款码' }).click();
      }
      if (!dispatch) {
        canRead = false;
        await page.reload();
        await page.locator('tbody tr').filter({ hasText: tasks[2].orderNumber }).waitFor();
        assert.equal(
          await page.getByRole('button', { name: '查看付款码', exact: true }).count(),
          0
        );
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    logger.info('招行24期付款码与支付方式浏览器验收通过', { pages: 2, widths: [1440, 768, 375] });
  } catch (error) {
    logger.error('招行24期付款码浏览器验收失败', { error: error.message });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}
main();
