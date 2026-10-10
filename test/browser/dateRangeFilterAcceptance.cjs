const { chooseSelect } = require('./responsiveSelectSupport.cjs');
/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成订单使用既有 API 字段 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

/** 合成 API 验证日期选择、组合查询与响应式交互，不访问真实业务数据。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const baseUrl = process.env.DATE_FILTER_BASE_URL || 'http://127.0.0.1:5173';
  const output = process.env.DATE_FILTER_OUTPUT || '/tmp/order-date-filter-ui';
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const width of [375, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const errors = [];
      const requests = [];
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-date-ui'));
      await context.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === baseUrl) await route.continue();
            else await route.abort();
            return;
          }
          let data;
          if (url.pathname === '/api/auth/me')
            data = {
              id: 1,
              role: 'operator',
              username: '日期界面验收',
              permissions: ['orders.read', 'orders.export'],
              availableHome: '/orders',
            };
          else if (url.pathname === '/api/orders/filter-options')
            data = { productOptions: [], recipientTags: [], stores: [] };
          else if (url.pathname === '/api/orders') {
            requests.push(Object.fromEntries(url.searchParams));
            data = {
              orders: [
                {
                  id: 41,
                  order_number: 'W1234567890',
                  products: [],
                  official_order_status: 'READY_FOR_PICKUP',
                },
              ],
              total: 1,
            };
          } else {
            errors.push(`意外 API: ${url.pathname}`);
            await route.abort();
            return;
          }
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${baseUrl}/orders`);
      if (width < 768) await page.getByRole('button', { name: /筛选条件.*展开/ }).click();
      const orderButton = page.getByRole('button', { name: /^下单日期：/ });
      const pickupButton = page.getByRole('button', { name: /^实际取货日期：/ });
      const panel = page.getByRole('dialog');
      const apply = () => panel.getByRole('button', { name: '应用', exact: true }).click();
      const checkQuery = async expected => {
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (Object.entries(expected).every(([key, value]) => requests.at(-1)?.[key] === value))
            break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert(Object.entries(expected).every(([key, value]) => requests.at(-1)[key] === value));
      };
      const scheduledButton = page.getByRole('button', { name: /^取货日期：/ });
      await page.getByRole('button', { name: '日期筛选字段说明' }).hover();
      assert((await page.getByRole('tooltip').innerText()).includes('邮件中的预约取货日期'));
      await scheduledButton.click();
      await page.getByLabel('预约取货开始日期', { exact: true }).fill('2026-10-01');
      await page.getByLabel('预约取货结束日期', { exact: true }).fill('2026-10-05');
      await apply();
      await checkQuery({ pickupDateFrom: '2026-10-01', pickupDateTo: '2026-10-05' });
      if (width === 1440) {
        const boxes = await Promise.all(
          [orderButton, pickupButton, scheduledButton].map(button => button.boundingBox())
        );
        assert(boxes.every(box => Math.abs(box.y - boxes[0].y) < 1));
      }
      await orderButton.click();
      assert(await panel.isVisible());
      await page.getByLabel('下单开始日期', { exact: true }).fill('2026-09-29');
      await panel.getByRole('button', { name: '2026-09-29', exact: true }).click();
      await panel.getByRole('button', { name: '下个月' }).click();
      await panel.getByRole('button', { name: '2026-10-03', exact: true }).click();
      assert.equal(
        await page.getByLabel('下单结束日期', { exact: true }).inputValue(),
        '2026-10-03'
      );
      await apply();
      await checkQuery({ dateFrom: '2026-09-29', dateTo: '2026-10-03' });
      await pickupButton.click();
      await chooseSelect(page.getByLabel('实际取货日期条件'), 'on');
      await page.getByLabel('实际取货开始日期', { exact: true }).fill('2026-10-02');
      await apply();
      await checkQuery({
        dateFrom: '2026-09-29',
        dateTo: '2026-10-03',
        pickupDateFrom: '2026-10-01',
        pickupDateTo: '2026-10-05',
        actualPickupDateFrom: '2026-10-02',
        actualPickupDateTo: '2026-10-02',
      });
      await orderButton.click();
      const oldCount = requests.length;
      await page.getByLabel('下单开始日期', { exact: true }).fill('2026-10-08');
      assert(await panel.getByRole('alert').isVisible());
      assert(await panel.getByRole('button', { name: '应用', exact: true }).isDisabled());
      await page.keyboard.press('Escape');
      assert.equal(requests.length, oldCount);
      assert(await orderButton.evaluate(element => element === document.activeElement));
      await orderButton.click();
      assert.equal(
        await page.getByLabel('下单开始日期', { exact: true }).inputValue(),
        '2026-09-29'
      );
      // 日历方向键、取消和焦点恢复。
      const day = panel.getByRole('button', { name: '2026-09-29', exact: true });
      await day.focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.activeElement.dataset.date === '2026-09-30');
      await panel.getByRole('button', { name: '取消', exact: true }).click();
      // 所有比较条件均提交正确的包含边界。
      for (const [mode, from, to] of [
        ['before', '', '2026-02-28'],
        ['after', '2026-03-02', ''],
        ['onOrBefore', '', '2026-03-01'],
        ['onOrAfter', '2026-03-01', ''],
      ]) {
        await orderButton.click();
        await chooseSelect(page.getByLabel('下单日期条件'), mode);
        await page.getByLabel('下单开始日期', { exact: true }).fill('2026-03-01');
        await apply();
        await checkQuery({ dateFrom: from, dateTo: to, actualPickupDateFrom: '2026-10-02' });
      }
      // 清空单组不会清空另一组。
      await pickupButton.click();
      await panel.getByRole('button', { name: '清空', exact: true }).click();
      await checkQuery({
        dateFrom: '2026-03-01',
        actualPickupDateFrom: '',
        actualPickupDateTo: '',
      });
      // 单边范围、浮层边界、短屏滚动及范围截图。
      await orderButton.click();
      await chooseSelect(page.getByLabel('下单日期条件'), 'between');
      await page.getByLabel('下单开始日期', { exact: true }).fill('2026-10-01');
      await page.getByLabel('下单结束日期', { exact: true }).fill('');
      await apply();
      await checkQuery({ dateFrom: '2026-10-01', dateTo: '' });
      await orderButton.click();
      await panel.getByRole('button', { name: '2026-10-01', exact: true }).click();
      await panel.getByRole('button', { name: '2026-10-08', exact: true }).click();
      assert(
        (await panel
          .getByRole('button', { name: '2026-10-04', exact: true })
          .getAttribute('aria-pressed')) === 'true'
      );
      const box = await panel.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${output}/日期筛选-${width}.png` });
      await page.setViewportSize({ width, height: 568 });
      await panel.getByRole('button', { name: '应用', exact: true }).scrollIntoViewIfNeeded();
      await apply();
      await orderButton.click();
      await page.mouse.click(width - 2, 200);
      await panel.waitFor({ state: 'hidden' });
      await page.getByRole('checkbox', { name: '选择订单 W1234567890' }).check();
      await page.getByRole('button', { name: '导出选中订单', exact: true }).click();
      const exportPanel = page.getByRole('dialog');
      assert(
        await exportPanel.getByRole('checkbox', { name: '官网订单状态', exact: true }).isChecked()
      );
      for (const label of ['取货门店', '取货日期', '取货安排']) {
        assert(await exportPanel.getByRole('checkbox', { name: label, exact: true }).isVisible());
      }
      assert(!(await exportPanel.innerText()).includes('邮件取货'));
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `${output}/导出字段-${width}.png` });
      await exportPanel.getByRole('button', { name: '取消', exact: true }).click();
      assert.deepEqual(errors, []);
      await context.close();
      process.stdout.write(
        `${width}px：日期范围、比较条件、组合参数、取消、清空、键盘、窄屏通过\n`
      );
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
