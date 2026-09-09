/* global localStorage, document, window */
const assert = require('node:assert/strict');
const logger = require('../src/utils/logger');

/** 使用专用浏览器和合成 API 验证付款分页及刷新交互，不访问业务 API。 */
async function main() {
  let browser;
  let context;
  try {
    if (!process.env.PAYMENT_BROWSER_WS) throw new Error('需要专用临时浏览器地址');
    const { chromium } = require('playwright-core');
    browser = await chromium.connectOverCDP(process.env.PAYMENT_BROWSER_WS, {
      headers: { Host: '127.0.0.1' },
      timeout: 15000,
    });
    context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
      timezoneId: process.env.PAYMENT_BROWSER_TIMEZONE || 'Asia/Shanghai',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    const submissions = [];
    const queries = [];
    const jobs = {};
    let total = 45;
    let mode = 'payment-tasks';
    let permitted = true;
    let hold = false;
    let rejectSecond = false;
    const updated = new Set();
    const task = id => ({
      id,
      orderId: id,
      orderNumber: `W${String(id).padStart(10, '0')}`,
      products: [{ name: '合成手机', model: 'MODEL', quantity: 1 }],
      officialOrderStatus: 'payment_due',
      officialPaymentStatus: 'unpaid',
      paymentMethod: '支付宝',
      processingStatus: 'pending',
      processingNotes: '',
      payerName: '',
      version: 0,
      payerVersion: 0,
      orderDate: id === 2 ? null : id === 3 ? '2026-09-09' : '2026-09-09T01:02:03Z',
      officialOrderCreatedAt: id === 2 || id === 4 ? null : '2026-09-09T01:00:00Z',
      deadlineAt: null,
      remainingSeconds: null,
      updatedAt: updated.has(id) ? '2026-09-09T03:00:00Z' : '2026-09-09T02:00:00Z',
      lastCrawledAt: updated.has(id) ? '2026-09-09T03:00:00Z' : '2026-09-09T02:00:00Z',
    });
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-token'));
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: 'synthetic',
            role: mode === 'payment-dispatch' ? 'admin' : 'readOnly',
            permissions:
              mode === 'payment-dispatch'
                ? ['payment_dispatch.read', 'payment_dispatch.assign', 'orders.refresh']
                : [
                  'payment_tasks.read_own',
                  'payment_tasks.handle_own',
                  ...(permitted ? ['payment_tasks.refresh_own'] : []),
                ],
            availableHome: `/${mode}`,
          };
        else if (url.pathname === '/api/payment-dispatch/overview')
          data = { settings: { enabled: true, mode: 'manual', version: 0 }, staff: [] };
        else if (
          url.pathname === '/api/payment-tasks' ||
          url.pathname === '/api/payment-dispatch/tasks'
        ) {
          const currentPage = Number(url.searchParams.get('page'));
          const limit = Number(url.searchParams.get('limit'));
          const keyword = url.searchParams.get('orderNumber');
          queries.push({ currentPage, limit, keyword });
          const count = keyword === 'none' ? 0 : keyword ? 1 : total;
          data = {
            items: Array.from(
              { length: Math.max(0, Math.min(limit, count - (currentPage - 1) * limit)) },
              (_, index) => task((currentPage - 1) * limit + index + 1)
            ),
            pagination: {
              page: currentPage,
              limit,
              total: count,
              totalPages: Math.ceil(count / limit),
            },
            serverTime: new Date().toISOString(),
          };
        } else if (
          /^\/api\/payment-tasks\/\d+$/.test(url.pathname) &&
          route.request().method() === 'PUT'
        ) {
          await new Promise(resolve => setTimeout(resolve, 800));
          data = task(Number(url.pathname.split('/').at(-1)));
        } else if (
          /\/(?:payment-tasks|payment-dispatch\/tasks)\/\d+\/refresh$/.test(url.pathname)
        ) {
          const id = Number(url.pathname.split('/').at(-2));
          submissions.push(id);
          if (rejectSecond && id === 2) {
            await route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: '合成任务已转派' } }),
            });
            return;
          }
          const jobId = submissions.length;
          jobs[jobId] = { id, polls: 0 };
          data = { jobId, status: 'pending', created: true };
        } else if (
          /\/payment-tasks\/\d+\/refresh\/\d+$/.test(url.pathname) ||
          url.pathname.startsWith('/api/order-refresh/jobs/')
        ) {
          const job = jobs[Number(url.pathname.split('/').at(-1))];
          job.polls += 1;
          const status = hold
            ? 'pending'
            : job.polls === 1
              ? 'running'
              : job.id === 3
                ? 'failed'
                : 'succeeded';
          if (status === 'succeeded') updated.add(job.id);
          data = { status, lastErrorMessage: status === 'failed' ? '合成官网超时，可重试' : null };
        } else throw new Error(`未配置路径 ${url.pathname}`);
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
      updated.clear();
      await page.goto(`http://127.0.0.1:5173/${mode}`, { waitUntil: 'networkidle' });
      const table = page.locator('table').last();
      const rows = table.locator('tbody tr');
      await page.getByRole('columnheader', { name: '下单时间', exact: true }).waitFor();
      assert.equal(await rows.count(), 20);
      assert.match(await rows.first().innerText(), /2026\/09\/09 09:02:03/);
      assert.match(await rows.nth(1).innerText(), /待核实/);
      assert.equal(await rows.nth(2).getByText('2026/09/09', { exact: true }).count(), 1);
      assert.match(await rows.nth(3).innerText(), /2026\/09\/09 09:02:03/);
      assert.equal(
        await page.getByRole('button', { name: '批量刷新', exact: true }).isDisabled(),
        true
      );
      await page.getByRole('checkbox', { name: '选择当前页全部任务' }).check();
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await rows.first().getByText('W0000000021', { exact: true }).waitFor();
      assert.equal(
        await page.getByRole('checkbox', { name: '选择当前页全部任务' }).isChecked(),
        false
      );
      await page.getByRole('button', { name: '末页', exact: true }).click();
      await rows.first().getByText('W0000000041', { exact: true }).waitFor();
      assert.equal(await rows.count(), 5);
      assert.equal(
        await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(),
        true
      );
      await page.getByPlaceholder('3', { exact: true }).fill('2');
      await page.getByPlaceholder('3', { exact: true }).press('Enter');
      await rows.first().getByText('W0000000021', { exact: true }).waitFor();
      const pageSize = page.locator('select').filter({ has: page.locator('option[value="100"]') });
      await pageSize.selectOption('100');
      await rows.last().getByText('W0000000045', { exact: true }).waitFor();
      assert.equal(await rows.count(), 45);
      await pageSize.selectOption('10');
      await rows.first().getByText('W0000000001', { exact: true }).waitFor();
      assert.equal(await rows.count(), 10);
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await rows.first().getByText('W0000000011', { exact: true }).waitFor();
      const orderFilter = page.getByPlaceholder('订单号', { exact: true });
      await orderFilter.fill('W0000000001');
      if (mode === 'payment-dispatch')
        await page.getByRole('button', { name: '筛选', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('table:last-of-type tbody tr').length > 0
      );
      await rows.first().getByText('W0000000001', { exact: true }).waitFor();
      assert.equal(queries.at(-1).currentPage, 1);
      await orderFilter.fill('none');
      if (mode === 'payment-dispatch')
        await page.getByRole('button', { name: '筛选', exact: true }).click();
      await page
        .getByText(mode === 'payment-tasks' ? '暂无匹配的付款任务' : '没有符合条件的付款任务', {
          exact: true,
        })
        .waitFor();
      await orderFilter.fill('');
      if (mode === 'payment-dispatch')
        await page.getByRole('button', { name: '筛选', exact: true }).click();
      await rows.first().getByText('W0000000001', { exact: true }).waitFor();
      const before = submissions.length;
      rejectSecond = true;
      for (const id of [1, 2, 3])
        await page
          .getByRole('checkbox', { name: `选择订单 W${String(id).padStart(10, '0')}`, exact: true })
          .check();
      if (mode === 'payment-tasks') await rows.first().locator('textarea').fill('未保存的处理备注');
      await page.getByRole('button', { name: '批量刷新', exact: true }).click();
      await rows.first().getByText('排队中，等待后台处理', { exact: true }).waitFor();
      await rows.nth(1).getByText('合成任务已转派', { exact: true }).waitFor();
      await rows.first().getByText('官网状态已更新', { exact: true }).waitFor();
      await rows.nth(2).getByText('合成官网超时，可重试', { exact: true }).waitFor();
      assert.deepEqual(submissions.slice(before).sort(), [1, 2, 3]);
      const updatedHour = await page.evaluate(() => new Date('2026-09-09T03:00:00Z').getHours());
      await rows
        .first()
        .getByText(`2026/09/09 ${String(updatedHour).padStart(2, '0')}:00:00`, { exact: true })
        .waitFor();
      if (mode === 'payment-tasks')
        assert.equal(await rows.first().locator('textarea').inputValue(), '未保存的处理备注');
      assert.equal(await page.getByText(/订单 .* 已进入刷新队列/).count(), 0);
      rejectSecond = false;
      const refresh = rows.nth(1).getByRole('button', { name: /刷新官网状态/ });
      await refresh.click();
      assert.equal(await refresh.isDisabled(), true);
      await rows.nth(1).getByText('官网状态已更新', { exact: true }).waitFor();
      await page.screenshot({
        path: `${process.env.PAYMENT_BROWSER_OUTPUT || '/tmp'}/${mode}-desktop.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 375, height: 812 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true
      );
      await page.screenshot({
        path: `${process.env.PAYMENT_BROWSER_OUTPUT || '/tmp'}/${mode}-mobile.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      // 活跃刷新跨页完成后，只重新读取当前页；总数缩减时自动退回有效末页。
      hold = true;
      await rows
        .first()
        .getByRole('button', { name: /刷新官网状态/ })
        .click();
      await page.getByRole('button', { name: '末页', exact: true }).click();
      await rows.first().getByText('W0000000041', { exact: true }).waitFor();
      total = 12;
      hold = false;
      await rows.first().getByText('W0000000011', { exact: true }).waitFor();
      assert.equal(queries.at(-1).currentPage, 2);
      assert.equal(await rows.count(), 2);
      total = 45;
      if (mode === 'payment-tasks') {
        await page.reload({ waitUntil: 'networkidle' });
        await rows.first().locator('textarea').fill('保存期间翻页');
        let saveReturned = false;
        const saved = page
          .waitForResponse(response => response.request().method() === 'PUT')
          .then(() => {
            saveReturned = true;
          });
        const reloaded = page.waitForResponse(
          response => saveReturned && new URL(response.url()).pathname === '/api/payment-tasks'
        );
        await rows.first().getByRole('button', { name: '保存本行修改' }).click();
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        await rows.first().getByText('W0000000021', { exact: true }).waitFor();
        await Promise.all([saved, reloaded]);
        assert.equal(queries.at(-1).currentPage, 2);
        await rows.first().getByText('W0000000021', { exact: true }).waitFor();
      }
    }
    mode = 'payment-tasks';
    permitted = false;
    await page.goto('http://127.0.0.1:5173/payment-tasks', { waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: '批量刷新', exact: true }).count(), 0);
    assert.equal(await page.getByRole('checkbox').count(), 0);
    assert.deepEqual(errors, []);
    logger.info('付款页面浏览器验收通过', {
      pages: 2,
      checks: [
        '分页及末页',
        '筛选及空结果',
        '下单时间',
        '勾选清空',
        '批量部分失败',
        '逐行进度及重试',
        '草稿保留',
        '当前页回填',
        '越界退页',
        '窄屏',
        '权限展示',
      ],
      submissions: submissions.length,
    });
  } catch (error) {
    logger.error('付款页面浏览器验收失败', { error: error.message, stack: error.stack });
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

main().catch(error => {
  logger.error('浏览器脚本退出失败', { error: error.message });
  process.exitCode = 1;
});
