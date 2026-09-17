/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  checkPaymentFilterLayout,
  checkProcessingFilterSubmission,
} = require('./paymentFilterLayout.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const output = '/tmp/apple-payment-dispatch-acceptance';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const calls = [];
    let failLink = false;
    let activeLinks = 0;
    let maxLinks = 0;
    let allowAssign = true;
    let lastTaskQuery = {};
    const noteWrites = [];
    const tasks = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      orderId: 9001 + i,
      orderNumber: `W000000000${i + 1}`,
      products: i === 1 ? [] : [{ name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', quantity: 2 }],
      paymentMethod: i === 1 ? null : 'WECHAT',
      officialOrderStatus: 'payment_due',
      officialPaymentStatus: 'unpaid',
      processingStatus: 'pending',
      processingNotes: i === 0 ? '首条合成备注' : '',
      recipientTag: '明威 TAG',
      version: 0,
      lastCrawledAt: '2026-09-13T00:00:00Z',
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      autoAssignment: { ruleName: '明威规则', reason: '指定账号容量不足，等待释放容量' },
    }));
    const staff = [
      {
        id: 2,
        username: 'mingwei',
        nickname: '明威',
        status: 'active',
        hasExecutionPermissions: true,
        autoAssignEnabled: true,
        maxActiveTasks: 10,
        activeCount: 10,
        remainingCapacity: 0,
        version: 0,
        assignmentMode: 'tag_only',
        tagRules: [{ id: 1, name: '明威规则' }],
      },
      {
        id: 3,
        username: 'general',
        nickname: '普通账号',
        status: 'active',
        hasExecutionPermissions: true,
        autoAssignEnabled: true,
        maxActiveTasks: 10,
        activeCount: 2,
        remainingCapacity: 8,
        version: 0,
        assignmentMode: 'general',
        tagRules: [],
      },
    ];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
      localStorage.setItem('token', 'synthetic-dispatch');
      window.__copy = 'original';
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
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        calls.push(url.pathname);
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            role: 'admin',
            username: 'synthetic',
            nickname: '验收',
            permissions: [
              'payment_dispatch.read',
              'payment_dispatch.configure',
              'payment_dispatch.correct',
              ...(allowAssign ? ['payment_dispatch.assign'] : []),
            ],
            availableHome: '/payment-dispatch',
          };
        else if (url.pathname === '/api/payment-dispatch/overview')
          data = { settings: { enabled: true, mode: 'auto', version: 0 }, staff };
        else if (url.pathname === '/api/payment-dispatch/tasks') {
          lastTaskQuery = Object.fromEntries(url.searchParams);
          data = {
            items: tasks,
            pagination: { page: 1, limit: 20, total: 7, totalPages: 1 },
            productNameOptions: ['iPhone 18 Pro Max 512GB 勃艮第酒红色'],
            recipientTagOptions: ['明威 TAG'],
            serverTime: new Date().toISOString(),
          };
        } else if (/\/payment-link$/.test(url.pathname)) {
          activeLinks++;
          maxLinks = Math.max(maxLinks, activeLinks);
          await new Promise(resolve => setTimeout(resolve, 100));
          activeLinks--;
          if (failLink && url.pathname.includes('/2/')) {
            await route.fulfill({
              status: 404,
              json: { success: false, error: { message: '订单链接不存在' } },
            });
            return;
          }
          data = { paymentUrl: `https://example.com/order/${url.pathname.split('/').at(-2)}` };
        } else if (
          route.request().method() === 'PUT' &&
          /\/payment-dispatch\/tasks\/\d+\/notes$/.test(url.pathname)
        ) {
          const taskId = Number(url.pathname.split('/').at(-2));
          const payload = route.request().postDataJSON();
          const task = tasks.find(item => item.id === taskId);
          noteWrites.push({ taskId, payload });
          task.processingNotes = String(payload.processingNotes || '').trim() || null;
          task.version += 1;
          data = task;
        } else if (/\/refresh$/.test(url.pathname)) data = { jobId: 88, status: 'pending' };
        else if (/\/order-refresh\/jobs\/88$/.test(url.pathname))
          data = { id: 88, status: 'succeeded' };
        else {
          errors.push(`未预期接口 ${url.pathname}`);
          await route.fulfill({ status: 404, json: { success: false } });
          return;
        }
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
      }
    });
    await page.goto('http://127.0.0.1:5173/payment-dispatch');
    await page.getByText('订单 ID：9001', { exact: true }).waitFor();
    assert.equal(
      await page
        .locator('thead th')
        .filter({ hasText: /^商品信息$/ })
        .count(),
      1
    );
    assert.equal(
      await page
        .locator('thead th')
        .filter({ hasText: /^处理备注$/ })
        .count(),
      1
    );
    assert.equal(
      await page
        .locator('thead th')
        .filter({ hasText: /^数据更新时间$/ })
        .count(),
      1
    );
    const firstActionCell = page.locator('tbody tr').first().locator('td').last();
    assert.equal(await firstActionCell.getByRole('button').count(), 4);
    assert(
      await firstActionCell.getByRole('button', { name: '查看付款码', exact: true }).isVisible()
    );
    assert(await firstActionCell.getByText('复制订单信息', { exact: true }).isVisible());
    assert(await firstActionCell.getByText('刷新订单状态', { exact: true }).isVisible());
    assert(await firstActionCell.getByText('修改备注', { exact: true }).isVisible());
    assert(await page.getByText('首条合成备注', { exact: true }).isVisible());
    await page.getByRole('button', { name: '修改备注 订单 9001', exact: true }).click();
    await page.getByLabel('处理备注', { exact: true }).fill('调度页修改后的备注');
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await page.getByText('调度页修改后的备注', { exact: true }).waitFor();
    assert.deepEqual(noteWrites.at(-1), {
      taskId: 1,
      payload: { processingNotes: '调度页修改后的备注', expectedVersion: 0 },
    });
    await page.getByLabel('商品信息筛选', { exact: true }).click();
    await page
      .getByRole('option', { name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', exact: true })
      .click();
    await page.getByLabel('商品信息筛选', { exact: true }).click();
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByText('订单 ID：9001', { exact: true }).waitFor();
    assert.equal(
      lastTaskQuery.productNames,
      JSON.stringify(['iPhone 18 Pro Max 512GB 勃艮第酒红色'])
    );
    await checkProcessingFilterSubmission(page, () => lastTaskQuery);
    await page.getByRole('button', { name: '复制订单信息 W0000000001', exact: true }).click();
    await page
      .getByTestId('center-toast')
      .getByText('已复制 1 条订单信息', { exact: true })
      .waitFor();
    assert((await page.getByText('已复制 1 条订单信息', { exact: true }).count()) >= 2);
    await page.getByTestId('center-toast').waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal(
      await page.evaluate(() => window.__copy),
      '9001 || iPhone 18 Pro Max 512GB 勃艮第酒红色 x 2 || 微信 || https://example.com/order/1'
    );
    for (let i = 1; i <= 7; i++)
      await page.getByRole('checkbox', { name: `选择订单 W000000000${i}`, exact: true }).check();
    await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
    await page
      .getByTestId('center-toast')
      .getByText('已复制 7 条订单信息', { exact: true })
      .waitFor();
    const copied = await page.evaluate(() => window.__copy);
    assert.equal(copied.split('\n\n').length, 7);
    assert.equal(copied.split('\n\n')[1], '9002 || - || - || https://example.com/order/2');
    assert.ok(copied.endsWith('/7'));
    assert.ok(maxLinks <= 5);
    failLink = true;
    await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
    await page
      .getByTestId('center-toast')
      .getByText(/复制失败：.*W0000000002/)
      .waitFor();
    assert.equal(await page.evaluate(() => window.__copy), copied);
    assert.equal(
      calls.some(path => path.endsWith('/refresh')),
      false
    );
    await page.screenshot({
      path: `${output}/复制与失败提示.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '人员与容量', exact: true }).click();
    await page.getByText('TAG 专属', { exact: true }).waitFor();
    await page.getByText('普通分配', { exact: true }).waitFor();
    await page.screenshot({
      path: `${output}/TAG专属人员.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '关闭人员配置', exact: true }).click();
    for (const width of [375, 768, 1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: 1000 });
      const actionBoxes = await page
        .locator('.payment-dispatch-actions')
        .first()
        .locator('button')
        .evaluateAll(buttons =>
          buttons.map(button => {
            const box = button.getBoundingClientRect();
            return { x: Math.round(box.x), y: Math.round(box.y) };
          })
        );
      assert.equal(actionBoxes.length, 4);
      assert.equal(new Set(actionBoxes.map(box => box.x)).size, 2);
      assert.equal(new Set(actionBoxes.map(box => box.y)).size, 2);
      await checkPaymentFilterLayout(page, width, `${output}/紧凑筛选-${width}.png`);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      await page.screenshot({
        path: `${output}/调度-${width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.getByRole('button', { name: '刷新订单状态 W0000000001', exact: true }).click();
    await page.getByText('官网状态已更新', { exact: true }).waitFor();
    assert.ok(calls.includes('/api/order-refresh/jobs/88'));
    allowAssign = false;
    failLink = false;
    await page.reload();
    await page.getByRole('button', { name: '复制订单信息 W0000000001', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '批量刷新', exact: true }).count(), 0);
    assert.equal(
      await page.getByRole('button', { name: '批量复制订单信息', exact: true }).count(),
      1
    );
    assert.deepEqual(errors, []);
    process.stdout.write(
      'PASS: 紧凑筛选与长商品全文、商品多选、系统订单ID、独立商品与备注列、备注弹窗、四项操作、居中Toast、批量复制、权限和375/768/1440/1920/2560px\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
