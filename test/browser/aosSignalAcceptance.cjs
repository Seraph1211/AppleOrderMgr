/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { DEFAULT_CONFIG } = require('../../src/services/inventoryPolicy');

/** 独立合成验收 AOS 开关的默认值、保存与 PC/H5 交互，不发送通知。 */
async function main() {
  const baseUrl = process.env.AOS_SIGNAL_BROWSER_BASE_URL;
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl || ''), '必须显式指定本机新工作树服务');
  const output = process.env.AOS_SIGNAL_BROWSER_OUTPUT || '/tmp/aos-signal-browser';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    ...(process.env.AOS_SIGNAL_BROWSER_EXECUTABLE
      ? { executablePath: process.env.AOS_SIGNAL_BROWSER_EXECUTABLE }
      : { channel: 'chrome' }),
    headless: true,
  });
  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 375, height: 667 },
    ]) {
      const context = await browser.newContext({
        viewport,
        isMobile: viewport.width === 375,
        hasTouch: viewport.width === 375,
        serviceWorkers: 'block',
      });
      const errors = [];
      const writes = [];
      let settings = {
        version: 1,
        config: { ...DEFAULT_CONFIG, enabled: false, notificationsEnabled: false },
        hasWebhook: true,
        webhookTested: true,
      };
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-aos-ui'));
      await context.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === baseUrl) await route.continue();
            else await route.abort();
            return;
          }
          let data;
          if (url.pathname === '/api/auth/me')
            data = { id: 9, username: '合成管理员', role: 'admin', permissions: [] };
          else if (url.pathname === '/api/inventory/settings') {
            if (route.request().method() === 'PUT') {
              const body = route.request().postDataJSON();
              writes.push(body);
              settings = { ...settings, version: settings.version + 1, config: body.config };
            }
            data = settings;
          } else if (url.pathname === '/api/inventory/catalog') data = { products: [], stores: [] };
          else if (url.pathname === '/api/inventory/scope')
            data = { products: [], stores: [], combinations: 0, enabled: false, state: 'disabled' };
          else if (url.pathname === '/api/inventory/health') data = { state: 'disabled' };
          else if (url.pathname === '/api/inventory/deliveries') data = { items: [], total: 0 };
          else throw new Error(`意外 API: ${url.pathname}`);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${baseUrl}/inventory-monitor/manage?tab=settings`);
        const signal = page.getByRole('checkbox', { name: '开启 AOS 放货提醒', exact: true });
        const inventory = page.getByRole('checkbox', { name: '开启自动库存通知（只提醒新事件）' });
        await signal.waitFor();
        assert.equal(await signal.isChecked(), false, '缺失旧配置字段必须默认关闭');
        assert.equal(await inventory.isChecked(), false);
        await signal.check();
        await page.getByRole('button', { name: '保存通知设置', exact: true }).click();
        await page.getByText('设置已保存', { exact: true }).waitFor();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].config.aosSignalsEnabled, true);
        assert.equal(writes[0].config.enabled, false, '开启信号不应连带开启采集');
        assert.equal(writes[0].config.notificationsEnabled, false, '开启信号不应连带开启库存通知');
        assert.equal(writes[0].webhook, undefined);
        await page.reload();
        await signal.waitFor();
        assert.equal(await signal.isChecked(), true, '重载应读取已保存状态');
        assert.equal(await inventory.isChecked(), false);
        const text = await page.locator('main').innerText();
        for (const fragment of ['Webhook', '静默', '三分钟', '不会重复计入', 'US01'])
          assert(text.includes(fragment), `缺少规则说明：${fragment}`);
        await signal.uncheck();
        await page.getByRole('button', { name: '保存通知设置', exact: true }).click();
        await page.getByText('设置已保存', { exact: true }).waitFor();
        assert.equal(writes.at(-1).config.aosSignalsEnabled, false);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        );
        await signal.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(output, `AOS配置-${viewport.width}.png`),
          fullPage: true,
        });
        assert.deepEqual(errors, []);
        process.stdout.write(
          `通过 ${viewport.width}px：默认关闭、独立启停、保存重载、说明及无横向溢出\n`
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
