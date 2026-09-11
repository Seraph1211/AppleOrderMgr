/* eslint-env node */
// 合成 API 验收：所有 /api 请求均拦截，不访问真实业务或官网。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const output = process.env.H5_ARTIFACT_DIR || '/tmp/apple-h5-acceptance';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let permissions = [
      'payment_tasks.read_own',
      'payment_tasks.handle_own',
      'payment_tasks.link.read_own',
      'payment_tasks.refresh_own',
    ];
    let failSecond = true;
    const writes = [];
    const tasks = [1, 2].map(id => ({
      id,
      orderId: 9000 + id,
      orderNumber: `W123456789${id}`,
      version: 3,
      processingStatus: 'pending',
      processingNotes: '',
      payerName: '',
      payerVersion: 0,
      products: [{ name: 'iPhone 测试商品 超长名称 蓝色 256GB', quantity: 2 }],
      officialOrderAmount: id === 1 ? '8999.00' : null,
      officialOrderAmountCurrency: 'CNY',
      officialPaymentStatus: 'unpaid',
      officialOrderStatus: 'payment_due',
      recipientTag: '测试 TAG',
      lastCrawledAt: null,
    }));
    const user = () => ({
      id: 999,
      username: 'h5_test',
      nickname: '手机测试',
      role: 'user',
      permissions,
      availableHome: '/payment-tasks',
    });
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let data;
      if (path === '/api/auth/login') data = { token: 'synthetic-only', user: user() };
      else if (path === '/api/auth/me') data = user();
      else if (path === '/api/payment-tasks')
        data = {
          items: tasks,
          pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
          recipientTagOptions: ['测试 TAG'],
          serverTime: new Date().toISOString(),
        };
      else if (/payment-link$/.test(path))
        data = { paymentUrl: 'https://example.com/synthetic-order' };
      else if (/\/refresh$/.test(path)) data = { jobId: 77, status: 'pending' };
      else if (/\/refresh\/77$/.test(path)) data = { id: 77, status: 'succeeded' };
      else if (request.method() === 'PUT' && /\/payment-tasks\/\d+$/.test(path)) {
        const id = Number(path.split('/').pop());
        const payload = request.postDataJSON();
        writes.push({ id, payload });
        if (id === 2 && failSecond) {
          return route.fulfill({
            status: 409,
            json: {
              success: false,
              error: { code: 'CONCURRENT_MODIFICATION', message: '任务已被更新' },
            },
          });
        }
        const task = tasks.find(item => item.id === id);
        Object.assign(task, payload, { version: task.version + 1 });
        data = task;
      } else {
        return route.fulfill({
          status: 404,
          json: { success: false, message: '合成环境未定义接口' },
        });
      }
      return route.fulfill({ json: { success: true, data } });
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('http://127.0.0.1:5173/login');
    await page.screenshot({ path: `${output}/调试.png` });
    if (errors.length) throw new Error(errors.join('\n'));
    await page.getByLabel('登录账号', { exact: true }).fill('h5_test');
    await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
    assert.equal(await page.locator('#username').getAttribute('autocapitalize'), 'none');
    await page.screenshot({ path: `${output}/登录-375.png`, fullPage: true });
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/payment-tasks');
    await page.getByText('订单 ID：9001').waitFor();
    for (const width of [375, 430, 768]) {
      await page.setViewportSize({ width, height: 932 });
      await page.locator('header').getByRole('button', { name: '打开导航', exact: true }).click();
      await page
        .locator('aside')
        .getByRole('link', { name: '个人设置', exact: true })
        .click({ timeout: 3000 });
      await page.waitForURL('**/profile');
      assert.equal(
        await page.getByRole('button', { name: '关闭导航遮罩', exact: true }).count(),
        0
      );
      await page.locator('header').getByRole('button', { name: '打开导航', exact: true }).click();
      await page.locator('aside').getByRole('link', { name: '付款任务', exact: true }).click();
      await page.waitForURL('**/payment-tasks');
      await page.getByText('订单 ID：9001').waitFor();
      await page.locator('header').getByRole('button', { name: '打开导航', exact: true }).click();
      await page.getByRole('button', { name: '关闭导航', exact: true }).click();
      assert.equal(
        await page.getByRole('button', { name: '关闭导航遮罩', exact: true }).count(),
        0
      );
      await page.locator('header').getByRole('button', { name: '打开导航', exact: true }).click();
      await page
        .getByRole('button', { name: '关闭导航遮罩', exact: true })
        .click({ position: { x: width - 15, y: 100 } });
      assert.equal(
        await page.getByRole('button', { name: '关闭导航遮罩', exact: true }).count(),
        0
      );
    }
    const originalPermissions = [...permissions];
    permissions = [
      ...permissions,
      'dashboard.read',
      'orders.read',
      'apple_ids.read',
      'recipients.read',
      'identity.read',
      'channels.read',
      'payment_dispatch.read',
      'ingestion.read',
      'email.read',
      'system.logs.read',
      'users.read',
    ];
    await page.reload();
    await page.getByText('订单 ID：9001').waitFor();
    await page.setViewportSize({ width: 430, height: 500 });
    await page.locator('header').getByRole('button', { name: '打开导航', exact: true }).click();
    await page
      .locator('aside')
      .getByRole('link', { name: '个人设置', exact: true })
      .scrollIntoViewIfNeeded();
    assert(
      await page
        .getByRole('navigation', { name: '主导航' })
        .evaluate(element => element.scrollTop > 0)
    );
    await page.locator('aside').getByRole('link', { name: '个人设置', exact: true }).click();
    await page.waitForURL('**/profile');
    await page.setViewportSize({ width: 430, height: 932 });
    await page.locator('header').getByRole('button', { name: '打开导航', exact: true }).click();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('aside')).transform === 'matrix(1, 0, 0, 1, 0, 0)'
    );
    await page.screenshot({ path: `${output}/手机导航-430.png`, fullPage: true });
    await page.locator('aside').getByRole('link', { name: '付款任务', exact: true }).click();
    await page.waitForURL('**/payment-tasks');
    permissions = originalPermissions;
    await page.reload();
    await page.getByText('订单 ID：9001').waitFor();
    for (const width of [320, 375, 390, 430, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `页面溢出 ${width}`
      );
      assert(await page.getByText('订单 ID：9001').isVisible());
      await page.screenshot({ path: `${output}/付款任务-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: '筛选任务', exact: true }).click();
    await page.getByPlaceholder('订单号', { exact: true }).fill('W123');
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByText('订单 ID：9001').waitFor();
    await page.getByRole('button', { name: '刷新官网状态', exact: true }).first().click();
    await page.locator('[role="status"]').filter({ hasText: '官网状态已更新' }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: '详情与备注' }).count(), 0);
    assert.equal(await page.getByLabel('订单 9001 处理备注').isVisible(), false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByLabel('订单 9001 处理备注').fill('未保存的备注');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: '复制订单信息', exact: true }).first().click();
    await page.getByText('订单信息已复制', { exact: true }).waitFor();
    assert((await page.evaluate(() => navigator.clipboard.readText())).startsWith('9001 ||'));
    await page.getByLabel('全选当前页', { exact: true }).check();
    await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
    await page.getByText('已复制 2 条订单信息', { exact: true }).waitFor();
    const copiedOrders = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copiedOrders.split('\n\n').length, 2);
    assert.equal(copiedOrders.split('\n')[1], '');
    assert.equal(copiedOrders.startsWith('\n') || copiedOrders.endsWith('\n'), false);
    await page.getByRole('button', { name: '批量修改处理状态', exact: true }).click();
    await page.getByLabel('批量目标处理状态', { exact: true }).selectOption('processing');
    await page.getByRole('button', { name: '确认修改 2 项', exact: true }).click();
    await page.getByText('批量修改：成功 1 项，失败 1 项').waitFor();
    assert.equal(writes.length, 2);
    assert.equal(writes[0].payload.processingNotes, undefined);
    assert.equal(writes[0].payload.expectedVersion, 3);
    assert.equal(await page.getByLabel('订单 9001 处理备注').inputValue(), '未保存的备注');
    assert.equal(await page.getByLabel('选择订单 W1234567891').isChecked(), false);
    assert.equal(await page.getByLabel('选择订单 W1234567892').isChecked(), true);
    await page.screenshot({ path: `${output}/批量部分失败.png`, fullPage: true });
    failSecond = false;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '确认修改 1 项', exact: true }).click();
    await page.getByText('批量修改：成功 1 项，失败 0 项').waitFor();
    permissions = ['payment_tasks.read_own', 'payment_tasks.handle_own'];
    await page.reload();
    await page.getByText('订单 ID：9001').waitFor();
    assert(await page.getByRole('button', { name: '批量修改处理状态', exact: true }).isVisible());
    assert.equal(await page.getByRole('button', { name: '批量刷新', exact: true }).count(), 0);
    permissions = ['payment_tasks.read_own'];
    await page.reload();
    await page.getByText('订单 ID：9001').waitFor();
    assert.equal(
      await page.getByRole('button', { name: '批量修改处理状态', exact: true }).count(),
      0
    );
    assert(await page.getByLabel('订单 9001 人工处理状态').isDisabled());
    assert.deepEqual(errors, []);
    process.stdout.write(
      `H5 合成验收通过：六种宽度、登录、单项/批量复制、部分失败、草稿保留、电脑批量状态与权限。截图：${output}\n`
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
