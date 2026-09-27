/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成响应遵循订单 API 契约 */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

/** 用合成订单和联系人验证手机订单列表与邮件选择，不访问业务 API。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(() => {
      if (window.top === window) localStorage.setItem('token', 'synthetic-orders-mobile');
    });
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    const listQueries = [];
    let displayedStatus = 'payment_timeout';
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
      else if (url.pathname === '/api/orders') {
        listQueries.push(url.searchParams.get('displayOrderStatuses'));
        data = {
          total: 1,
          orders: [
            {
              id: 101,
              order_number: 'W1234567890',
              serial_numbers: ['F12345678901234567890'],
              email_order_status:
                displayedStatus === 'payment_timeout' ? 'confirmed' : displayedStatus,
              email_payment_status: 'unknown',
              display_order_status: displayedStatus,
              products: [{ name: 'iPhone 18 Pro Max 256GB', quantity: 1 }],
              recipient_name: '合成取机人',
              recipient_tag: '北京 测试团队',
              order_date: '2026-09-23T02:00:00Z',
              email_pickup_info: {
                storeName: 'Apple 长沙国金中心',
                pickupDate: '2026-09-25',
                startTime: '18:30',
                endTime: '18:45',
                appointmentMode: 'fixed',
              },
            },
          ],
        };
      } else if (url.pathname === '/api/orders/101/emails')
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
        data = {
          id: 'synthetic-mail',
          subject: '合成订单邮件',
          text: '合成纯文本正文',
          html: '<html><body><h1 id="mail-title">合成排版正文</h1><img alt="内嵌商品图" data-order-mail-inline-index="0"><img alt="远程商品图" data-order-mail-remote-src="https://images.example.test/phone.png"></body></html>',
          remoteImageCount: 1,
          inlineAttachmentIndexes: [0],
          attachments: [{ index: 0, name: 'inline.png', size: 68, contentType: 'image/png' }],
        };
      else if (url.pathname === '/api/orders/101/emails/synthetic-mail/attachments/0')
        return await route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            [
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk',
              '+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            ].join(''),
            'base64'
          ),
        });
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
        await page.locator('.orders-mobile-list').getByText('付款超时', { exact: true }).waitFor();
        assert.equal(
          await page.locator('.orders-mobile-list').getByText('F12345678901234567890').count(),
          0
        );
        await page.locator('.orders-mobile-list').getByText('Apple 长沙国金中心').waitFor();
        await page.locator('.orders-mobile-list').getByText('2026-09-25 18:30–18:45').waitFor();
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
          await page
            .locator('.order-detail-modal')
            .getByText('付款超时', { exact: true })
            .waitFor();
          await page.locator('.order-detail-modal').getByText('F12345678901234567890').waitFor();
          await page.getByRole('button', { name: '关闭订单详情' }).click();
        }
        if (width === 390)
          await page.screenshot({ path: '/tmp/apple-orders-mobile-390.png', fullPage: true });
      } else {
        assert.equal(await page.locator('table thead').first().isVisible(), true);
        await page.locator('table tbody').first().getByText('付款超时', { exact: true }).waitFor();
      }
    }

    for (const [status, label] of [
      ['partially_cancelled', '部分取消'],
      ['expired', '已过期'],
      ['cancelled', '已取消'],
    ]) {
      displayedStatus = status;
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 720 });
        await page.goto('http://127.0.0.1:5173/orders');
        const list = page.locator(width < 768 ? '.orders-mobile-list' : 'table tbody').first();
        await list.getByText(label, { exact: true }).waitFor();
        await list.getByRole('button', { name: '查看', exact: true }).click();
        await page.locator('.order-detail-modal').getByText(label, { exact: true }).waitFor();
        await page.getByRole('button', { name: '关闭订单详情' }).click();
        if (width < 768) await page.getByRole('button', { name: /筛选条件.*展开/ }).click();
        await page.getByRole('button', { name: '订单状态筛选', exact: true }).click();
        await Promise.all([
          page.getByRole('option', { name: label, exact: true }).click(),
          page.waitForResponse(response => {
            const url = new URL(response.url());
            return (
              url.pathname === '/api/orders' &&
              url.searchParams.get('displayOrderStatuses') === JSON.stringify([status])
            );
          }),
        ]);
        assert(listQueries.includes(JSON.stringify([status])));
      }
    }

    await page.setViewportSize({ width: 390, height: 600 });
    await page.getByRole('button', { name: '订单邮件 W1234567890' }).click();
    await page.getByRole('button', { name: '查看邮件' }).click();
    const preview = page.frameLocator('iframe[title="邮件原始排版预览"]');
    await preview.locator('#mail-title').waitFor();
    await preview.getByAltText('内嵌商品图').waitFor();
    assert.match(
      await preview.getByAltText('内嵌商品图').getAttribute('src'),
      /^data:image\/png;base64,/
    );
    assert.equal(await preview.getByAltText('远程商品图').getAttribute('src'), null);
    await page.getByRole('button', { name: '加载远程图片（1）' }).click();
    await preview.getByAltText('远程商品图').waitFor();
    assert.equal(
      await preview.getByAltText('远程商品图').getAttribute('src'),
      'https://images.example.test/phone.png'
    );
    await page.screenshot({ path: '/tmp/apple-orders-mail-preview-390.png' });
    await page.getByRole('button', { name: '纯文本' }).click();
    await page.getByText('合成纯文本正文', { exact: true }).waitFor();
    await page.getByRole('button', { name: '原始排版' }).click();
    const search = page.getByRole('textbox', { name: '搜索转发联系人' });
    await search.click();
    const choices = page.getByRole('group', { name: '可选联系人' });
    await choices.getByRole('checkbox', { name: /联系人甲/ }).waitFor();
    assert.equal(await choices.isVisible(), true);
    await search.evaluate(input => input.blur());
    assert.equal(await choices.isVisible(), true, '搜索框失焦后联系人列表应保留供触摸选择');
    await page.screenshot({ path: '/tmp/apple-orders-mail-contacts-390.png' });
    await choices.getByRole('checkbox', { name: /联系人甲/ }).tap();
    await page.getByRole('button', { name: '移除 联系人甲' }).waitFor();
    await page.locator('.order-mail-forward h3').tap();
    assert.equal(await choices.isVisible(), false, '点击选择器外部应收起联系人列表');
    await search.focus();
    await choices.waitFor();
    await search.press('Escape');
    assert.equal(await choices.isVisible(), false, 'Escape 应收起联系人列表');
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
