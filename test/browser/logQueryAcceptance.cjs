/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const origin = process.env.LOG_QUERY_ORIGIN || 'http://127.0.0.1:5195';
const output = process.env.LOG_QUERY_OUTPUT || 'output/log-query-implementation/browser';
const sizes = [
  [1440, 900],
  [1265, 712],
  [768, 900],
  [390, 844],
  [375, 844],
];

/** 正式React页面＋隔离真实HTTP：不拦截成功查询，只按测试步骤注入网络故障。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const evidence = [];
  const errors = [];
  try {
    for (const [width, height] of sizes) {
      const context = await browser.newContext({
        viewport: { width, height },
        timezoneId: width === 768 ? 'America/Los_Angeles' : 'Asia/Shanghai',
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-log-manager'));
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      const requests = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/server-monitor/logs') requests.push(url.searchParams);
      });
      const screenshot = name =>
        page.screenshot({ path: `${output}/${width}-${name}.png`, animations: 'disabled' });
      const boundary = async locator => {
        const rect = await locator.boundingBox();
        assert.ok(
          rect &&
            rect.x >= -1 &&
            rect.y >= -1 &&
            rect.x + rect.width <= width + 1 &&
            rect.y + rect.height <= height + 1,
          `${width}:浮层超出视口 ${JSON.stringify(rect)}`
        );
      };
      await page.goto(origin + '/server-monitor/logs');
      await page.getByRole('button', { name: '服务器', exact: true }).click();
      await boundary(page.locator('.logs-query-page .monitor-resource-menu'));
      await screenshot('服务器下拉');
      await page.getByRole('option', { name: 'US01', exact: true }).click();
      await page.getByRole('button', { name: '软件实例', exact: true }).click();
      await page.getByRole('option', { name: 'AOS 实例 01', exact: true }).click();
      await page.getByRole('table', { name: '日志原文列表', exact: true }).waitFor();
      await page
        .getByRole('button', { name: '查询日志', exact: true })
        .waitFor({ state: 'visible' });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      );
      await screenshot('主页面');
      const serverRect = await page
        .getByRole('button', { name: '服务器', exact: true })
        .boundingBox();
      const queryRect = await page
        .getByRole('button', { name: '查询日志', exact: true })
        .boundingBox();
      if (width >= 1265)
        assert.equal(Math.round(serverRect.y), Math.round(queryRect.y), '默认桌面工具栏应单行');
      const queryCount = requests.length;
      await page.getByRole('button', { name: /^日志日期与时间：/ }).click();
      await boundary(page.getByRole('dialog', { name: '选择日志日期与时间', exact: true }));
      const start = page.getByRole('textbox', { name: '开始日期', exact: true });
      // 原生日期、时间控件没有统一textbox角色，按可访问名称定位。
      void start;
      const appliedDay = await page.getByLabel('结束日期', { exact: true }).inputValue();
      const endDay = new Date(Date.parse(appliedDay) - 7 * 86400000).toISOString().slice(0, 10);
      const firstDay = new Date(Date.parse(appliedDay) - 9 * 86400000).toISOString().slice(0, 10);
      await page.getByLabel('开始日期', { exact: true }).fill(firstDay);
      await page.getByLabel('开始时间', { exact: true }).fill('16:23:55');
      assert.equal(
        await page.getByLabel('结束日期', { exact: true }).inputValue(),
        appliedDay,
        '起端编辑串改终端'
      );
      await page.getByLabel('结束日期', { exact: true }).fill(endDay);
      await page.getByLabel('结束时间', { exact: true }).fill('12:23:20');
      await screenshot('日期时间成组');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: /^日志日期与时间：/ }).click();
      assert.equal(
        await page.getByLabel('开始日期', { exact: true }).inputValue(),
        appliedDay,
        '取消未恢复'
      );
      await page.getByLabel('开始时间', { exact: true }).fill('23:59:59');
      await page.getByLabel('结束时间', { exact: true }).fill('00:00:00');
      assert.equal(
        await page.getByRole('button', { name: '确定', exact: true }).isDisabled(),
        true
      );
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^日志日期与时间：/ }).click();
      await page.getByLabel('开始日期', { exact: true }).fill(firstDay);
      await page.getByLabel('开始时间', { exact: true }).fill('16:23:55');
      await page.getByLabel('结束日期', { exact: true }).fill(endDay);
      await page.getByLabel('结束时间', { exact: true }).fill('12:23:20');
      await page.getByRole('button', { name: '确定', exact: true }).click();
      assert.equal(requests.length, queryCount, '日期确定不应查询');
      await page.getByRole('button', { name: '查询日志', exact: true }).click();
      await page.waitForResponse(
        r => new URL(r.url()).pathname === '/api/server-monitor/logs' && r.status() === 200
      );
      await page.getByRole('table', { name: '日志原文列表', exact: true }).waitFor();
      assert.equal(requests.at(-1).get('startAt'), `${firstDay}T16:23:55`);
      assert.equal(requests.at(-1).get('endAt'), `${endDay}T12:23:20`);
      assert.equal(requests.at(-1).get('timeBasis'), 'loggedAt');
      await screenshot('跨日已应用');
      const mainViewport = page.getByRole('region', { name: '日志阅读区', exact: true });
      await mainViewport.evaluate(el => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForFunction(
        () => document.querySelector('[aria-label="日志原文列表"]').rows.length > 100
      );
      const firstId = await page
        .getByRole('button', { name: '选择第75条日志', exact: true })
        .getAttribute('aria-label');
      assert.ok(firstId);
      await page.getByRole('button', { name: '选择第75条日志', exact: true }).click();
      await page.getByRole('button', { name: '详情与上下文', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: '日志详情与上下文', exact: true });
      await page.getByRole('table', { name: '上下文日志列表', exact: true }).waitFor();
      await boundary(drawer);
      const region = page.getByRole('region', { name: '上下文日志阅读区', exact: true });
      const rect = await region.boundingBox();
      assert.ok(rect.height / height >= 0.8, `${width}:上下文正文占比 ${rect.height / height}`);
      assert.equal(await page.locator('.logs-context-source').getAttribute('open'), null);
      await screenshot('详情与上下文');
      await page.getByRole('button', { name: '整个实例上下文', exact: true }).click();
      await page.getByRole('table', { name: '上下文日志列表', exact: true }).waitFor();
      const anchorId = await page.locator('.logs-context-anchor').getAttribute('data-log-id');
      await page.getByRole('button', { name: '定位选中日志', exact: true }).click();
      await page.getByLabel('查看选中日志来源', { exact: true }).click();
      const beforeHeight = (await region.boundingBox()).height;
      assert.equal(beforeHeight, rect.height, '来源浮层不应挤正文');
      await screenshot('来源');
      await page.keyboard.press('Escape');
      assert.equal(await drawer.isVisible(), true, '一次Esc误关详情');
      await page.getByRole('button', { name: '复制选中原文', exact: true }).click();
      await page
        .locator('.logs-context-copy-notice')
        .getByText('日志已复制', { exact: true })
        .waitFor();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(copied.endsWith('\n'));
      assert.ok(!copied.includes('<mark'));
      await page.keyboard.press('Tab');
      assert.equal(
        await page.evaluate(() =>
          document.querySelector('.logs-context-drawer').contains(document.activeElement)
        ),
        true
      );
      await region.evaluate(el => {
        el.scrollTop = 100;
      });
      const visible = await region.evaluate(el => {
        const r = [...el.querySelectorAll('tr')].find(
          row => row.getBoundingClientRect().top >= el.getBoundingClientRect().top
        );
        return { id: r.dataset.logId, top: r.getBoundingClientRect().top };
      });
      const count = await page.locator('.logs-context-table tr').count();
      await page
        .getByRole('button', { name: '向上滑动加载更早上下文', exact: true })
        .evaluate(el => el.click());
      await page.waitForFunction(
        n => document.querySelectorAll('.logs-context-table tr').length > n,
        count
      );
      const afterTop = await page
        .locator(`[data-log-id="${visible.id}"]`)
        .evaluate(el => el.getBoundingClientRect().top);
      assert.ok(
        Math.abs(afterTop - visible.top) <= 1,
        `${width}:向前追加漂移 ${afterTop - visible.top}`
      );
      const ids = await page
        .locator('.logs-context-table tr')
        .evaluateAll(rows => rows.map(row => row.dataset.logId));
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(
        await page.locator('.logs-context-anchor').getAttribute('data-log-id'),
        anchorId
      );
      await page.keyboard.press('Escape');
      assert.equal(
        await page
          .getByRole('button', { name: '详情与上下文', exact: true })
          .evaluate(el => el === document.activeElement),
        true
      );
      await page.getByRole('button', { name: '专注阅读', exact: true }).click();
      await screenshot('专注阅读');
      await page.getByRole('button', { name: '详情与上下文', exact: true }).click();
      await page.getByRole('table', { name: '上下文日志列表', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(
        await page.getByRole('dialog', { name: '专注日志阅读', exact: true }).isVisible(),
        true
      );
      await page.keyboard.press('Escape');
      assert.equal(
        await page.getByRole('button', { name: '专注阅读', exact: true }).isVisible(),
        true
      );
      await page.getByRole('button', { name: '更多筛选', exact: true }).click();
      await page.getByRole('checkbox', { name: '仅查看未识别账号的日志', exact: true }).check();
      await screenshot('更多筛选');
      await page.getByRole('button', { name: '完成', exact: true }).click();
      assert.equal(
        await page.getByRole('combobox', { name: '账号编号', exact: true }).isDisabled(),
        true
      );
      await page.getByRole('button', { name: '重置条件', exact: true }).click();
      await page.getByRole('table', { name: '日志原文列表', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('combobox', { name: '账号编号', exact: true }).isEnabled(),
        true
      );
      await page.getByRole('button', { name: '标签管理', exact: true }).click();
      await screenshot('标签管理');
      await page.getByRole('button', { name: '关闭标签管理', exact: true }).click();
      assert.equal(
        await page.evaluate(() => Boolean(window.LOG_EXECUTED)),
        false,
        '日志HTML被执行'
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      );
      evidence.push({
        width,
        height,
        timezone: width === 768 ? 'America/Los_Angeles' : 'Asia/Shanghai',
        toolbarSingleRow: width >= 1265,
        contextRatio: rect.height / height,
        prependDrift: afterTop - visible.top,
        requests: requests.length,
      });
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      `${output}/results.json`,
      JSON.stringify({ passed: true, evidence, errors }, null, 2)
    );
  } finally {
    await browser.close();
  }
}
main().catch(e => {
  process.stderr.write(e.stack + '\n');
  process.exitCode = 1;
});
