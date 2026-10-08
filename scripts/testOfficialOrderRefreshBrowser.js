/* eslint-env node, browser */
/* eslint-disable no-magic-numbers, camelcase -- 合成 HTTP 与真实浏览器尺寸。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const OUTPUT =
  process.env.OFFICIAL_BROWSER_OUTPUT || 'test-artifacts/official-account-refresh-20261005';

/** 验证单选、多选、全选、列配置恢复、任务恢复及 PC/H5，所有写入均为合成 API。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    fs.mkdirSync(OUTPUT, { recursive: true });
    for (const width of [1440, 375]) {
      const context = await browser.newContext({
        viewport: { width, height: width < 768 ? 560 : 740 },
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      const page = await context.newPage();
      const writes = [];
      const errors = [];
      let batch = null;
      let sequence = 0;
      let role = 'admin';
      let officialReads = 0;
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-official-token');
        if (!localStorage.getItem('columnConfig:orders'))
          localStorage.setItem(
            'columnConfig:orders',
            JSON.stringify({
              columns: [
                { key: 'orderNumber', visible: true, order: 0 },
                { key: 'products', visible: true, order: 1 },
                { key: 'officialOrderStatus', visible: false, order: 8 },
              ],
            })
          );
      });
      await page.route('**/api/**', async route => {
        try {
          const request = route.request();
          const url = new URL(request.url());
          const method = request.method();
          if (url.pathname.includes('/official-refresh/') && method === 'GET') officialReads += 1;
          if (!url.pathname.startsWith('/api/')) {
            await route.continue();
            return;
          }
          let data;
          if (method !== 'GET') writes.push({ path: url.pathname, body: request.postDataJSON() });
          if (url.pathname === '/api/auth/me')
            data = {
              id: 1,
              username: '合成验收',
              role,
              permissions: ['orders.read', 'orders.edit', 'orders.export'],
              availableHome: '/orders',
            };
          else if (url.pathname === '/api/orders/filter-options')
            data = { productOptions: [], stores: [], recipientTags: ['测试 TAG'] };
          else if (url.pathname === '/api/orders')
            data = {
              total: 42,
              orders: [101, 102].map((id, i) => ({
                id,
                order_number: `W123456789${i}`,
                official_order_status: i ? null : 'PICKED_UP',
                official_status_observed_at: i ? null : '2026-10-03T01:00:00Z',
                email_order_status: 'confirmed',
                display_order_status: 'confirmed',
                products: [{ name: '合成手机 512GB 蓝色', quantity: 1 }],
                recipient_name: '合成取机人',
                order_date: '2026-10-03T00:00:00Z',
              })),
            };
          else if (url.pathname === '/api/orders/official-refresh/batches') {
            if (method === 'GET')
              data = batch
                ? [{ id: batch.id, total: batch.total, createdAt: batch.createdAt }]
                : [];
            else {
              const input = request.postDataJSON();
              const ids = input.selection === 'filtered' ? [101, 102] : input.orderIds;
              sequence += 1;
              batch = {
                id: `b-${sequence}`,
                total: input.selection === 'filtered' ? 42 : ids.length,
                selectedCount: input.selection === 'filtered' ? 42 : ids.length,
                accountCount: input.selection === 'filtered' ? 4 : 1,
                createdAt: new Date().toISOString(),
                counts: { queued: ids.length, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
                page: 1,
                limit: 20,
                jobs: ids.map(id => ({
                  id: `j-${id}`,
                  orderId: id,
                  orderNumber: `W123456789${id - 101}`,
                  state: 'queued',
                })),
              };
              data = {
                batchId: batch.id,
                queued: batch.total,
                skipped: 0,
                total: batch.total,
                selectedCount: batch.selectedCount,
                accountCount: batch.accountCount,
                queuedAccountCount: batch.accountCount,
              };
            }
          } else if (url.pathname.endsWith('/cancel')) {
            batch.counts.cancelled = batch.counts.queued;
            batch.counts.queued = 0;
            batch.jobs.forEach(job => {
              job.state = 'cancelled';
            });
            data = { cancelled: batch.counts.cancelled };
          } else if (url.pathname.startsWith('/api/orders/official-refresh/batches/')) data = batch;
          else {
            errors.push(`未预期 API ${method} ${url.pathname}`);
            await route.abort();
            return;
          }
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      await page.goto(`${process.env.OFFICIAL_BROWSER_URL || 'http://127.0.0.1:5173'}/orders`);
      const desktopList = page.getByRole('table').filter({
        has: page.getByRole('columnheader', { name: '订单号', exact: true }),
      });
      const list = width < 768 ? page.locator('.orders-mobile-list') : desktopList;
      await list
        .getByRole('button', { name: '更新官网状态 W1234567890', exact: true })
        .waitFor({ timeout: 10000 })
        .catch(async error => {
          process.stderr.write(
            JSON.stringify({
              errors,
              body: (await page.locator('body').innerText()).slice(0, 5000),
            })
          );
          throw error;
        });
      assert.equal(writes.length, 0, '加载页面不能创建官网任务');
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page.getByRole('button', { name: '官网更新进度', exact: true }).click();
      await page.getByText('暂无官网更新任务，请在订单列表中选择订单并手动更新。').waitFor();
      await page.getByRole('button', { name: '关闭官网更新进度', exact: true }).click();
      if (width >= 768) {
        const headers = await page.locator('th').allTextContents();
        assert(
          headers[headers.findIndex(label => label.trim() === '订单号') + 1].includes(
            '官网订单状态'
          )
        );
      }
      await list.getByRole('button', { name: '更新官网状态 W1234567890', exact: true }).click();
      await page
        .getByRole('region', { name: '官网更新进度' })
        .getByRole('button', { name: '取消待处理任务' })
        .waitFor();
      assert.deepEqual(writes.at(-1).body.orderIds, [101]);
      await page
        .getByRole('region', { name: '官网更新进度' })
        .getByText(/^共 1 单/)
        .waitFor();
      await page.getByRole('button', { name: '关闭官网更新进度', exact: true }).click();
      await list.getByRole('checkbox', { name: '选择订单 W1234567890', exact: true }).check();
      await list.getByRole('checkbox', { name: '选择订单 W1234567891', exact: true }).check();
      await page.getByRole('button', { name: '更新选中官网状态', exact: true }).click();
      await page.getByText('已选择 2 单；新增 2 单，0 单已在队列中，跳过重复提交').waitFor();
      assert.deepEqual(writes.at(-1).body.orderIds, [101, 102]);
      await page.getByRole('button', { name: '关闭官网更新进度', exact: true }).click();
      await page.getByRole('button', { name: '全选本页', exact: true }).click();
      assert.equal(
        await list.getByRole('checkbox', { name: '选择订单 W1234567890', exact: true }).isChecked(),
        true
      );
      await page.getByRole('button', { name: '取消选择', exact: true }).click();
      await page
        .getByPlaceholder('搜索订单 ID、订单号、Serial No.、Apple ID 或取机人...')
        .fill('合成');
      await page.getByRole('button', { name: '全选筛选结果（42）', exact: true }).click();
      await page.getByText('已选择筛选结果全部 42 单').waitFor();
      assert.equal(await page.getByRole('button', { name: '导出选中订单' }).isDisabled(), true);
      await page.getByRole('button', { name: '更新选中官网状态', exact: true }).click();
      await page.getByText('已选择 42 单；新增 42 单，0 单已在队列中，跳过重复提交').waitFor();
      assert.equal(writes.at(-1).body.selection, 'filtered');
      assert.equal(writes.at(-1).body.filters.keyword, '合成');
      await page
        .getByRole('region', { name: '官网更新进度' })
        .getByRole('button', { name: '取消待处理任务' })
        .click();
      await page.getByText('查看逐单结果').click();
      await page
        .getByRole('region', { name: '官网更新进度' })
        .getByText('已取消', { exact: true })
        .first()
        .waitFor();
      const writeCount = writes.length;
      await page.reload();
      if (role === 'admin')
        await page.getByRole('button', { name: '官网更新进度', exact: true }).click();
      await page.getByRole('region', { name: '官网更新进度' }).waitFor();
      assert.equal(writes.length, writeCount, '重开页面只恢复任务，不新建任务');
      batch.counts = { queued: 0, running: 0, succeeded: 0, failed: 2, cancelled: 0 };
      batch.jobs = batch.jobs.map((job, index) => ({
        ...job,
        state: 'failed',
        errorCode: index ? 'ACCOUNT_REFERENCE_CONFLICT' : 'ORDER_CREDENTIALS_MISSING',
      }));
      await page.reload();
      if (role === 'admin')
        await page.getByRole('button', { name: '官网更新进度', exact: true }).click();
      await page.getByText('查看逐单结果', { exact: true }).click();
      await page.getByText('缺少可用的账号密码，请补全订单或账号资料', { exact: true }).waitFor();
      await page.getByText('订单与关联 Apple ID 不一致，请核对账号关联', { exact: true }).waitFor();
      assert.equal(writes.length, writeCount, '展示具体错误不自动重试官网');
      batch.pausedAt = new Date().toISOString();
      batch.pauseReason = 'AUTH_REJECTED';
      batch.workerOnline = true;
      batch.counts = { queued: 1, running: 0, succeeded: 0, failed: 1, cancelled: 0 };
      batch.jobs[0].state = 'queued';
      batch.jobs[0].errorCode = null;
      await page.reload();
      if (role === 'admin')
        await page.getByRole('button', { name: '官网更新进度', exact: true }).click();
      await page.getByText(/批次已暂停：官网未接受本次登录/).waitFor();
      await page
        .getByText('官网更新服务在线，此批次暂停不影响新的手动查询。', { exact: true })
        .waitFor();
      await page.getByText('查看逐单结果', { exact: true }).click();
      await page.getByText('已暂停', { exact: true }).waitFor();
      assert.equal(writes.length, writeCount, '展示暂停和刷新不自动恢复查询');
      batch.pauseReason = 'AUTH_PRECONDITION_REQUIRED';
      batch.jobs[1].errorCode = 'AUTH_PRECONDITION_REQUIRED';
      await page.reload();
      if (role === 'admin')
        await page.getByRole('button', { name: '官网更新进度', exact: true }).click();
      await page.getByText(/批次已暂停：Apple 登录需要完成额外步骤（HTTP 412）/).waitFor();
      await page.getByText('查看逐单结果', { exact: true }).click();
      await page
        .getByText('Apple 登录需要完成额外步骤（HTTP 412），请核对官网提示', { exact: true })
        .waitFor();
      assert.equal(writes.length, writeCount, '412 提示不触发再次登录');
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        '页面不得横向溢出'
      );
      await page.screenshot({ path: `${OUTPUT}/官网手动更新-${width}.png`, fullPage: true });
      batch.workerOnline = false;
      await page.reload();
      if (role === 'admin')
        await page.getByRole('button', { name: '官网更新进度', exact: true }).click();
      await page
        .getByText('官网更新后台服务离线，请联系管理员检查；已有任务和官网状态已保留。', {
          exact: true,
        })
        .waitFor();
      assert.equal(writes.length, writeCount, '离线状态不得自动提交');
      role = 'operator';
      const readsBefore = officialReads;
      await page.reload();
      if (role === 'admin')
        await page.getByRole('button', { name: '官网更新进度', exact: true }).click();
      await list.getByRole('checkbox', { name: '选择订单 W1234567890', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: /更新.*官网状态/ }).count(), 0);
      assert.equal(await page.getByRole('region', { name: '官网更新进度' }).count(), 0);
      assert.equal(officialReads, readsBefore, '普通用户不读取官网任务');
      assert.equal(writes.length, writeCount, '普通用户不创建官网任务');
      assert.deepEqual(errors, []);
      await context.close();
    }
    process.stdout.write(
      'PC 1440px / H5 375px：单行、多选、两种全选、取消、恢复、列迁移、具体错误展示通过\n'
    );
  } catch (error) {
    process.exitCode = 1;
    throw error;
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
