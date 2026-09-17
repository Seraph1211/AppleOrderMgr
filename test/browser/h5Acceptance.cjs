/* eslint-env node, browser */
// 合成 API 验收：所有 /api 请求均拦截，不访问真实业务或官网。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  checkPaymentFilterLayout,
  checkProcessingFilterSubmission,
} = require('./paymentFilterLayout.cjs');
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
    let lastTaskQuery = {};
    const writes = [];
    const tasks = [1, 2].map(id => ({
      id,
      orderId: 9000 + id,
      orderNumber: `W123456789${id}`,
      version: 3,
      processingStatus: 'pending',
      processingNotes: '',
      products: [{ name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', quantity: 2 }],
      officialOrderAmount: id === 1 ? '8999.00' : null,
      officialOrderAmountCurrency: 'CNY',
      officialPaymentStatus: 'unpaid',
      officialOrderStatus: 'payment_due',
      recipientTag: '测试 TAG',
      lastCrawledAt: '2026-09-12T00:20:19Z',
      orderDate: '2026-09-12T00:10:19Z',
      paymentMethod: 'WECHAT',
      deadlineAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    }));
    const user = () => ({
      id: 999,
      username: 'h5_test',
      nickname: '手机测试',
      role: 'user',
      permissions,
      availableHome: '/payment-tasks',
    });
    await page.route('**/api/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let data;
      if (path === '/api/auth/login') data = { token: 'synthetic-only', user: user() };
      else if (path === '/api/auth/me') data = user();
      else if (path === '/api/payment-tasks') {
        lastTaskQuery = Object.fromEntries(url.searchParams);
        data = {
          items: tasks,
          pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
          productNameOptions: ['iPhone 18 Pro Max 512GB 勃艮第酒红色'],
          recipientTagOptions: ['测试 TAG'],
          serverTime: new Date().toISOString(),
        };
      } else if (/payment-code$/.test(path))
        data = {
          availability: 'available',
          orderId: 9001,
          orderNumber: 'W1234567891',
          products: [{ name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', quantity: 2 }],
          amount: '8999.00',
          paymentMethod: 'WECHAT',
          imageDataUrl:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
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
    await page.getByRole('button', { name: '查看付款码', exact: true }).first().click();
    await page
      .getByText('请对着屏幕扫码付款，不支持保存到相册后再识别付款', { exact: true })
      .waitFor();
    assert.equal(
      await page.getByText('可扫码付款，或长按图片保存后在微信相册识别。', { exact: true }).count(),
      0
    );
    await page.getByRole('button', { name: '关闭付款码', exact: true }).click();
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
    for (const width of [320, 375, 390, 430, 768, 1024, 1366, 1440, 1600, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      await checkPaymentFilterLayout(page, width, `${output}/紧凑筛选-${width}.png`);
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `页面溢出 ${width}`
      );
      assert(await page.getByText('订单 ID：9001').isVisible());
      assert.equal(await page.locator('[data-column="金额"], [data-label="金额"]').count(), 0);
      // 输入控件有宽度过渡，等待断点切换稳定后检查可读宽度。
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="订单 9001 人工处理状态"]').getBoundingClientRect()
            .width >= 76
      );
      const buttonBoxes = await page
        .locator('.payment-task-actions')
        .first()
        .locator('button')
        .evaluateAll(buttons =>
          buttons.map(button => {
            const rect = button.getBoundingClientRect();
            return { x: Math.round(rect.x), y: Math.round(rect.y), right: rect.right };
          })
        );
      assert.equal(buttonBoxes.length, 4);
      assert.equal(
        new Set(buttonBoxes.map(box => box.y)).size,
        width >= 2560 ? 1 : 2,
        `操作行数 ${width}`
      );
      assert.equal(
        new Set(buttonBoxes.map(box => box.x)).size,
        width >= 2560 ? 4 : 2,
        `操作列数 ${width}`
      );
      assert(
        buttonBoxes.every(box => box.right <= width),
        `按钮溢出 ${width}`
      );
      assert(
        await page
          .locator('.payment-task-table')
          .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
        `表格溢出 ${width}`
      );
      const actions = page.getByRole('button', { name: '复制订单信息', exact: true }).first();
      assert(await actions.isVisible());
      assert(
        await page.getByRole('button', { name: '查看付款码', exact: true }).first().isVisible()
      );
      assert(
        await page.getByRole('button', { name: '刷新订单状态', exact: true }).first().isVisible()
      );
      assert(
        await page.getByRole('button', { name: '修改备注 订单 9001', exact: true }).isVisible()
      );
      assert.equal(await page.getByRole('button', { name: '更多', exact: true }).count(), 0);
      assert(
        await actions.evaluate(element => element.getBoundingClientRect().right <= innerWidth),
        `操作溢出 ${width}`
      );
      if (width >= 768 && width < 1600) {
        assert(await page.locator('#task-details-1').getByText('-', { exact: true }).isVisible());
        assert.equal(await page.locator('#task-details-1 textarea').count(), 0);
        assert(
          await page
            .locator('.payment-task-table')
            .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          `展开后表格溢出 ${width}`
        );
      }

      await page.screenshot({ path: `${output}/付款任务-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: '筛选任务', exact: true }).click();
    await page.getByPlaceholder('订单号', { exact: true }).fill('W123');
    await page.getByLabel('商品信息筛选', { exact: true }).click();
    await page
      .getByRole('option', { name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', exact: true })
      .click();
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByText('订单 ID：9001').waitFor();
    assert.equal(
      lastTaskQuery.productNames,
      JSON.stringify(['iPhone 18 Pro Max 512GB 勃艮第酒红色'])
    );
    await checkProcessingFilterSubmission(page, () => lastTaskQuery);
    await page.getByRole('button', { name: '刷新订单状态', exact: true }).first().click();
    await page.locator('[role="status"]').filter({ hasText: '官网状态已更新' }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: '详情与备注' }).count(), 0);
    assert.equal(await page.locator('.payment-task-table textarea').count(), 0);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: '复制订单信息', exact: true }).first().click();
    await page.getByTestId('center-toast').getByText('订单信息已复制', { exact: true }).waitFor();
    assert((await page.getByText('订单信息已复制', { exact: true }).count()) >= 2);
    await page.getByTestId('center-toast').waitFor({ state: 'hidden', timeout: 5000 });
    assert((await page.evaluate(() => navigator.clipboard.readText())).startsWith('9001 ||'));
    await page.getByLabel('全选当前页', { exact: true }).check();
    await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
    await page
      .getByTestId('center-toast')
      .getByText('已复制 2 条订单信息', { exact: true })
      .waitFor();
    const copiedOrders = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copiedOrders.split('\n\n').length, 2);
    assert.equal(copiedOrders.split('\n')[1], '');
    assert.equal(copiedOrders.startsWith('\n') || copiedOrders.endsWith('\n'), false);
    await page.getByRole('button', { name: '批量修改处理状态', exact: true }).click();
    await page.getByLabel('批量目标处理状态', { exact: true }).selectOption('processing');
    await page.getByRole('button', { name: '确认修改 2 项', exact: true }).click();
    await page.getByText('批量修改：成功 1 项，失败 1 项').first().waitFor();
    assert.equal(writes.length, 2);
    assert.equal(writes[0].payload.processingNotes, undefined);
    assert.equal(writes[0].payload.expectedVersion, 3);
    assert.equal(await page.getByLabel('选择订单 W1234567891').isChecked(), false);
    assert.equal(await page.getByLabel('选择订单 W1234567892').isChecked(), true);
    await page.screenshot({ path: `${output}/批量部分失败.png`, fullPage: true });
    failSecond = false;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '确认修改 1 项', exact: true }).click();
    await page.getByText('批量修改：成功 1 项，失败 0 项').first().waitFor();
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
    assert.equal(await page.getByRole('button', { name: '修改备注 订单 9001' }).count(), 0);
    assert.equal(await page.locator('.payment-task-table textarea').count(), 0);
    assert.equal(await page.getByText('付款人', { exact: true }).count(), 0);
    assert(
      await page
        .locator('.payment-task-table')
        .evaluate(element => element.scrollWidth <= element.clientWidth + 1)
    );
    permissions = ['payment_tasks.read_own', 'payment_tasks.handle_own'];
    await page.reload();
    await page.getByText('订单 ID：9001').waitFor();
    await page.getByRole('button', { name: '修改备注 订单 9001', exact: true }).click();
    await page.getByLabel('处理备注', { exact: true }).fill('弹窗内保存的合成备注');
    await page.screenshot({ path: `${output}/修改备注弹窗-1440.png`, fullPage: true });
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await page.getByTestId('center-toast').getByText('处理备注已保存', { exact: true }).waitFor();
    assert.equal(writes.at(-1).payload.processingNotes, '弹窗内保存的合成备注');
    assert.equal(writes.at(-1).payload.payerName, undefined);
    tasks[0].processingStatus = 'pending';
    await page.reload();
    await page.getByText('订单 ID：9001').waitFor();
    const beforeStatusWriteCount = writes.length;
    await page.getByLabel('订单 9001 人工处理状态').selectOption('processing');
    await page.getByTestId('center-toast').getByText('处理状态已更新', { exact: true }).waitFor();
    assert.equal(writes.length, beforeStatusWriteCount + 1);
    assert.deepEqual(Object.keys(writes.at(-1).payload).sort(), [
      'expectedVersion',
      'processingStatus',
    ]);
    for (const [from, to] of [
      ['pending', 'exception'],
      ['exception', 'processing'],
      ['pending', 'completed'],
    ]) {
      tasks[0].processingStatus = from;
      tasks[0].processingNotes = '';
      await page.reload();
      await page.getByText('订单 ID：9001').waitFor();
      const before = writes.length;
      await page.getByLabel('订单 9001 人工处理状态').selectOption(to);
      await page.getByTestId('center-toast').getByText('处理状态已更新', { exact: true }).waitFor();
      assert.equal(writes.length, before + 1);
      assert.equal(writes.at(-1).payload.processingStatus, to);
      assert.equal(writes.at(-1).payload.processingNotes, undefined);
      assert.equal(
        await page.getByText('请先保存处理备注，再选择该状态', { exact: true }).count(),
        0
      );
    }
    await page.locator('aside').getByRole('link', { name: '个人设置', exact: true }).click();
    await page.waitForURL('**/profile');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/个人设置-1440.png`, fullPage: true });
    assert.deepEqual(errors, []);
    process.stdout.write(
      `H5 合成验收通过：十一种宽度、金额列移除、四项操作两列或超宽屏单行、商品多选与独立列、状态自动保存、备注文本与弹窗修改、居中Toast、付款人入口移除、批量部分失败及权限。截图：${output}\n`
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
