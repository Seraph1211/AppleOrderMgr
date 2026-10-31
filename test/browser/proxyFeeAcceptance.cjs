/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const fixtureFactory = require('./fixtures/proxyOrdersUiFixture.cjs');
const origin = process.env.PROXY_UI_ORIGIN || 'http://127.0.0.1:5191';
const output = process.env.PROXY_FEE_OUTPUT || 'output/proxy-ui/2026-10-31/费用录入/浏览器';

/** 验证金额实际进入写请求、错误保留、列表详情回读与再次编辑；所有数据均为合成。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [1440, 768, 390, 320]) {
      const fixture = fixtureFactory();
      const errors = [];
      let failNextSave = false;
      let conflictNextSave = false;
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-fee-test'));
      await context.route('**/*', async route => {
        try {
          const request = route.request();
          const url = new URL(request.url());
          if (!url.pathname.startsWith('/api/'))
            return url.origin === origin ? await route.continue() : await route.abort();
          if (conflictNextSave && request.method() === 'PUT') {
            conflictNextSave = false;
            return await route.fulfill({
              status: 409,
              json: { error: { message: '合成版本冲突，请核对最新资料' } },
            });
          }
          if (failNextSave && request.method() === 'PUT') {
            failNextSave = false;
            return await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: '合成费用保存失败，请重试' } }),
            });
          }
          const data = fixture.handle(request.method(), url, request.postDataJSON() || {});
          return await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data }),
          });
        } catch (error) {
          errors.push(error.message);
          return route.abort();
        }
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/proxy-orders');
      const customer = '#2101 · 陈晓';
      await page.getByRole('button', { name: customer, exact: true }).click();
      await page.getByRole('button', { name: '编辑资料', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '编辑代抢 #2101', exact: true });
      let fee = dialog.getByRole('textbox', { name: '代抢费用（元）', exact: true });
      assert.equal(await fee.inputValue(), '120.00');
      await fee.fill('1.005');
      assert.equal(await fee.getAttribute('aria-invalid'), 'true');
      assert.equal(
        await dialog.getByRole('button', { name: '确认保存', exact: true }).isEnabled(),
        false
      );
      assert.equal(
        fixture.calls.some(call => call.method === 'PUT'),
        false
      );
      await fee.fill('137.25');
      await dialog.getByLabel('数量', { exact: true }).fill('2');
      if (width < 768) {
        await page.setViewportSize({ width, height: 440 });
        await fee.focus();
        await fee.scrollIntoViewIfNeeded();
        const save = await dialog
          .getByRole('button', { name: '确认保存', exact: true })
          .boundingBox();
        const field = await fee.boundingBox();
        assert.ok(save.y >= 0 && save.y + save.height <= 440);
        assert.ok(field.y >= 0 && field.y + field.height <= save.y);
        await page.screenshot({ path: `${output}/键盘近似视口-${width}.png` });
        await page.setViewportSize({ width, height: 900 });
      }
      await fee.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/编辑费用-${width}.png` });
      failNextSave = true;
      await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
      await dialog.getByText('合成费用保存失败，请重试', { exact: true }).waitFor();
      assert.equal(await fee.inputValue(), '137.25');
      conflictNextSave = true;
      await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
      await dialog.getByText('合成版本冲突，请核对最新资料', { exact: true }).waitFor();
      assert.equal(await fee.inputValue(), '137.25');
      assert.equal(rowFee(fixture), '120.00');
      await fee.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/费用版本冲突-${width}.png` });
      await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      const row = page.locator('tbody tr').filter({ hasText: customer });
      await row.getByRole('button', { name: customer, exact: true }).waitFor();
      assert.equal(await row.locator('.proxy-fee-value:visible').innerText(), '¥137.25');
      assert.equal(fixture.calls.find(call => call.method === 'PUT').body.proxyFee, '137.25');
      await page.getByRole('button', { name: customer, exact: true }).click();
      dialog = page.getByRole('dialog', { name: '代抢 #2101 · 陈晓', exact: true });
      await dialog.getByText('¥137.25', { exact: true }).waitFor();
      await page.screenshot({ path: `${output}/费用详情-${width}.png` });
      for (const [value, expected] of [
        ['0', '¥0.00'],
        ['', '未登记'],
      ]) {
        await dialog.getByRole('button', { name: '编辑资料', exact: true }).click();
        const edit = page.getByRole('dialog', { name: '编辑代抢 #2101', exact: true });
        await edit.getByRole('textbox', { name: '代抢费用（元）', exact: true }).fill(value);
        await edit.getByRole('button', { name: '确认保存', exact: true }).click();
        await edit.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: customer, exact: true }).click();
        await dialog.getByText(expected, { exact: true }).waitFor();
      }
      await dialog.getByRole('button', { name: '编辑资料', exact: true }).click();
      assert.equal(
        await page.getByRole('textbox', { name: '代抢费用（元）', exact: true }).inputValue(),
        ''
      );
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '登记代抢', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '登记代抢订单', exact: true });
      await dialog
        .getByLabel('客户抢购信息')
        .fill(
          '姓名：合成\n身份证后四位：0123\n手机号：13800000009\n邮箱：synthetic9@example.test\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼'
        );
      await dialog.getByRole('button', { name: '识别并预览', exact: true }).click();
      fee = dialog.getByRole('textbox', { name: '代抢费用（元）', exact: true });
      assert.equal(await fee.inputValue(), '');
      await fee.fill('88.80');
      await fee.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/登记费用-${width}.png` });
      await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.reload();
      const newCustomer = page.getByRole('button', { name: '#2208 · 合成', exact: true });
      await newCustomer.click();
      await page.getByRole('dialog').getByText('¥88.80', { exact: true }).waitFor();
      assert.equal(
        fixture.calls.find(call => call.path === '/proxy-orders' && call.method === 'POST').body
          .proxyFee,
        '88.80'
      );
      assert.deepEqual(errors, []);
      process.stdout.write(`PASS ${width}px 登记/编辑/失败保留/0/清空/重新打开与列表详情一致\n`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
/** 独立读取夹具服务端值，确认失败请求没有乐观覆盖。 */
function rowFee(fixture) {
  return fixture.handle('GET', new URL(`${origin}/api/proxy-orders/2101`)).proxyFee;
}
main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
