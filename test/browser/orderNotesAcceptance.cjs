/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成数据遵循 API 契约 */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

/** 合成 API 验证订单备注编辑，不访问真实业务数据。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-notes'));
    let notes = '原备注';
    let editable = true;
    let fail = false;
    let releaseSave;
    let holdSave = false;
    const writes = [];
    const errors = [];
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        let data;
        if (url.pathname === '/api/auth/me') {
          data = { id: 1, username: 'synthetic', role: 'operator', availableHome: '/orders',
            permissions: ['orders.read', ...(editable ? ['orders.edit'] : [])] };
        } else if (url.pathname === '/api/orders/filter-options') {
          data = { productOptions: [], recipientTags: [], stores: [] };
        } else if (url.pathname === '/api/orders') {
          data = { total: 1, orders: [{ id: 101, order_number: 'W1234567890', notes,
            products: [], created_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:00:00Z' }] };
        } else if (url.pathname === '/api/orders/101' && route.request().method() === 'PUT') {
          const body = route.request().postDataJSON();
          writes.push(body);
          assert.deepEqual(Object.keys(body), ['notes']);
          if (holdSave) await new Promise(resolve => { releaseSave = resolve; });
          if (fail) {
            await route.fulfill({ status: 400, json: { success: false, error: { message: '合成保存失败' } } });
            return;
          }
          notes = body.notes.trim() || null;
          data = { id: 101, notes, updated_at: '2026-10-08T01:00:00Z' };
        } else if (url.pathname === '/api/orders/101' || url.pathname === '/api/orders/101/link') {
          data = { id: 101, notes };
        } else {
          errors.push(`意外 API: ${url.pathname}`);
          await route.abort();
          return;
        }
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    const edit = async () => {
      if (!(await page.getByRole('button', { name: '关闭订单详情', exact: true }).isVisible())) {
        await page.getByRole('button', { name: '查看', exact: true }).filter({ visible: true }).click();
      }
      await page.getByRole('button', { name: '修改备注', exact: true }).click();
    };
    const input = () => page.getByRole('textbox', { name: '订单备注', exact: true });
    const save = () => page.getByRole('button', { name: '保存备注', exact: true });
    const waitClosed = () => page.getByRole('dialog').waitFor({ state: 'hidden' });
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 780 });
      await page.goto('http://127.0.0.1:5173/orders');
      await edit();
      assert.equal(await input().inputValue(), notes || '');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await input().fill(`宽度 ${width}\n第二行`);
      await save().click();
      await waitClosed();
      await page.reload();
      await edit();
      assert.equal(await input().inputValue(), `宽度 ${width}\n第二行`);
      await page.getByRole('button', { name: '取消', exact: true }).click();
    }
    await page.getByRole('button', { name: '关闭订单详情', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '修改备注 W1234567890', exact: true }).count(), 0);
    await page.getByRole('button', { name: '列设置', exact: true }).click();
    await page.locator('[draggable]').filter({ has: page.getByText('备注', { exact: true }) }).getByRole('checkbox').check();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    // 桌面备注列同样可编辑；取消不写入。
    await page.getByRole('button', { name: '编辑备注 W1234567890', exact: true }).click();
    const beforeCancel = writes.length;
    await input().fill('取消的草稿');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(writes.length, beforeCancel);
    await edit();
    assert.equal(await input().inputValue(), notes);
    fail = true;
    await input().fill('失败后保留');
    await save().click();
    await page.getByRole('alert').waitFor();
    assert.equal(await input().inputValue(), '失败后保留');
    fail = false;
    holdSave = true;
    await save().click();
    await page.waitForFunction(() => document.querySelector('textarea')?.disabled);
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').isVisible(), true);
    await page.waitForTimeout(100);
    assert(releaseSave);
    releaseSave();
    await waitClosed();
    holdSave = false;
    await edit();
    await input().fill('');
    await save().click();
    await waitClosed();
    assert.equal(notes, null);
    await page.reload();
    await edit();
    assert.equal(await input().inputValue(), '');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    // 字面连字符不能当作空值丢失。
    notes = '-';
    await page.reload();
    await edit();
    assert.equal(await input().inputValue(), '-');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    editable = false;
    await page.reload();
    await page.getByRole('heading', { name: '订单管理' }).waitFor();
    await page.getByText('订单 ID：101', { exact: true }).filter({ visible: true }).waitFor();
    await page.getByRole('button', { name: '查看', exact: true }).filter({ visible: true }).click();
    assert.equal(await page.getByRole('button', { name: /修改备注|编辑备注/ }).count(), 0);
    assert.deepEqual(errors, []);
    process.stdout.write('订单备注合成浏览器验收通过：3 种宽度、保存/清空/取消/失败/只读权限\n');
  } finally {
    await browser.close();
  }
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
