/* global localStorage */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

/** 独立浏览器和合成 API 验证邮件权限，不访问业务 API 或发送真实邮件。 */
async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
    });
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-email-permissions'));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    let permissions = [];
    let role = 'operator';
    let forwards = 0;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const summary = {
      id: 'synthetic-mail',
      subject: '合成订单邮件',
      from: 'sender@example.test',
      to: 'original@example.test',
      date: '2026-09-21T00:00:00Z',
      attachments: [],
      expired: false,
      lifecycle: {
        orderStatus: 'confirmed',
        authenticityStatus: 'verified',
        needsReview: true,
        reviewReasons: ['SYNTHETIC'],
        parsedAt: '2026-09-21T00:00:00Z',
      },
    };
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://127.0.0.1:5173') return await route.abort();
        if (!url.pathname.startsWith('/api/')) return await route.continue();
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 3,
            role,
            username: 'synthetic',
            permissions,
            availableHome: permissions.includes('orders.read') ? '/orders' : '/email-processing',
          };
        else if (url.pathname === '/api/system/auto-refresh') data = { isRunning: false };
        else if (url.pathname === '/api/orders/filter-options')
          data = { productNames: [], recipientTags: [], tags: [], payers: [] };
        else if (url.pathname === '/api/orders')
          data = {
            total: 1,
            orders: [
              {
                id: 1,
                order_number: 'W1234567890',
                status: 'pending',
                products: [{ name: '合成商品', quantity: 1 }],
                recipient_name: '合成取机人',
                recipient_tag: 'TEST',
                refresh: { freshness_status: 'fresh' },
              },
            ],
          };
        else if (url.pathname === '/api/orders/1/emails')
          data = { items: [summary], total: 1, page: 1, limit: 20, sync: { status: 'ready' } };
        else if (url.pathname.endsWith('/forwards')) data = [];
        else if (url.pathname.endsWith('/forward')) {
          forwards++;
          data = { id: 'delivery', status: 'accepted' };
        } else if (url.pathname === '/api/orders/1/emails/synthetic-mail')
          data = { ...summary, text: '合成邮件完整正文' };
        else if (url.pathname === '/api/email-processing/metrics')
          data = { counts: {}, worker: {} };
        else if (url.pathname === '/api/email-processing')
          data = {
            items: [{ id: 1, status: 'manual_review', email_subject: '合成收单邮件', version: 1 }],
            total: 1,
          };
        else if (url.pathname === '/api/email-processing/1')
          data = {
            id: 1,
            status: 'manual_review',
            raw_mime: '合成 MIME',
            manual_draft: { appleId: 'synthetic@example.test', orderNumber: 'W1234567890' },
            version: 1,
          };
        else {
          errors.push('unexpected API ' + url.pathname);
          return await route.fulfill({ status: 404, json: { success: false } });
        }
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    for (role of ['operator', 'readOnly']) {
      for (const mode of ['none', 'read', 'forward', 'manage']) {
        permissions = [
          'orders.read',
          ...(mode === 'manage'
            ? ['order_mail.manage']
            : mode === 'forward'
              ? ['order_mail.read', 'order_mail.forward']
              : mode === 'read'
                ? ['order_mail.read']
                : []),
        ];
        await page.goto('http://127.0.0.1:5173/orders');
        await page.getByText('W1234567890', { exact: true }).first().waitFor();
        const open = page.getByRole('button', { name: '订单邮件 W1234567890', exact: true });
        assert.equal(await open.count(), mode === 'none' ? 0 : 1);
        if (mode === 'none') continue;
        await open.click();
        await page.getByRole('button', { name: '查看邮件', exact: true }).click();
        await page.getByText('合成邮件完整正文', { exact: true }).waitFor();
        assert.equal(
          await page.getByRole('button', { name: '转发邮件', exact: true }).count(),
          ['forward', 'manage'].includes(mode) ? 1 : 0
        );
        assert.equal(
          await page.getByRole('button', { name: '重新解析', exact: true }).count(),
          mode === 'manage' ? 1 : 0
        );
        assert.equal(
          await page.getByRole('button', { name: '保存核定', exact: true }).count(),
          mode === 'manage' ? 1 : 0
        );
        if (mode === 'forward') {
          await page.getByLabel('目标邮箱').fill('destination@example.test');
          await page.getByRole('button', { name: '转发邮件', exact: true }).click();
          await page
            .getByText(/已提交/)
            .first()
            .waitFor();
        }
      }
      for (const mode of ['read', 'content', 'process']) {
        permissions = [
          'email.read',
          ...(mode === 'read' ? [] : ['email.content.read']),
          ...(mode === 'process' ? ['email.process'] : []),
        ];
        await page.goto('http://127.0.0.1:5173/email-processing');
        await page.getByText('合成收单邮件', { exact: true }).waitFor();
        assert.equal(
          await page.getByRole('button', { name: /批量重新解析/ }).count(),
          mode === 'process' ? 1 : 0
        );
        assert.equal(
          await page.getByRole('button', { name: '详情', exact: true }).count(),
          mode === 'read' ? 0 : 1
        );
        if (mode === 'read') continue;
        await page.getByRole('button', { name: '详情', exact: true }).click();
        await page.getByText('合成 MIME', { exact: true }).waitFor();
        assert.equal(
          await page.getByLabel('Apple ID', { exact: true }).evaluate(input => input.readOnly),
          mode !== 'process'
        );
        assert.equal(
          await page.getByRole('button', { name: '确认入库', exact: true }).count(),
          mode === 'process' ? 1 : 0
        );
      }
    }
    assert.equal(forwards, 2);
    assert.deepEqual(errors, []);
    process.stdout.write('PASS: 两种普通角色的查看、转发、管理兼容及收单权限分级；无真实发信\n');
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
