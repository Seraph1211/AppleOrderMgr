/* global localStorage */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
(async () => {
  if (!process.env.ASSIGNMENT_BROWSER_WS) throw new Error('需要专用临时浏览器地址');
  const browser = await chromium.connectOverCDP(process.env.ASSIGNMENT_BROWSER_WS);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const submitted = [];
  let fail = false;
  const version = 0;
  const tasks = [1, 2, 3].map(id => ({
    id,
    orderId: 330 + id,
    orderNumber: `W000000000${id}`,
    orderDate: '2026-09-19T13:38:00Z',
    products: [{ name: '合成商品', quantity: 2 }],
    officialOrderStatus: id === 2 ? 'processing' : 'pending',
    officialPaymentStatus: id === 2 ? 'paid' : null,
    processingStatus: 'pending',
    version: 0,
    recipientTag: '合成TAG',
    deadlineAt: '2026-09-19T14:08:00Z',
    assignee: null,
  }));
  const staff = [
    {
      id: 1,
      username: 'synthetic',
      nickname: '合成负责人',
      status: 'active',
      hasExecutionPermissions: true,
      autoAssignEnabled: false,
      maxActiveTasks: 10,
      activeCount: 2,
      remainingCapacity: 8,
    },
    {
      id: 2,
      username: 'locked',
      status: 'locked',
      hasExecutionPermissions: true,
      maxActiveTasks: 10,
      activeCount: 0,
      remainingCapacity: 10,
    },
  ];
  await context.addInitScript(() => localStorage.setItem('token', 'synthetic-token'));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) {
      if (url.origin === 'http://127.0.0.1:5173') return route.continue();
      return route.abort();
    }
    let data = {};
    if (url.pathname === '/api/auth/me')
      data = {
        id: 1,
        username: 'synthetic',
        role: 'admin',
        permissions: ['payment_dispatch.read', 'payment_dispatch.assign'],
        availableHome: '/payment-dispatch',
      };
    else if (url.pathname.endsWith('/overview'))
      data = { settings: { enabled: true, mode: 'auto', version: 0 }, staff };
    else if (url.pathname === '/api/payment-dispatch/tasks')
      data = {
        items: tasks.map(t => ({ ...t, version })),
        pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
        productOptions: [],
        recipientTagOptions: [],
        serverTime: new Date().toISOString(),
      };
    else if (url.pathname.endsWith('/assignment-preview')) {
      const body = route.request().postDataJSON();
      data = {
        items: body.tasks.map(t => ({
          id: t.id,
          orderId: 330 + t.id,
          eligible: t.id !== 2,
          code: t.id === 2 ? 'PAYMENT_NOT_ELIGIBLE' : null,
          reason: t.id === 2 ? '订单已付款' : null,
          solution: t.id === 2 ? '无需再分配付款' : null,
          expired: true,
          warnings: t.id === 1 ? ['官网状态尚未核实', '存在身份异常提示，请核对订单'] : [],
          hasTransfer: false,
        })),
        eligibleCount: 2,
        blockedCount: 1,
      };
    } else if (url.pathname.endsWith('/tasks/assignee')) {
      const body = route.request().postDataJSON();
      submitted.push(body);
      if (fail) {
        fail = false;
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: {
              code: 'CAPACITY_EXCEEDED',
              message: '接收人容量已变化',
              details: { requestId: 'synthetic-request' },
            },
          }),
        });
      }
      data = { count: body.tasks.length, items: [] };
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
  });
  try {
    await page.goto('http://127.0.0.1:5173/payment-dispatch');
    await page.getByLabel('选择当前页全部任务').check();
    await page.getByRole('button', { name: '分配所选订单' }).click();
    const dialog = page.getByRole('dialog', { name: '批量分配付款任务' });
    await dialog.getByLabel('负责人', { exact: true }).selectOption('1');
    await dialog.getByRole('button', { name: '仅分配符合条件的 2 条' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '确认全部分配' }).isDisabled(), true);
    assert.notEqual(await dialog.locator('option[value="2"]').getAttribute('disabled'), null);
    await dialog.getByText('官网状态尚未核实', { exact: false }).waitFor();
    await page.screenshot({ path: '/tmp/assignment-desktop.png', fullPage: true });
    fail = true;
    await dialog.getByRole('button', { name: '仅分配符合条件的 2 条' }).click();
    await dialog.getByRole('alert').filter({ hasText: 'synthetic-request' }).waitFor();
    await page.waitForTimeout(150);
    await dialog.getByRole('button', { name: '仅分配符合条件的 2 条' }).click();
    await dialog.getByText('已分配 2 条，未分配 1 条。').waitFor();
    assert.deepEqual(
      submitted[1].tasks.map(t => t.id),
      [1, 3]
    );
    assert.equal(await dialog.getByText('未分配：订单已付款').count(), 1);
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByLabel('选择当前页全部任务').check();
    await page.getByRole('button', { name: '分配所选订单' }).click();
    await dialog.getByLabel('负责人', { exact: true }).selectOption('1');
    await dialog.getByRole('button', { name: '仅分配符合条件的 2 条' }).waitFor();
    await page.screenshot({ path: '/tmp/assignment-mobile.png', fullPage: true });
    const box = await dialog.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 375);
    assert.deepEqual(errors, []);
    process.stdout.write(
      JSON.stringify({
        passed: true,
        submitted: submitted.length,
        screenshots: ['/tmp/assignment-desktop.png', '/tmp/assignment-mobile.png'],
      }) + '\n'
    );
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(e => {
  process.stderr.write(e.stack + '\n');
  process.exit(1);
});
