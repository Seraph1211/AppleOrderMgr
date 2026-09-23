/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成响应遵循订单 API 契约 */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

/** 用合成订单和联系人验证手机订单列表与邮件选择，不访问业务 API。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-orders-mobile'));
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/')) {
        if (url.origin === 'http://127.0.0.1:5173') await route.continue();
        else await route.abort();
        return;
      }
      if (route.request().method() !== 'GET')
        writes.push({ path: url.pathname, body: route.request().postDataJSON() });
      let data;
      if (url.pathname === '/api/auth/me')
        data = {
          id: 1,
          username: '合成验收',
          role: 'operator',
          permissions: ['orders.read', 'orders.export', 'order_mail.read', 'order_mail.forward'],
          availableHome: '/orders',
        };
      else if (url.pathname === '/api/system/auto-refresh') data = { isRunning: false };
      else if (url.pathname === '/api/orders/filter-options')
        data = { productOptions: [], recipientTags: [], stores: [] };
      else if (url.pathname === '/api/orders')
        data = {
          total: 1,
          orders: [
            {
              id: 101,
              order_number: 'W1234567890',
              serial_numbers: ['F12345678901234567890'],
              email_order_status: 'processing',
              products: [{ name: 'iPhone 18 Pro Max 256GB', quantity: 1 }],
              recipient_name: '合成取机人',
              recipient_tag: '北京 测试团队',
              order_date: '2026-09-23T02:00:00Z',
            },
          ],
        };
      else if (url.pathname === '/api/orders/101/emails')
        data = {
          items: [
            {
              id: 'synthetic-mail',
              subject: '合成订单邮件',
              from: 'sender@example.test',
              to: 'original@example.test',
              date: '2026-09-23T02:00:00Z',
              attachments: [],
              expired: false,
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
          sync: { status: 'ready' },
        };
      else if (url.pathname === '/api/orders/101') data = { apple_password: null };
      else if (url.pathname === '/api/orders/101/link') data = { orderUrl: null };
      else if (url.pathname === '/api/orders/101/emails/synthetic-mail')
        data = { id: 'synthetic-mail', subject: '合成订单邮件', text: '合成正文', attachments: [] };
      else if (url.pathname.endsWith('/forwards')) data = [];
      else if (url.pathname === '/api/mail-contacts')
        data = {
          items: [
            { id: 1, name: '联系人甲', email: 'one@example.test' },
            { id: 2, name: '联系人乙', email: 'two@example.test' },
          ],
          total: 2,
          page: 1,
          limit: 20,
        };
      else if (url.pathname === '/api/orders/101/emails/synthetic-mail/forward-batch')
        data = { items: [{ id: 1, recipient: 'one@example.test', status: 'pending' }] };
      else {
        errors.push(`未预期请求 ${url.pathname}`);
        await route.abort();
        return;
      }
      await route.fulfill({ json: { success: true, data } });
    });

    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 720 });
      await page.goto('http://127.0.0.1:5173/orders');
      await page.getByRole('button', { name: '订单邮件 W1234567890' }).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `${width}px 下页面横向溢出 ${overflow}px`);
      if (width < 768) {
        assert.equal(await page.locator('.orders-mobile-list article').count(), 1);
        assert.equal(await page.locator('.orders-mobile-list').getByText('F12345678901234567890').count(), 0);
        assert.equal(await page.locator('table thead').first().isVisible(), false);
        const filter = page.getByRole('button', { name: /筛选条件.*展开/ });
        await filter.click();
        assert.equal(await page.locator('#orders-filters').isVisible(), true);
        await page.getByRole('button', { name: /筛选条件.*收起/ }).click();
        await page.locator('.orders-mobile-list').getByLabel('选择订单 W1234567890').check();
        await page.getByText('已选择 1 项（当前页）').waitFor();
        if (width === 390) {
          await page.locator('.orders-mobile-list').getByRole('button', { name: '查看' }).click();
          await page.getByRole('heading', { name: '订单详情' }).waitFor();
          await page.locator('.order-detail-modal').getByText('F12345678901234567890').waitFor();
          await page.getByRole('button', { name: '关闭订单详情' }).click();
        }
        if (width === 390)
          await page.screenshot({ path: '/tmp/apple-orders-mobile-390.png', fullPage: true });
      } else assert.equal(await page.locator('table thead').first().isVisible(), true);
    }

    await page.setViewportSize({ width: 390, height: 600 });
    await page.getByRole('button', { name: '订单邮件 W1234567890' }).click();
    await page.getByRole('button', { name: '查看邮件' }).click();
    await page.getByText('合成正文').waitFor();
    const search = page.getByRole('textbox', { name: '搜索转发联系人' });
    await search.click();
    const choices = page.getByRole('group', { name: '可选联系人' });
    await choices.getByRole('checkbox', { name: /联系人甲/ }).waitFor();
    assert.equal(await choices.isVisible(), true);
    await page.screenshot({ path: '/tmp/apple-orders-mail-contacts-390.png' });
    await choices.getByRole('checkbox', { name: /联系人甲/ }).click();
    await page.getByRole('button', { name: '移除 联系人甲' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '转发邮件' }).isEnabled(), true);
    await page.getByRole('button', { name: '转发邮件' }).click();
    await page.getByText('已提交 1 个转发任务').waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/api/orders/101/emails/synthetic-mail/forward-batch');
    assert.deepEqual(writes[0].body.recipients, ['one@example.test']);
    assert.equal(typeof writes[0].body.idempotencyKey, 'string');
    assert.deepEqual(errors, []);
    process.stdout.write('PASS: 320/390/768/1440px 订单列表、手机筛选与邮件联系人选择\n');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
