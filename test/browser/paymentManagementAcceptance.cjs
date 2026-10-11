/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const origin = process.env.PAYMENT_ACCEPTANCE_ORIGIN || 'http://127.0.0.1:5181';

/** 在当前前端与完全合成 API 上独立验证付款两页。 */
async function main() {
  const output = '/tmp/apple-payment-management-20261011';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const dispatch of [true, false]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      const calls = [];
      let failing = false;
      let noteFailure = false;
      let codeFailure = true;
      const tasks = [1, 2, 3].map(id => ({
        id,
        orderId: 9100 + id,
        orderNumber: `W991122000${id}`,
        products: [{ name: 'iPhone 18 Pro Max 512GB 银色', quantity: 2 }],
        paymentMethod: id === 2 ? 'ALIPAY' : 'WECHAT',
        processingStatus: 'pending',
        processingNotes: '原有备注',
        version: 0,
        recipientTag: '独立验收TAG',
        assignee: { id: 2, username: 'operator', nickname: '测试处理人' },
        orderDate: '2026-10-10T01:02:00Z',
        deadlineAt: '2026-10-10T01:32:00Z',
        officialRawStatus: id === 3 ? 'MYSTERY_STATE' : 'PROCESSING | PAYMENT_PENDING',
        officialStatusObservedAt: '2026-10-11T02:03:00Z',
      }));
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-payment-acceptance');
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: value => {
              window.__copy = value;
              return Promise.resolve();
            },
          },
        });
      });
      await context.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === origin) await route.continue();
            else await route.abort();
            return;
          }
          calls.push({ path: url.pathname, method: route.request().method() });
          let data;
          if (url.pathname === '/api/auth/me')
            data = {
              id: 2,
              username: 'operator',
              role: 'operator',
              availableHome: dispatch ? '/payment-dispatch' : '/payment-tasks',
              permissions: [
                'payment_dispatch.read',
                'payment_dispatch.correct',
                'payment_dispatch.assign',
                'payment_tasks.read_own',
                'payment_tasks.handle_own',
                'payment_tasks.link.read_own',
              ],
            };
          else if (url.pathname.endsWith('/overview'))
            data = { settings: { enabled: true, mode: 'auto', version: 0 }, staff: [] };
          else if (url.pathname.endsWith('/pending-overview')) data = { count: 3 };
          else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(url.pathname))
            data = {
              items: tasks,
              pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
              productNameOptions: [],
              recipientTagOptions: [],
              serverTime: new Date().toISOString(),
            };
          else if (url.pathname.endsWith('/alipay-payment-link'))
            data = { paymentUrl: 'https://example.test/synthetic-alipay' };
          else if (url.pathname.endsWith('/payment-link'))
            data = { paymentUrl: 'https://example.test/synthetic-order' };
          else if (url.pathname.endsWith('/payment-code')) {
            if (codeFailure) {
              await route.fulfill({
                status: 404,
                json: { success: false, error: { message: '合成付款码缺失' } },
              });
              return;
            }
            data = { availability: 'missing' };
          } else if (route.request().method() === 'PUT') {
            if (noteFailure) {
              await route.fulfill({
                status: 409,
                json: { success: false, error: { message: '备注版本冲突' } },
              });
              return;
            }
            const payload = route.request().postDataJSON();
            tasks[0].processingNotes = payload.processingNotes;
            tasks[0].version += 1;
            data = tasks[0];
          } else if (url.pathname.endsWith('/refresh'))
            data = { jobId: 'synthetic-job', state: 'queued', created: true };
          else if (url.pathname.endsWith('/refresh/synthetic-job')) {
            if (!failing) tasks[0].officialRawStatus = 'READY_FOR_PICKUP';
            data = { jobId: 'synthetic-job', state: failing ? 'failed' : 'succeeded' };
          } else throw new Error(`未预期接口 ${url.pathname}`);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/${dispatch ? 'payment-dispatch' : 'payment-tasks'}`);
      const table = page.locator('[data-payment-orders-table]');
      await table.getByText('订单 ID：9101', { exact: true }).waitFor();
      assert.deepEqual(
        (await table.locator('thead th').allTextContents())
          .map(value => value.trim())
          .filter(Boolean),
        [
          '订单',
          '商品信息',
          '官网订单状态',
          '取机人TAG',
          '下单时间',
          '付款倒计时',
          '处理人',
          '处理备注',
          '操作',
        ]
      );
      const first = table.locator('tbody tr').first();
      const status = first.locator('[data-label="官网订单状态"]');
      assert.equal(await status.locator('.badge').count(), 2);
      assert.ok((await status.innerText()).includes('处理中'));
      assert.ok((await status.innerText()).includes('待付款'));
      assert.ok((await status.innerText()).includes('10/11 10:03'));
      assert.ok((await table.locator('tbody tr').nth(2).innerText()).includes('MYSTERY_STATE'));
      assert.equal(await first.locator('[data-label="操作"] button').count(), 4);
      await first.getByRole('button', { name: '查看付款码', exact: true }).click();
      await page.getByText('合成付款码缺失', { exact: true }).waitFor();
      await page.getByRole('button', { name: '关闭付款码', exact: true }).click();
      codeFailure = false;
      await table
        .locator('tbody tr')
        .nth(1)
        .getByRole('button', { name: /复制支付宝付款链接/ })
        .click();
      await page.getByText('支付宝付款链接已复制', { exact: true }).first().waitFor();
      assert.equal(
        await page.evaluate(() => window.__copy),
        'https://example.test/synthetic-alipay'
      );
      await first.getByRole('button', { name: /复制订单信息/ }).click();
      await page
        .getByText(dispatch ? '已复制 1 条订单信息' : '订单信息已复制', { exact: true })
        .first()
        .waitFor();
      assert.ok((await page.evaluate(() => window.__copy)).startsWith('9101 ||'));
      noteFailure = true;
      await first.getByRole('button', { name: /编辑备注/ }).click();
      await page.getByLabel('处理备注', { exact: true }).fill('修改草稿');
      await page.getByRole('button', { name: '保存备注', exact: true }).click();
      await page.getByRole('dialog').getByText('备注版本冲突', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('处理备注', { exact: true }).inputValue(), '修改草稿');
      noteFailure = false;
      await page.getByRole('button', { name: '保存备注', exact: true }).click();
      await first.getByText('修改草稿', { exact: true }).waitFor();
      failing = true;
      await first.getByRole('button', { name: /更新订单状态/ }).click();
      await first.getByText('官网查询失败，保留上次官网状态，可重试', { exact: true }).waitFor();
      assert.ok((await status.innerText()).includes('待付款'));
      failing = false;
      await first.getByRole('button', { name: /更新订单状态/ }).click();
      await first.getByText('可取货', { exact: true }).waitFor();
      assert.equal(
        calls.filter(call => call.path.endsWith('/refresh') && call.method === 'POST').length,
        2
      );
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 700 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await table.evaluate(element => {
          element.scrollLeft = 0;
        });
        await page.screenshot({
          path: `${output}/${dispatch ? '调度' : '本人任务'}-默认-${width}.png`,
        });
        await table.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${dispatch ? '调度' : '本人任务'}-表格默认-${width}.png` });
        await table.evaluate(element => {
          element.scrollLeft = element.scrollWidth;
        });
        await first.getByRole('button', { name: /编辑备注/ }).click();
        await page.getByRole('dialog', { name: '修改备注' }).waitFor();
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await page.screenshot({
          path: `${output}/${dispatch ? '调度' : '本人任务'}-${width}.png`,
          fullPage: false,
        });
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    process.stdout.write(
      'PASS: 两页9列、中文多状态与时间、未知值、四项操作、失败保留状态和备注草稿、成功刷新、375/768/1440px\n'
    );
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
