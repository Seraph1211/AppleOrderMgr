/* global localStorage, document, navigator, window */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const logger = require('../src/utils/logger');
const logPolicy = require('../src/services/monitorLogPolicy');
/** 合成浏览器验收，拦截所有API，不访问业务数据。 */
async function main() {
  let browser;
  try {
    if (!process.env.MONITOR_BROWSER_EXECUTABLE) throw new Error('需要专用浏览器可执行文件');
    browser = await chromium.launch({
      executablePath: process.env.MONITOR_BROWSER_EXECUTABLE,
      headless: true,
    });
    fs.mkdirSync(path.resolve('coverage'), { recursive: true });
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 375, height: 740 } : { width: 1440, height: 1000 },
        isMobile: mobile,
        hasTouch: mobile,
        serviceWorkers: 'block',
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      let fail = false;
      let empty = false;
      let allowed = true;
      const deviceId = '11111111-1111-4111-8111-111111111111';
      const localId = '22222222-2222-4222-8222-222222222222';
      const otherId = '33333333-3333-4333-8333-333333333333';
      const now = new Date().toISOString();
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const message =
        '2026-09-29 01:40:10.229 [2][128]A47-没有有货的店铺 <script>window.logInjected=true</script>\n';
      const row = {
        id: '44444444-4444-4444-8444-444444444444',
        deviceId,
        localId,
        fileId: '55555555-5555-4555-8555-555555555555',
        fileName: 'Log20260929_123.txt',
        loggedAt: now,
        lineNumber: '1',
        partIndex: 0,
        accountNumber: '128',
        message,
        parseState: 'parsed',
      };
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === 'http://127.0.0.1:5173') await route.continue();
            else await route.abort();
            return;
          }
          let data;
          if (url.pathname === '/api/auth/me')
            data = {
              id: 9,
              username: 'log-browser-test',
              role: 'operator',
              permissions: allowed ? ['monitor.manage'] : [],
              availableHome: allowed ? '/server-monitor' : '/profile',
            };
          else if (url.pathname === '/api/server-monitor/overview')
            data = {
              devices: [],
              instances: [],
              rules: [],
              notificationSettings: { enabled: false, recipients: [], smtp: {} },
            };
          else if (url.pathname === '/api/server-monitor/traffic') data = { rows: [] };
          else if (url.pathname === '/api/server-monitor/logs/states')
            data = {
              devices: [{ id: deviceId, name: '测试服务器01', enabled: true }],
              instances: [localId, otherId].map((id, index) => ({
                deviceId,
                localId: id,
                label: `软件实例${index + 1}`,
                active: true,
                fresh: true,
                observedAt: now,
                snapshot: {
                  state: 'ready',
                  dates: [today],
                  fileCount: 2,
                  totalBytes: 1000,
                  scannedBytes: 1000,
                  pending: 0,
                  issues: 0,
                  expired: 0,
                },
              })),
            };
          else if (url.pathname.endsWith('/logs/accounts'))
            data = { items: ['128', '129'], nextCursor: null };
          else if (url.pathname.endsWith('/context'))
            data = {
              anchorId: row.id,
              items: [
                row,
                {
                  ...row,
                  id: 'context-other',
                  lineNumber: '2',
                  accountNumber: url.searchParams.get('scope') === 'instance' ? '129' : '128',
                  message: '上下文合成日志\n',
                },
              ],
            };
          else if (url.pathname === '/api/server-monitor/logs') {
            const query = Object.fromEntries(url.searchParams);
            assert.notEqual(query.cursor, '', '首页请求应省略空游标');
            logPolicy.query(query);
            if (fail) {
              await route.fulfill({
                status: 503,
                json: { success: false, error: { message: '合成日志读取失败' } },
              });
              return;
            }
            assert.equal(url.searchParams.get('deviceId'), deviceId);
            if (url.searchParams.get('localId') === otherId)
              data = {
                items: [{ ...row, id: 'other-instance', message: '实例二账号128独立日志\n' }],
                nextCursor: null,
              };
            else if (url.searchParams.get('cursor'))
              data = {
                items: [{ ...row, id: 'page-two', lineNumber: '51', message: '第二页完整日志\n' }],
                nextCursor: null,
              };
            else data = { items: empty ? [] : [row], nextCursor: empty ? null : 'synthetic-next' };
          } else throw new Error(`非预期API：${url.pathname}`);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-full-log-token'));
      await page.goto('http://127.0.0.1:5173/server-monitor');
      await page.getByRole('tab', { name: '日志查询', exact: true }).click();
      const panel = page.getByRole('region', { name: '完整日志查询', exact: true });
      await panel.getByLabel('服务器', { exact: true }).selectOption(deviceId);
      await panel.getByLabel('软件实例', { exact: true }).selectOption(localId);
      await panel.getByText(message.trim(), { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.logInjected), undefined);
      assert.match(
        await panel
          .locator('tbody tr')
          .first()
          .locator('td')
          .first()
          .locator('div')
          .first()
          .innerText(),
        /20\d{2}\//
      );
      await panel.getByRole('button', { name: '复制第1行第1段', exact: true }).click();
      await panel.getByText('日志已复制', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), message);
      await panel.getByRole('button', { name: '下一页', exact: true }).click();
      await panel.getByText('第二页完整日志', { exact: true }).waitFor();
      await panel.getByRole('button', { name: '上一页', exact: true }).click();
      await panel.getByRole('button', { name: '上下文', exact: true }).click();
      const detail = panel.getByRole('region', { name: '日志上下文', exact: true });
      await detail.getByText('上下文合成日志', { exact: true }).waitFor();
      await detail.getByRole('button', { name: '整个实例上下文', exact: true }).click();
      await detail.getByText('账号 129', { exact: true }).waitFor();
      await panel.getByLabel('账号编号', { exact: false }).fill('128');
      await panel.getByLabel('正文关键词', { exact: true }).fill('店铺');
      const request = page.waitForRequest(
        req =>
          req.url().includes('/api/server-monitor/logs?') &&
          req.url().includes('account=128') &&
          new URL(req.url()).searchParams.get('keyword') === '店铺'
      );
      await panel.getByRole('button', { name: '查询', exact: true }).click();
      await request;
      await panel.getByText(message.trim(), { exact: true }).waitFor();
      assert.equal(await detail.count(), 0);
      await panel.getByLabel('软件实例', { exact: true }).selectOption(otherId);
      await panel.getByText('实例二账号128独立日志', { exact: true }).waitFor();
      assert.equal(await panel.getByText(message.trim(), { exact: true }).count(), 0);
      await panel.getByLabel('软件实例', { exact: true }).selectOption(localId);
      await panel.getByText(message.trim(), { exact: true }).waitFor();
      fail = true;
      await panel.getByRole('button', { name: '刷新当前页', exact: true }).click();
      await panel.getByText('合成日志读取失败', { exact: false }).waitFor();
      assert.equal(await panel.getByText(message.trim(), { exact: true }).count(), 0);
      fail = false;
      empty = true;
      await panel.getByRole('button', { name: '重新查询', exact: true }).click();
      await panel.getByText('当前条件下没有已上传的日志', { exact: false }).waitFor();
      empty = false;
      await panel.getByRole('button', { name: '刷新当前页', exact: true }).click();
      await panel.getByText(message.trim(), { exact: true }).waitFor();
      await panel.scrollIntoViewIfNeeded();
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        '页面不应横向溢出'
      );
      if (mobile) {
        const scroll = panel.locator('.overflow-x-auto').first();
        await scroll.evaluate(element => {
          element.scrollLeft = element.scrollWidth;
        });
        await panel.getByRole('button', { name: '上下文', exact: true }).tap();
        await panel.getByRole('button', { name: '关闭日志上下文', exact: true }).tap();
      }
      await panel
        .locator('.overflow-x-auto')
        .first()
        .evaluate(element => {
          element.scrollLeft = 0;
        });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.resolve(`coverage/full-logs-${mobile ? 'mobile' : 'desktop'}.png`),
        fullPage: true,
        animations: 'disabled',
      });
      allowed = false;
      await page.reload();
      await page.getByText('日志查询', { exact: true }).waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      await context.close();
      logger.info('完整日志浏览器合成验收通过', { viewport: mobile ? '375触屏' : '1440桌面' });
    }
  } catch (error) {
    logger.error('完整日志浏览器合成验收失败', { message: error.message });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}
main();
