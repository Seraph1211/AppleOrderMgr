/* global localStorage, window, document */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const logger = require('../src/utils/logger');

/** 独立浏览器、全量合成 API 验证通讯录与多选转发，不发送真实邮件。 */
async function main() {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-mail-contacts'));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    let mode = 'admin';
    let fail = false;
    let contactFailure = false;
    let calls = [];
    let contacts = [
      { id: 1, name: '张三', email: 'zhang@example.test' },
      { id: 2, name: '李四', email: 'li@example.test' },
    ];
    let deliveries = [];
    const message = {
      id: 'a0000000-0000-4000-8000-000000000001',
      subject: '合成订单邮件',
      from: 'Apple',
      to: 'original@example.test',
      date: '2026-09-22T01:00:00Z',
      text: '合成邮件正文',
      attachments: [],
    };
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://127.0.0.1:5173') return await route.abort();
        if (mode === 'forward' && url.pathname === '/src/main.jsx') {
          return await route.fulfill({
            contentType: 'application/javascript',
            body: `
            import React from '/node_modules/.vite/deps/react.js';
            import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
            import { AuthProvider } from '/src/contexts/AuthContext.jsx';
            import OrderMailDrawer from '/src/components/OrderMailDrawer.jsx';
            import '/src/index.css';
            ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AuthProvider, null,
              React.createElement(OrderMailDrawer, {order: {id:1, orderNumber:'W1234567890'}, onClose: () => {}})));
          `,
          });
        }
        if (!url.pathname.startsWith('/api/')) return await route.continue();
        const method = route.request().method();
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: '合成验收',
            role: mode === 'admin' ? 'admin' : 'operator',
            permissions: ['orders.read', 'order_mail.read', 'order_mail.forward'],
            availableHome: '/profile',
          };
        else if (url.pathname.startsWith('/api/mail-contacts')) {
          if (contactFailure && method === 'GET')
            return await route.fulfill({
              status: 500,
              json: { error: { message: '合成联系人加载失败' } },
            });
          const id = Number(url.pathname.split('/').at(-1));
          if (method === 'GET') {
            const search = url.searchParams.get('search') || '';
            const items = contacts.filter(item => (item.name + item.email).includes(search));
            data = { items, total: items.length };
          } else if (method === 'POST') {
            data = { ...route.request().postDataJSON(), id: 3 };
            contacts.push(data);
          } else if (method === 'PUT') {
            data = { ...route.request().postDataJSON(), id };
            contacts = contacts.map(item => (item.id === id ? data : item));
          } else if (method === 'DELETE') {
            contacts = contacts.filter(item => item.id !== id);
            data = { id };
          } else throw new Error('Unexpected contacts method');
        } else if (url.pathname.endsWith('/forward-batch')) {
          const body = route.request().postDataJSON();
          calls.push(body);
          if (fail)
            return await route.fulfill({
              status: 500,
              json: { error: { message: '合成提交中断' } },
            });
          deliveries = body.recipients.map((recipient, index) => ({
            id: 'delivery-' + index,
            recipient,
            note: body.note,
            status: 'queued',
            createdAt: '2026-09-22T01:00:00Z',
          }));
          data = { items: deliveries };
        } else if (url.pathname.endsWith('/forwards')) data = deliveries;
        else if (url.pathname === '/api/orders/1/emails')
          data = { items: [message], page: 1, total: 1, limit: 20, sync: { status: 'ready' } };
        else if (url.pathname.endsWith(message.id)) data = message;
        else throw new Error('未配置合成接口 ' + url.pathname);
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('http://127.0.0.1:5173/mail-contacts');
    await page.getByRole('heading', { name: '邮件联系人', exact: true }).waitFor();
    await page.getByRole('cell', { name: '张三', exact: true }).waitFor();
    await page.getByRole('button', { name: '新增联系人' }).click();
    await page.getByLabel('联系人名', { exact: true }).fill('王五');
    await page.getByLabel('邮箱', { exact: true }).fill('wang@example.test');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('cell', { name: '王五', exact: true }).waitFor();
    let row = page
      .locator('tr')
      .filter({ has: page.getByRole('cell', { name: '王五', exact: true }) });
    await row.getByRole('button', { name: '编辑' }).click();
    await page.getByLabel('联系人名', { exact: true }).fill('王五修改');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    row = page
      .locator('tr')
      .filter({ has: page.getByRole('cell', { name: '王五修改', exact: true }) });
    await row.getByRole('button', { name: '删除' }).click();
    await page.getByRole('cell', { name: '王五修改', exact: true }).waitFor({ state: 'hidden' });
    await page.getByLabel('搜索联系人', { exact: true }).fill('nobody');
    await page.getByText('没有匹配的联系人', { exact: true }).waitFor();
    await page.getByLabel('搜索联系人', { exact: true }).fill('');
    await page.getByRole('cell', { name: '张三', exact: true }).waitFor();
    await page.screenshot({
      path: '/tmp/mail-contacts-desktop.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 375, height: 900 });
    await page.waitForFunction(
      () => document.querySelector('aside').getBoundingClientRect().right <= 0
    );
    await page.screenshot({
      path: '/tmp/mail-contacts-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true
    );
    mode = 'operator';
    await page.reload();
    await page.waitForURL('**/profile');
    assert.equal(await page.getByRole('link', { name: '邮件联系人', exact: true }).count(), 0);
    mode = 'forward';
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      calls = [];
      deliveries = [];
      contactFailure = false;
      await page.goto('http://127.0.0.1:5173/');
      await page.getByRole('button', { name: '查看邮件', exact: true }).click();
      assert.equal(await page.getByRole('group', { name: '可选联系人' }).count(), 0);
      await page.getByLabel('搜索转发联系人').click();
      const contactRow = page.getByRole('checkbox', { name: '张三 <zhang@example.test>' });
      await contactRow.getByText('张三 <zhang@example.test>', { exact: true }).click();
      assert.equal(await contactRow.getAttribute('aria-checked'), 'true');
      const rowBox = await contactRow.boundingBox();
      await contactRow.click({ position: { x: rowBox.width - 5, y: rowBox.height / 2 } });
      assert.equal(await contactRow.getAttribute('aria-checked'), 'false');
      await contactRow.locator('svg').click();
      assert.equal(await contactRow.getAttribute('aria-checked'), 'true');
      await contactRow.press('Space');
      assert.equal(await contactRow.getAttribute('aria-checked'), 'false');
      await contactRow.press('Enter');
      assert.equal(await contactRow.getAttribute('aria-checked'), 'true');
      await page.getByLabel('搜索转发联系人').press('Escape');
      assert.equal(await page.getByRole('group', { name: '可选联系人' }).count(), 0);
      assert.equal(await page.getByRole('dialog', { name: '订单邮件' }).count(), 1);
      await page.getByRole('button', { name: '展开联系人' }).click();
      await page.getByLabel('搜索转发联系人').fill('李四');
      await page.getByRole('checkbox', { name: '李四 <li@example.test>' }).check();
      await page.screenshot({
        path: '/tmp/mail-dropdown-' + width + '.png',
        fullPage: true,
        animations: 'disabled',
      });
      await page.getByLabel('手动添加邮箱（可选）').fill('zhang@example.test');
      assert.equal(await page.getByRole('group', { name: '可选联系人' }).count(), 0);
      await page.getByLabel('备注（可选）', { exact: true }).fill('测试备注');
      await page.screenshot({
        path: '/tmp/mail-forward-' + width + '.png',
        fullPage: true,
        animations: 'disabled',
      });
      fail = true;
      await page.getByRole('button', { name: '转发邮件', exact: true }).click();
      await page.getByRole('button', { name: '重试原请求', exact: true }).waitFor();
      assert.equal(await page.getByLabel('手动添加邮箱（可选）').isDisabled(), true);
      assert.equal(calls[0].recipients.length, 2);
      fail = false;
      await page.getByRole('button', { name: '重试原请求', exact: true }).click();
      await page.getByText('已提交 2 个转发任务', { exact: false }).waitFor();
      assert.deepEqual(calls[0], calls[1]);
      assert.equal(await page.getByRole('button', { name: /^移除 / }).count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true
      );
    }
    contactFailure = true;
    await page.reload();
    await page.getByRole('button', { name: '查看邮件', exact: true }).click();
    await page.getByLabel('搜索转发联系人').click();
    await page.getByRole('alert').filter({ hasText: '合成联系人加载失败' }).waitFor();
    contactFailure = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByRole('checkbox', { name: '张三 <zhang@example.test>' }).waitFor();
    await page.getByLabel('手动添加邮箱（可选）').fill('manual@example.test');
    await page.getByRole('button', { name: '转发邮件', exact: true }).click();
    await page.getByText('已提交 1 个转发任务', { exact: false }).waitFor();
    assert.deepEqual(calls.at(-1).recipients, ['manual@example.test']);
    assert.deepEqual(errors, []);
    logger.info('邮件联系人浏览器合成验收通过', {
      widths: [1440, 375],
      scenarios: 'CRUD、搜索、权限、跨搜索多选、去重、幂等重试、手动邮箱、加载失败重试',
    });
  } catch (error) {
    logger.error('邮件联系人浏览器验收失败', { error: error.message });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}
main();
