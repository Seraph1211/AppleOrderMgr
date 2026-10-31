/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const createFixture = require('./fixtures/proxyOrdersUiFixture.cjs');
const origin = process.env.PROXY_UI_ORIGIN || 'http://127.0.0.1:5191';
const output = process.env.PROXY_UI_OUTPUT || 'output/proxy-ui/2026-10-31/交互验收';

/** 验证代抢工作台、专属弹层、账号保护和跨路由样式隔离；API全部为本机合成响应。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const results = [];
  try {
    for (const width of [1920, 1440, 768, 390, 320]) {
      const fixture = createFixture();
      let listFailure = false;
      const errors = [];
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-proxy-ui');
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: text => {
              window.__proxyClipboard = text;
              return Promise.resolve();
            },
          },
        });
      });
      await context.route('**/*', async route => {
        try {
          const request = route.request(),
            url = new URL(request.url());
          if (!url.pathname.startsWith('/api/'))
            return url.origin === origin ? route.continue() : route.abort();
          if (listFailure && url.pathname === '/api/proxy-orders' && request.method() === 'GET')
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: '合成列表读取失败' } }),
            });
          const data = fixture.handle(request.method(), url, request.postDataJSON() || {});
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data }),
          });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      const shot = name => page.screenshot({ path: `${output}/${name}-${width}.png` });
      await page.goto(origin + '/proxy-orders');
      await page.getByRole('button', { name: '#2101 · 陈晓', exact: true }).waitFor();
      const measurements = await page.evaluate(() => ({
        pageWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        tableWidth: document.querySelector('.proxy-table-scroll').clientWidth,
        tableScrollWidth: document.querySelector('.proxy-table-scroll').scrollWidth,
        font: getComputedStyle(document.querySelector('tbody td')).fontSize,
        firstRowTop: document.querySelector('tbody tr').getBoundingClientRect().top,
        footerBottom: document.querySelector('.proxy-table-footer').getBoundingClientRect().bottom,
      }));
      assert.ok(measurements.scrollWidth <= width + 1, JSON.stringify(measurements));
      if (width >= 1440) {
        assert.equal(measurements.font, '12px');
        assert.ok(measurements.tableScrollWidth <= measurements.tableWidth + 1);
        assert.ok(measurements.footerBottom <= 901);
      }
      if (width <= 390) assert.ok(measurements.firstRowTop < 540);
      await shot('委托列表');
      const firstRow = page.locator('tbody tr').filter({ hasText: '#2101 · 陈晓' });
      assert.match(await firstRow.locator('[data-label="代抢费用"]').innerText(), /120\.00/);
      const freeRow = page.locator('tbody tr').filter({ hasText: '#2103 · 周宁' });
      assert.match(await freeRow.locator('[data-label="代抢费用"]').innerText(), /0\.00/);
      const missingFee = page.locator('tbody tr').filter({ hasText: '#2105 · 沈言' });
      assert.match(await missingFee.locator('[data-label="代抢费用"]').innerText(), /未登记/);
      await firstRow.getByRole('button', { name: '代抢 #2101 状态', exact: true }).click();
      const rowStatusList = page.getByRole('listbox', { name: '代抢 #2101 状态', exact: true });
      await rowStatusList.waitFor();
      assert.equal(
        await rowStatusList.evaluate(node => node.scrollHeight <= node.clientHeight),
        true
      );
      await shot('行内状态');
      await page.keyboard.press('Escape');
      const statusFilter = page.getByRole('button', { name: '状态筛选', exact: true });
      await statusFilter.click();
      const statusList = page.getByRole('listbox', { name: '状态筛选', exact: true });
      await statusList.waitFor();
      assert.equal(await statusList.evaluate(node => node.scrollHeight <= node.clientHeight), true);
      const menuBounds = await statusList.boundingBox();
      assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width + 1);
      assert.ok(menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 901);
      if (width >= 768) {
        await page.keyboard.press('End');
        assert.equal(
          await statusList.getAttribute('aria-activedescendant'),
          await statusList.getByRole('option').last().getAttribute('id')
        );
        await page.keyboard.press('Home');
        assert.equal(
          await statusList.getAttribute('aria-activedescendant'),
          await statusList.getByRole('option').first().getAttribute('id')
        );
      }
      await shot('状态筛选');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('listbox', { name: '状态筛选', exact: true }).count(), 0);
      assert.equal(await statusFilter.evaluate(node => node === document.activeElement), true);
      await statusFilter.click();
      await page.getByRole('option', { name: '抢购中', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2);
      await statusFilter.click();
      await page.getByRole('option', { name: '全部状态', exact: true }).click();
      await page.getByRole('button', { name: '#2101 · 陈晓', exact: true }).waitFor();
      if (width >= 768) {
        await statusFilter.click();
        await page.getByRole('textbox', { name: '搜索', exact: true }).click();
        assert.equal(await statusList.count(), 0);
      }
      await page.getByRole('checkbox', { name: '选择 2101', exact: true }).check();
      assert.match(await page.locator('.proxy-selection-count').innerText(), /已选 1/);
      await page.getByRole('button', { name: '复制选中（1）', exact: true }).click();
      await page.waitForFunction(() => window.__proxyClipboard?.includes('preview-2101'));
      assert.deepEqual(
        fixture.calls.find(call => call.path === '/proxy-orders/copy').body.ids,
        [2101]
      );
      await page.getByRole('button', { name: '#2101 · 陈晓', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '代抢 #2101 · 陈晓', exact: true });
      await dialog.getByRole('heading', { name: '委托概览', exact: true }).waitFor();
      assert.ok(await dialog.getByText('¥120.00', { exact: true }).count());
      assert.ok(await dialog.getByText('客户原始信息', { exact: true }).count());
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await shot('委托详情');
      await dialog.getByRole('button', { name: '关闭', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(
        await page.evaluate(() => !!document.activeElement.closest('.proxy-dialog')),
        true
      );
      await dialog.getByRole('button', { name: '删除订单', exact: true }).click();
      const nested = page.getByRole('dialog', { name: '删除代抢 #2101', exact: true });
      await nested.waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await nested.count(), 0);
      assert.equal(await dialog.count(), 1);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 0);
      assert.equal(
        await page.evaluate(() => document.activeElement.textContent.trim()),
        '#2101 · 陈晓'
      );
      await page.getByRole('button', { name: '登记代抢', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '登记代抢订单', exact: true });
      await dialog.getByRole('button', { name: '手工填写', exact: true }).click();
      await dialog.getByRole('heading', { name: '客户与委托', exact: true }).waitFor();
      await dialog.getByRole('button', { name: '添加候选商品', exact: true }).click();
      const productSelect = dialog.getByRole('button', { name: '候选商品 1', exact: true });
      await productSelect.click();
      await page.getByRole('textbox', { name: '搜索候选商品 1', exact: true }).fill('不存在的商品');
      await page.getByText('没有匹配的选项', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 1);
      const inputFont = await dialog
        .getByLabel('手机号', { exact: true })
        .evaluate(node => getComputedStyle(node).fontSize);
      if (width < 768) assert.equal(inputFont, '16px');
      await shot('委托登记');
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '专用 AppleID 池', exact: true }).click();
      await page.getByText('pickup1@example.test', { exact: true }).waitFor();
      await shot('专用账号池');
      const account = page.locator('tbody tr').filter({ hasText: 'pickup1@example.test' });
      const editBounds = await account
        .getByRole('button', { name: '编辑', exact: true })
        .boundingBox();
      const tableBounds = await page.locator('.proxy-table-scroll').boundingBox();
      assert.ok(editBounds.x >= tableBounds.x);
      assert.ok(editBounds.x + editBounds.width <= tableBounds.x + tableBounds.width + 1);
      await account.getByRole('button', { name: '编辑', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '编辑代抢账号', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getByText('候选商品', { exact: true }).count(), 0);
      await shot('账号编辑');
      await page.keyboard.press('Escape');
      await page.getByRole('checkbox', { name: '选择 101', exact: true }).check();
      await page.getByRole('button', { name: '批量修改状态（1）', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '批量修改账号状态（1）', exact: true });
      await dialog.waitFor();
      await shot('账号批量状态');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '粘贴导入', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '导入代抢 AppleID', exact: true });
      await dialog.waitFor();
      await shot('账号导入');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '代抢订单', exact: true }).click();
      await page.getByRole('button', { name: '#2101 · 陈晓', exact: true }).waitFor();
      await page.getByRole('textbox', { name: '搜索', exact: true }).fill('找不到的委托');
      await page.getByText('没有符合条件的记录', { exact: true }).waitFor();
      await page.getByRole('button', { name: '清空筛选', exact: true }).click();
      await page.getByRole('button', { name: '#2101 · 陈晓', exact: true }).waitFor();
      listFailure = true;
      await page.getByRole('button', { name: '刷新列表', exact: true }).click();
      await page.getByText('合成列表读取失败', { exact: true }).waitFor();
      assert.equal(await page.getByText('没有符合条件的记录', { exact: true }).count(), 0);
      listFailure = false;
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await page.getByRole('button', { name: '#2101 · 陈晓', exact: true }).waitFor();
      // 切到登录页后，本页根作用域和Portal消失，基础按钮/输入恢复原全局样式。
      await page.goto(origin + '/login');
      await page
        .getByRole('heading', { name: '代抢管理', exact: true })
        .waitFor({ state: 'detached' });
      assert.equal(await page.locator('.proxy-workspace, .proxy-dialog').count(), 0);
      assert.deepEqual(errors, []);
      results.push({ width, ...measurements, contractCalls: fixture.calls.length });
      await context.close();
    }
    fs.writeFileSync(`${output}/验收结果.json`, JSON.stringify(results, null, 2));
    process.stdout.write(
      `PASS: 代抢工作台五宽度、弹层/嵌套焦点、账号池、错误与范围隔离 ${JSON.stringify(results)}\n`
    );
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
