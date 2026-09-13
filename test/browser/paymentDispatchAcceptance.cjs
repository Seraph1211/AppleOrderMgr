/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    const tasks = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1, orderId: 9001 + i, orderNumber: `W000000000${i + 1}`,
      products: i === 1 ? [] : [{ name: '合成手机', quantity: 2 }],
      paymentMethod: i === 1 ? null : 'WECHAT',
      officialOrderStatus: 'payment_due', officialPaymentStatus: 'unpaid',
      processingStatus: 'pending', recipientTag: '明威 TAG', version: 0,
      lastCrawledAt: '2026-09-13T00:00:00Z',
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      autoAssignment: { ruleName: '明威规则', reason: '指定账号容量不足，等待释放容量' },
    }));
    const staff = [{ id: 2, username: 'mingwei', nickname: '明威', status: 'active',
      hasExecutionPermissions: true, autoAssignEnabled: true, maxActiveTasks: 10,
      activeCount: 10, remainingCapacity: 0, version: 0, assignmentMode: 'tag_only',
      tagRules: [{ id: 1, name: '明威规则' }],
    }, { id: 3, username: 'general', nickname: '普通账号', status: 'active',
      hasExecutionPermissions: true, autoAssignEnabled: true, maxActiveTasks: 10,
      activeCount: 2, remainingCapacity: 8, version: 0, assignmentMode: 'general', tagRules: [],
    }];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
      localStorage.setItem('token', 'synthetic-dispatch');
      window.__copy = 'original';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async value => { window.__copy = value; },
      } });
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
        if (url.pathname === '/api/auth/me') data = {
          id: 1, role: 'admin', username: 'synthetic', nickname: '验收',
          permissions: ['payment_dispatch.read', 'payment_dispatch.configure',
            ...(allowAssign ? ['payment_dispatch.assign'] : [])], availableHome: '/payment-dispatch',
        };
        else if (url.pathname === '/api/payment-dispatch/overview')
          data = { settings: { enabled: true, mode: 'auto', version: 0 }, staff };
        else if (url.pathname === '/api/payment-dispatch/tasks') data = {
          items: tasks, pagination: { page: 1, limit: 20, total: 7, totalPages: 1 },
          recipientTagOptions: ['明威 TAG'], serverTime: new Date().toISOString(),
        };
        else if (/\/payment-link$/.test(url.pathname)) {
          activeLinks++;
          maxLinks = Math.max(maxLinks, activeLinks);
          await new Promise(resolve => setTimeout(resolve, 100));
          activeLinks--;
          if (failLink && url.pathname.includes('/2/')) {
            await route.fulfill({ status: 404, json: { success: false,
              error: { message: '订单链接不存在' } } });
            return;
          }
          data = { paymentUrl: `https://example.com/order/${url.pathname.split('/').at(-2)}` };
        } else if (/\/refresh$/.test(url.pathname)) data = { jobId: 88, status: 'pending' };
        else if (/\/order-refresh\/jobs\/88$/.test(url.pathname)) data = { id: 88, status: 'succeeded' };
        else {
          errors.push(`未预期接口 ${url.pathname}`);
          await route.fulfill({ status: 404, json: { success: false } });
          return;
        }
        await route.fulfill({ json: { success: true, data } });
      } catch (error) { errors.push(error.message); }
    });
    await page.goto('http://127.0.0.1:5173/payment-dispatch');
    await page.getByRole('button', { name: '复制订单信息 W0000000001', exact: true }).click();
    await page.getByText('已复制 1 条订单信息', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__copy), '9001 || 合成手机 x 2 || 微信 || https://example.com/order/1');
    for (let i = 1; i <= 7; i++)
      await page.getByRole('checkbox', { name: `选择订单 W000000000${i}`, exact: true }).check();
    await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
    await page.getByText('已复制 7 条订单信息', { exact: true }).waitFor();
    const copied = await page.evaluate(() => window.__copy);
    assert.equal(copied.split('\n\n').length, 7);
    assert.equal(copied.split('\n\n')[1], '9002 || - || - || https://example.com/order/2');
    assert.ok(copied.endsWith('/7'));
    assert.ok(maxLinks <= 5);
    failLink = true;
    await page.getByRole('button', { name: '批量复制订单信息', exact: true }).click();
    await page.getByText(/复制失败：.*W0000000002/).waitFor();
    assert.equal(await page.evaluate(() => window.__copy), copied);
    assert.equal(calls.some(path => path.endsWith('/refresh')), false);
    await page.screenshot({ path: `${output}/复制与失败提示.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '人员与容量', exact: true }).click();
    await page.getByText('TAG 专属', { exact: true }).waitFor();
    await page.getByText('普通分配', { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/TAG专属人员.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '关闭人员配置', exact: true }).click();
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `${output}/调度-${width}.png`, fullPage: true, animations: 'disabled' });
    }
    await page.getByRole('button', { name: '刷新官网状态 W0000000001', exact: true }).click();
    await page.getByText('官网状态已更新', { exact: true }).waitFor();
    assert.ok(calls.includes('/api/order-refresh/jobs/88'));
    allowAssign = false;
    failLink = false;
    await page.reload();
    await page.getByRole('button', { name: '复制订单信息 W0000000001', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '批量刷新', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '批量复制订单信息', exact: true }).count(), 1);
    assert.deepEqual(errors, []);
    process.stdout.write('PASS: 单条/七条批量复制、顺序格式、五并发、失败保留剪贴板、权限独立、TAG人员和375/768/1440px\n');
  } finally { await browser.close(); }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
