/* eslint-env node, browser */
/* eslint-disable no-magic-numbers -- 合成资源及桌面、平板、手机边界。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const origin = process.env.CAPABILITIES_BROWSER_URL || 'http://127.0.0.1:5197';
const output = process.env.CAPABILITIES_BROWSER_OUTPUT || '/tmp/apple-production-capabilities';

/** 真实操作日志页合成 API，覆盖排序、搜索、标签草稿、写权限与响应式边界。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  try {
    for (const width of [320, 390, 768, 1440, 1920]) {
      let readOnly = false;
      const calls = [];
      const errors = [];
      const devices = [13, 10, 2, 1].map(number => ({
        id: `11111111-1111-4111-8111-${String(number).padStart(12, '0')}`,
        name: `US Server No.${number}`,
        enabled: true,
        tag: number === 1 ? '上海 南宁' : '',
        tagVersion: 1,
      }));
      const device = devices.at(-1);
      const instance = {
        deviceId: device.id,
        localId: '22222222-2222-4222-8222-222222222222',
        label: '1号实例',
        tag: '上海测试',
        tagVersion: 1,
        active: true,
      };
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-capabilities'));
      await context.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/'))
          return url.origin === origin ? route.continue() : route.abort();
        let data = {};
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            role: 'operator',
            username: '合成日志验收',
            availableHome: '/server-monitor/logs',
            permissions: readOnly ? ['monitor.logs.read'] : ['monitor.logs.read', 'monitor.manage'],
          };
        else if (url.pathname.endsWith('/logs/states')) data = { devices, instances: [instance] };
        else if (url.pathname.endsWith('/logs/accounts')) data = { items: [], nextCursor: null };
        else if (url.pathname.endsWith('/logs/tags')) {
          assert.equal(request.method(), 'PUT');
          assert.equal(readOnly, false);
          const body = request.postDataJSON();
          calls.push(body);
          assert.equal(body.expectedVersion, device.tagVersion);
          device.tag = body.tag;
          device.tagVersion += 1;
          data = { ...body, tagVersion: device.tagVersion };
        } else if (url.pathname.endsWith('/logs')) {
          calls.push(Object.fromEntries(url.searchParams));
          data = { items: [], nextCursor: null };
        }
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      await page.goto(origin + '/server-monitor/logs');
      const panel = page.getByRole('region', { name: '完整日志查询', exact: true });
      const server = panel.getByRole('button', { name: '服务器', exact: true });
      await server.click();
      const list = panel.getByRole('listbox', { name: '服务器', exact: true });
      const names = await list.getByRole('option').allTextContents();
      assert(names[0].includes('No.1'));
      assert(names[1].includes('No.2'));
      assert(names[2].includes('No.10'));
      assert.equal(
        await list.getByRole('option', { name: '请选择服务器', exact: true }).count(),
        0
      );
      const search = panel.getByRole('combobox', { name: '搜索服务器', exact: true });
      await search.fill('上海');
      assert.equal(await list.getByRole('option').count(), 1);
      await search.press('ArrowDown');
      await search.press('Enter');
      await panel.getByRole('button', { name: '软件实例', exact: true }).click();
      const queried = page.waitForResponse(
        response => new URL(response.url()).pathname === '/api/server-monitor/logs'
      );
      await panel.getByRole('option', { name: '1号实例 · 上海测试', exact: true }).click();
      await queried;
      const query = calls.find(value => value.localId === instance.localId);
      assert(query?.startAt && query?.endAt, '仍使用跨天范围协议');
      const trigger = panel.getByRole('button', { name: '标签管理', exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '标签管理', exact: true });
      const input = dialog.getByRole('textbox', { name: device.name + '标签', exact: true });
      await input.fill('上海新标签');
      const focusStyle = await input.evaluate(node => {
        const style = getComputedStyle(node);
        return { focused: node === document.activeElement,
          focusVisible: node.matches(':focus-visible'),
          outline: style.outlineColor,
          outlineStyle: style.outlineStyle, border: style.borderColor, shadow: style.boxShadow };
      });
      await page.screenshot({ path: path.join(output, `标签弹窗-${width}.png`) });
      const rect = await dialog.boundingBox();
      assert(rect.x >= 0 && rect.x + rect.width <= width + 1);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert(await trigger.evaluate(node => node === document.activeElement));
      await trigger.click();
      assert.equal(await input.inputValue(), '上海新标签');
      await input
        .locator('xpath=ancestor::tr')
        .getByRole('button', { name: '保存', exact: true })
        .click();
      await dialog.getByText('已保存', { exact: true }).waitFor();
      assert.equal(calls.at(-1).tag, '上海新标签');
      await dialog.getByRole('button', { name: '关闭标签管理' }).click();
      await panel.getByRole('button', { name: '收起筛选', exact: true }).click();
      await panel.getByRole('button', { name: '展开筛选', exact: true }).click();
      assert((await server.textContent()).includes('上海新标签'));
      await page.screenshot({ path: path.join(output, `日志页-${width}.png`), fullPage: true });
      readOnly = true;
      await page.reload();
      await server.waitFor();
      assert.equal(await panel.getByRole('button', { name: '标签管理', exact: true }).count(), 0);
      assert.equal(
        await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth),
        true
      );
      assert.deepEqual(errors, []);
      results.push({
        width,
        passed: true,
        sortSearch: true,
        draftFocus: true,
        tagWriteAndReadOnly: true,
        focusStyle,
      });
      await context.close();
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
    process.stdout.write('日志选择器、标签弹窗、权限及五屏宽回归通过\n');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
