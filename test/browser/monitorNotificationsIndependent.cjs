/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const baseUrl = 'http://127.0.0.1:5188';
const backend = 'http://127.0.0.1:5194';
const eventId = '22222222-2222-4222-8222-222222222222';
const output = path.resolve(__dirname, '../../.tmp/monitor-notifications-independent/browser');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 专用临时Chrome + 本地前端 + 真实隔离PG/HTTP；全部非本机请求阻断。 */
async function main() {
  assert.equal(process.env.MONITOR_NOTIFICATIONS_INDEPENDENT, '1');
  fs.mkdirSync(output, { recursive: true });
  const report = {
    tests: [],
    requests: [],
    screenshots: [],
    boundaries: [
      '身份由合成fixture注入；真实权限中间件、通知路由、服务、审计与隔离PostgreSQL执行。',
      'visibilityState由测试事件模拟；未验证真实手机、真实用户登录、SMTP或企微收件。',
    ],
  };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const scenario of [
      { name: 'desktop-readonly', width: 1440, height: 900, mode: 'readonly' },
      { name: 'short-mobile-readonly', width: 375, height: 500, mode: 'readonly' },
      { name: 'invalid-event', width: 1440, height: 900, mode: 'readonly', invalid: true },
      { name: 'no-permission', width: 1440, height: 900, mode: 'none' },
      { name: 'desktop-edit', width: 1440, height: 900, mode: 'edit' },
    ]) {
      const context = await browser.newContext({
        viewport: {
          width: scenario.width,
          height: scenario.height,
        },
        serviceWorkers: 'block',
      });
      const requests = [];
      const errors = [];
      await context.route('**/*', async route => {
        try {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== baseUrl) return await route.abort();
          if (url.pathname === '/api/auth/me' && scenario.mode === 'none') {
            return await route.fulfill({
              json: {
                success: true,
                data: {
                  id: 1,
                  username: 'synthetic-no-permission',
                  role: 'operator',
                  permissions: [],
                },
              },
            });
          }
          if (url.pathname.startsWith('/api/server-monitor')) {
            const item = {
              scenario: scenario.name,
              method: request.method(),
              path: url.pathname,
              query: url.search,
              body: request.postDataJSON() || null,
            };
            requests.push(item);
            const response = await route.fetch({
              url: `${backend}${url.pathname}${url.search}`,
              headers: { ...request.headers(), 'x-independent-mode': scenario.mode },
            });
            item.status = response.status();
            await route.fulfill({ response });
            return;
          }
          await route.continue();
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      const query =
        `eventId=${scenario.invalid ? 'invalid-event-id' : eventId}` +
        (scenario.mode === 'readonly' ? '&readOnly=1' : '');
      await page.goto(`${baseUrl}/server-monitor?${query}`);
      if (scenario.mode === 'none') {
        await page.getByRole('heading', { name: '权限不足' }).waitFor();
        assert.equal(requests.length, 0, '权限不足不能请求通知接口');
        report.tests.push(`${scenario.name}: deep-link-permission-blocked`);
      } else {
        await page.getByRole('heading', { name: '通知投递记录' }).waitFor();
        await page.getByRole('heading', { name: '邮件通道', exact: true }).waitFor();
        if (scenario.invalid) {
          await page.getByRole('alert').filter({ hasText: '事件 ID 格式无效' }).waitFor();
          assert(!requests.some(item => item.path.endsWith('/deliveries')));
          report.tests.push(`${scenario.name}: invalid-id-no-delivery-request`);
        } else {
          assert.equal(await page.getByLabel('事件 ID', { exact: true }).inputValue(), eventId);
          await page.getByRole('row').filter({ hasText: 'SYNTHETIC_RESULT_UNKNOWN' }).waitFor();
          const filtered = requests.filter(item => item.path.endsWith('/deliveries'));
          assert(filtered.some(item => new URLSearchParams(item.query).get('eventId') === eventId));
          assert.equal(await page.locator('table').last().locator('tbody tr').count(), 2);
          report.tests.push(`${scenario.name}: actual-api-dual-channel-deep-link`);
          await page.getByRole('heading', { name: '通知投递记录' }).scrollIntoViewIfNeeded();
          await page
            .locator('table')
            .last()
            .locator('..')
            .evaluate(element => {
              element.scrollLeft = 0;
            });
          const historyScreenshot = path.join(output, `${scenario.name}-history-left.png`);
          await page.screenshot({ path: historyScreenshot, fullPage: false });
          report.screenshots.push(historyScreenshot);
          if (scenario.mode === 'readonly') {
            for (const button of await page
              .getByRole('button', { name: '保存此通道', exact: true })
              .all())
              assert(await button.isDisabled());
            assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 0);
            await page
              .getByRole('row')
              .filter({ hasText: 'SYNTHETIC_RESULT_UNKNOWN' })
              .getByRole('button', { name: '详情', exact: true })
              .click();
            await page.getByRole('region', { name: '投递详情' }).waitFor();
            assert.match(
              await page.getByRole('region', { name: '投递详情' }).innerText(),
              /双通道状态/
            );
            const detailScreenshot = path.join(output, `${scenario.name}-detail.png`);
            await page
              .getByRole('region', { name: '投递详情' })
              .screenshot({ path: detailScreenshot });
            report.screenshots.push(detailScreenshot);
            report.tests.push(`${scenario.name}: readonly-disabled-and-detail`);
          } else {
            const emailSection = page.locator('section').filter({
              has: page.getByRole('heading', { name: '邮件通道', exact: true }),
            });
            const input = emailSection.locator('textarea');
            const draft = 'draft-one@example.test\ndraft-two@example.test';
            await input.fill(draft);
            await sleep(200);
            const healthBefore = requests.filter(item => item.path.endsWith('/health')).length;
            await page.evaluate(() => {
              Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => 'hidden',
              });
              document.dispatchEvent(new Event('visibilitychange'));
            });
            await sleep(16000);
            assert.equal(
              requests.filter(item => item.path.endsWith('/health')).length,
              healthBefore
            );
            await page.evaluate(() => {
              Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => 'visible',
              });
              document.dispatchEvent(new Event('visibilitychange'));
            });
            await sleep(300);
            assert(requests.filter(item => item.path.endsWith('/health')).length > healthBefore);
            assert.equal(await input.inputValue(), draft);
            report.tests.push(`${scenario.name}: hidden-poll-paused-visible-refresh-draft-kept`);
            const saved = page.waitForResponse(
              response =>
                response.url().includes('/channels/email') && response.request().method() === 'PUT'
            );
            await emailSection.getByRole('button', { name: '保存此通道', exact: true }).click();
            assert.equal((await saved).status(), 200, '邮件表单必须被真实API接受');
            const write = requests.find(
              item => item.method === 'PUT' && item.path.endsWith('/email')
            );
            assert(!Object.hasOwn(write.body, 'policy'), '邮件保存不能携带企微policy');
            report.tests.push(`${scenario.name}: email-save-real-api-contract`);
            const current = await (
              await fetch(`${backend}/api/server-monitor/notifications/channels`)
            ).json();
            const email = current.data.channels.find(item => item.channel === 'email');
            const concurrent = await fetch(
              `${backend}/api/server-monitor/notifications/channels/email`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  expectedVersion: email.version,
                  enabled: email.enabled,
                  sendRecovery: email.sendRecovery,
                  recipients: ['concurrent@example.test'],
                }),
              }
            );
            assert.equal(concurrent.status, 200);
            await input.fill('conflict-draft@example.test');
            const conflict = page.waitForResponse(
              response =>
                response.url().includes('/channels/email') && response.request().method() === 'PUT'
            );
            await emailSection.getByRole('button', { name: '保存此通道', exact: true }).click();
            assert.equal((await conflict).status(), 409);
            await page.getByRole('alert').filter({ hasText: '草稿已保留' }).waitFor();
            assert.equal(await input.inputValue(), 'conflict-draft@example.test');
            report.tests.push(`${scenario.name}: actual-version-conflict-preserves-draft`);
            let dialogMessage = '';
            page.once('dialog', async dialog => {
              dialogMessage = dialog.message();
              await dialog.dismiss();
            });
            await page
              .getByRole('row')
              .filter({ hasText: 'SYNTHETIC_RESULT_UNKNOWN' })
              .getByRole('button', { name: '重试', exact: true })
              .click();
            assert.match(dialogMessage, /重复通知/);
            assert(!requests.some(item => item.path.endsWith('/retry')));
            report.tests.push(`${scenario.name}: unknown-retry-cancel-sends-no-write`);
          }
        }
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        );
        assert.equal(overflow, false, `${scenario.name} 页面不能横向溢出`);
        report.tests.push(`${scenario.name}: page-width-contained`);
      }
      const screenshot = path.join(output, `${scenario.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      report.screenshots.push(screenshot);
      assert.deepEqual(errors, []);
      report.requests.push(...requests);
      await context.close();
    }
    report.passed = report.tests.length;
    report.failed = 0;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ passed: report.passed, failed: 0, output }) + '\n');
  } catch (error) {
    fs.writeFileSync(
      path.join(output, 'failure.json'),
      JSON.stringify({ error: error.message, report }, null, 2)
    );
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  process.stderr.write(`独立浏览器验收失败：${error.stack}\n`);
  process.exitCode = 1;
});
