/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成 API 契约 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const errors = [];
    const submissions = [];
    const phoneWrites = [];
    let allowRefresh = true;
    let batchFails = false;
    const name = 'iPhone 18 Pro Max 512GB 冰川蓝色';
    const products = [
      { name, model: 'TEST-M1', quantity: 1 },
      { name, model: 'TEST-M1', quantity: 1 },
    ];
    const task = {
      id: 1,
      orderId: 1,
      orderNumber: 'W7333333331',
      products,
      processingStatus: 'pending',
      officialOrderStatus: 'pending',
      version: 0,
    };
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-profiles-only'));
    await context.route('**/*', async route => {
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
            role: 'operator',
            username: '合成验收',
            permissions: [
              'orders.read',
              ...(allowRefresh ? ['orders.refresh'] : []),
              'payment_tasks.read_own',
              'payment_dispatch.read',
              'recipients.read',
              'recipients.edit',
              'apple_ids.read',
            ],
            availableHome: '/orders',
          };
        else if (url.pathname === '/api/orders/filter-options')
          data = { productNames: [name], stores: [] };
        else if (url.pathname === '/api/system/auto-refresh') data = { isRunning: false };
        else if (url.pathname === '/api/orders')
          data = {
            total: 3,
            orders: [1, 2, 3].map(id => ({
              id,
              order_number: `W733333333${id}`,
              products,
              status: 'pending',
              validation_status: 'valid',
            })),
          };
        else if (url.pathname === '/api/orders/batch-refresh') {
          submissions.push(route.request().postDataJSON().order_ids);
          if (batchFails) {
            await route.fulfill({
              status: 500,
              json: { success: false, error: { message: '合成提交失败' } },
            });
            return;
          }
          data = {
            total: 3,
            created: 1,
            merged: 1,
            missing: 1,
            results: [
              { orderId: 1, jobId: 101, created: true },
              { orderId: 2, jobId: 202, created: false },
              { orderId: 3, jobId: null, created: false, reason: 'order_not_found' },
            ],
          };
        } else if (url.pathname === '/api/order-refresh/jobs/101')
          data = { id: 101, orderId: 1, status: 'succeeded' };
        else if (url.pathname === '/api/payment-dispatch/overview')
          data = { settings: { enabled: false, mode: 'manual' }, staff: [] };
        else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(url.pathname))
          data = {
            items: [task],
            pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
            productNameOptions: [name],
            recipientTagOptions: [],
            serverTime: new Date().toISOString(),
          };
        else if (url.pathname === '/api/recipients')
          data = {
            recipients: [
              {
                id: 1,
                name: '合成人员',
                last_name: '合',
                first_name: '成人员',
                id_card_number: '110101199001011234',
                phone: '13800000000',
                status: '使用中',
              },
            ],
            total: 1,
          };
        else if (url.pathname === '/api/recipients/1' && route.request().method() === 'PUT') {
          phoneWrites.push(route.request().postDataJSON());
          data = {};
        } else if (url.pathname === '/api/apple-ids')
          data = {
            apple_ids: [
              {
                id: 1,
                apple_id: 'synthetic@example.invalid',
                password: 'synthetic-display-only',
                status: '使用中',
              },
            ],
            total: 1,
          };
        else throw new Error(`未预期请求 ${url.pathname}`);
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const path of ['orders', 'payment-tasks', 'payment-dispatch']) {
        await page.goto(`http://127.0.0.1:5173/${path}`);
        await page.getByText(`${name} ×2`, { exact: true }).first().waitFor();
        assert.equal(await page.getByText(`${name} ×1`, { exact: true }).count(), 0);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('http://127.0.0.1:5173/orders');
    await page.getByLabel('全选本页订单').check();
    await page.getByRole('button', { name: '批量刷新订单', exact: true }).click();
    await page.getByText(/已提交或合并 2 项，未提交 1 项/).waitFor();
    assert.deepEqual(submissions[0], [1, 2, 3]);
    await page.getByText('刷新成功', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('选择订单 W7333333333').isChecked(), true);
    assert.equal(await page.getByLabel('选择订单 W7333333331').isChecked(), false);
    batchFails = true;
    await page.getByRole('button', { name: '批量刷新订单', exact: true }).click();
    await page.getByText('合成提交失败', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('选择订单 W7333333333').isChecked(), true);
    await page.getByLabel('取货日期筛选').fill('2026-09-19');
    await page.getByText('已选择 0 项（当前页）', { exact: true }).waitFor();
    allowRefresh = false;
    await page.reload();
    await page.getByText('W7333333331', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('全选本页订单').count(), 0);
    assert.equal(await page.getByRole('button', { name: '批量刷新订单' }).count(), 0);
    await page.goto('http://127.0.0.1:5173/recipients');
    await page.getByText('110101199001011234', { exact: true }).waitFor();
    await page.getByText('13800000000', { exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑取机人 1', exact: true }).click();
    await page.getByLabel('下单手机号', { exact: true }).fill('');
    await page.getByRole('button', { name: /保存/ }).click();
    await page.getByRole('heading', { name: '编辑取机人' }).waitFor({ state: 'hidden' });
    assert.equal(phoneWrites[0].phone, '');
    await page.goto('http://127.0.0.1:5173/apple-ids');
    await page.getByText('synthetic-display-only', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    process.stdout.write(
      'PASS: 三页商品合并、桌面/手机、批量部分失败/结果/权限/选择清空、字段明文和电话清空\n'
    );
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
