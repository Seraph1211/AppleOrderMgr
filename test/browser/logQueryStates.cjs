/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const origin = process.env.LOG_QUERY_ORIGIN || 'http://127.0.0.1:5195';
const api = 'http://127.0.0.1:3095';
const output = 'output/log-query-implementation/states';

/** 真实标签事务／409回读，网络故障仅在浏览器传输层注入。 */
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  try {
    for (const width of [1440, 375]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-log-manager'));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      let failMain = false,
        failAccounts = false,
        failContext = false;
      let requestCount = 0;
      await page.route('**/api/server-monitor/logs**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/server-monitor/logs') requestCount++;
        if (
          (url.pathname === '/api/server-monitor/logs' && failMain) ||
          (url.pathname.endsWith('/accounts') && failAccounts) ||
          (url.pathname.endsWith('/context') && url.searchParams.has('direction') && failContext)
        )
          return route.fulfill({
            status: 503,
            json: {
              success: false,
              error: { code: 'FULL_LOG_TEMPORARY', message: '合成网络故障，请重试' },
            },
          });
        return route.continue();
      });
      await page.goto(origin + '/server-monitor/logs');
      await page.getByRole('button', { name: '服务器', exact: true }).click();
      await page.getByRole('combobox', { name: '搜索服务器', exact: true }).fill('US01');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: '软件实例', exact: true }).click();
      await page.getByRole('option', { name: 'AOS 实例 01', exact: true }).click();
      await page.getByRole('table', { name: '日志原文列表', exact: true }).waitFor();
      failAccounts = true;
      const account = page.getByRole('combobox', { name: '账号编号', exact: true });
      await account.fill('001');
      await page.getByText(/合成网络故障，请重试，可直接输入编号查询/).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '查询日志', exact: true }).click();
      await page.getByRole('table', { name: '日志原文列表', exact: true }).waitFor();
      assert.equal(await account.inputValue(), '001');
      const draftCount = requestCount;
      await page.getByRole('textbox', { name: '正文关键词', exact: true }).fill('尚未应用');
      await page.getByRole('button', { name: '重新查询日志，从头加载', exact: true }).click();
      await page.getByRole('table', { name: '日志原文列表', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('textbox', { name: '正文关键词', exact: true }).inputValue(),
        '尚未应用'
      );
      assert.ok(requestCount > draftCount);
      assert.ok(
        (await page.getByRole('table', { name: '日志原文列表', exact: true }).innerText()).includes(
          '继续监控'
        )
      );
      failMain = true;
      await page.getByRole('button', { name: '重新查询日志，从头加载', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '合成网络故障' }).waitFor();
      await page.screenshot({ path: `${output}/${width}-首次错误.png` });
      failMain = false;
      await page.getByRole('button', { name: '重新查询', exact: true }).click();
      await page.getByRole('table', { name: '日志原文列表', exact: true }).waitFor();
      const viewport = page.getByRole('region', { name: '日志阅读区', exact: true });
      failMain = true;
      await viewport.evaluate(el => {
        el.scrollTop = el.scrollHeight;
      });
      await page.getByRole('button', { name: '重试加载更多', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('table', { name: '日志原文列表', exact: true }).locator('tr').count(),
        100
      );
      failMain = false;
      await page.getByRole('button', { name: '重试加载更多', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('[aria-label="日志原文列表"]').rows.length > 100
      );
      await page.getByRole('button', { name: '选择第80条日志', exact: true }).click();
      await page.getByRole('button', { name: '详情与上下文', exact: true }).click();
      await page.getByRole('table', { name: '上下文日志列表', exact: true }).waitFor();
      const count = await page.locator('.logs-context-table tr').count();
      failContext = true;
      await page
        .getByRole('button', { name: '向下滑动加载更新上下文', exact: true })
        .evaluate(el => el.click());
      await page.getByRole('button', { name: '重试上下文', exact: true }).waitFor();
      assert.equal(await page.locator('.logs-context-table tr').count(), count);
      await page.screenshot({ path: `${output}/${width}-上下文追加错误.png` });
      failContext = false;
      await page.getByRole('button', { name: '重试上下文', exact: true }).scrollIntoViewIfNeeded();
      const contextScroll = await page
        .locator('.logs-context-viewport')
        .evaluate(el => el.scrollTop);
      await page.getByRole('button', { name: '重试上下文', exact: true }).click();
      await page.waitForFunction(
        n => document.querySelectorAll('.logs-context-table tr').length > n,
        count
      );
      assert.ok(
        Math.abs(
          (await page.locator('.logs-context-viewport').evaluate(el => el.scrollTop)) -
            contextScroll
        ) <= 1,
        '向后追加抢走阅读位置'
      );
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '重置条件', exact: true }).click();
      await page.getByRole('table', { name: '日志原文列表', exact: true }).waitFor();
      await page.getByRole('button', { name: '选择第3条日志', exact: true }).click();
      await page.getByRole('button', { name: '详情与上下文', exact: true }).click();
      await page.getByRole('table', { name: '上下文日志列表', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: '该账号上下文', exact: true }).isDisabled(),
        true
      );
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '标签管理', exact: true }).click();
      const input = page.getByRole('textbox', { name: 'US01标签', exact: true });
      const row = input.locator('xpath=ancestor::tr');
      await input.fill(`合成标签${width}`);
      await row.getByRole('button', { name: '保存', exact: true }).click();
      await row.getByText('已保存', { exact: true }).waitFor();
      const states = await (await fetch(api + '/api/server-monitor/logs/states')).json();
      const device = states.data.devices.find(item => item.name === 'US01');
      assert.equal(device.tag, `合成标签${width}`);
      await input.fill('保留我的未保存草稿');
      const conflict = await fetch(api + '/api/server-monitor/logs/tags', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: device.id,
          tag: '另一会话的合成标签',
          expectedVersion: device.tagVersion,
        }),
      });
      assert.equal(conflict.status, 200);
      await row.getByRole('button', { name: '保存', exact: true }).click();
      await row.getByRole('button', { name: '重新读取', exact: true }).waitFor();
      assert.equal(await input.inputValue(), '保留我的未保存草稿');
      await page.screenshot({ path: `${output}/${width}-标签409保留草稿.png` });
      await row.getByRole('button', { name: '重新读取', exact: true }).click();
      await row.getByText(/最新标签：另一会话/).waitFor();
      assert.equal(await input.inputValue(), '保留我的未保存草稿');
      await row.getByRole('button', { name: '保存', exact: true }).click();
      await row.getByText('已保存', { exact: true }).waitFor();
      await row.getByRole('button', { name: '清空', exact: true }).click();
      await row.getByText('已清空', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), '');
      await page.getByRole('button', { name: '关闭标签管理', exact: true }).click();
      await page.getByRole('button', { name: '软件实例', exact: true }).click();
      await page.getByRole('option', { name: /AOS 实例 02/ }).click();
      await page.getByText('当前条件下没有已上传的日志，请核对筛选条件和采集状态。').waitFor();
      await page.screenshot({ path: `${output}/${width}-空结果与已移除实例.png` });
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
      assert.deepEqual(errors, []);
      await context.close();
      results.push({
        width,
        realTagSave: true,
        conflictRetainsDraft: true,
        mainRetry: true,
        contextRetry: true,
        manualAccountOnError: true,
      });
    }
    const reader = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await reader.addInitScript(() => localStorage.setItem('token', 'synthetic-log-reader'));
    const page = await reader.newPage();
    await page.goto(origin + '/server-monitor/logs');
    await page.getByRole('heading', { name: '日志查询', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '标签管理', exact: true }).count(), 0);
    const catalog = await (await fetch(api + '/test/catalog')).json();
    const forbidden = await fetch(api + '/api/server-monitor/logs/tags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-log-reader' },
      body: JSON.stringify({ deviceId: catalog.deviceId, tag: '不应写入', expectedVersion: 0 }),
    });
    assert.equal(forbidden.status, 403);
    fs.writeFileSync(
      `${output}/results.json`,
      JSON.stringify({ passed: true, results, readerForbidden: true }, null, 2)
    );
    await reader.close();
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
