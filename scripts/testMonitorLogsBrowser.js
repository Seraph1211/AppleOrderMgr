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
    for (const mode of ['desktop', 'portrait', 'mobile']) {
      const mobile = mode === 'mobile';
      const context = await browser.newContext({
        viewport: mobile
          ? { width: 375, height: 740 }
          : mode === 'portrait'
            ? { width: 1080, height: 1920 }
            : { width: 1440, height: 1000 },
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
      let contextFail = false;
      let accountFail = false;
      let listRequests = 0;
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
      const firstPageItems = Array.from({ length: 100 }, (_, index) => ({
        ...row,
        id: index ? `log-${index}` : row.id,
        lineNumber: String(index + 1),
        message: index === 1 ? `${'长日志内容'.repeat(100)}\n第二行\n` : message,
      }));
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
          else if (url.pathname.endsWith('/logs/accounts')) {
            if (accountFail) {
              await route.fulfill({
                status: 503,
                json: { success: false, error: { message: '账号候选合成失败' } },
              });
              return;
            }
            const search = url.searchParams.get('search') || '';
            const values = url.searchParams.get('after')
              ? ['200', '201']
              : ['001', '002', '128', '129'];
            data = {
              items: values.filter(value => value.includes(search)),
              nextCursor: !search && !url.searchParams.get('after') ? '129' : null,
            };
          } else if (url.pathname.endsWith('/context')) {
            if (contextFail) {
              await route.fulfill({
                status: 503,
                json: { success: false, error: { message: '上下文合成失败' } },
              });
              return;
            }
            data = {
              anchorId: row.id,
              items: [
                row,
                {
                  ...row,
                  id: 'context-other',
                  lineNumber: '2',
                  accountNumber: url.searchParams.get('scope') === 'instance' ? '129' : '128',
                  message: `上下文合成日志 [${url.searchParams.get('scope') === 'instance' ? '129' : '128'}]\n`,
                },
              ],
            };
          } else if (url.pathname === '/api/server-monitor/logs') {
            listRequests += 1;
            const query = Object.fromEntries(url.searchParams);
            assert.notEqual(query.cursor, '', '首页请求应省略空游标');
            assert.equal(Number(query.limit), 100, '每次加载100个片段');
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
                items: [
                  row,
                  { ...row, id: 'page-two', lineNumber: '51', message: '第二页完整日志\n' },
                ],
                nextCursor: null,
              };
            else
              data = {
                items: empty ? [] : firstPageItems,
                nextCursor: empty ? null : 'synthetic-next',
              };
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
      await panel.getByRole('button', { name: '选择第1条日志', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.logInjected), undefined);
      const reader = panel.getByRole('region', { name: '日志阅读区', exact: true });
      const first = panel.getByRole('button', { name: '选择第1条日志', exact: true });
      const numberColumn = await reader.locator('td').first().boundingBox();
      assert(numberColumn.width <= 50, '序号列不应挤占日志正文宽度');
      await first.click();
      await panel.getByRole('button', { name: '复制选中日志', exact: true }).click();
      await panel.getByText('日志已复制', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), message);
      assert.equal(await panel.getByText(row.fileName, { exact: true }).count(), 0);
      assert(await panel.getByLabel('服务器', { exact: true }).isVisible());
      await panel.getByRole('button', { name: '收起筛选', exact: true }).click();
      await panel.getByRole('button', { name: '重新查询日志，从头加载', exact: true }).click();
      await first.waitFor();
      assert.equal(await panel.getByLabel('服务器', { exact: true }).isVisible(), false);
      await first.click();
      assert.equal(await panel.getByLabel('日志采集状态').getAttribute('open'), null);
      await panel.getByLabel('自动换行', { exact: true }).uncheck();
      assert(await reader.evaluate(element => element.scrollWidth > element.clientWidth));
      await panel.getByLabel('自动换行', { exact: true }).check();
      assert(await reader.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      fail = true;
      const beforeAutoLoad = listRequests;
      await reader.evaluate(element => {
        element.scrollTop = element.scrollHeight - element.clientHeight - 200;
      });
      const scrollTop = await reader.evaluate(element => element.scrollTop);
      await panel.getByText('已加载日志保留，可重试加载更多。').waitFor();
      assert.equal(await reader.locator('tbody tr').count(), 100);
      await reader.evaluate(element => {
        element.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(400);
      assert.equal(listRequests, beforeAutoLoad + 1, '失败后停止自动重试，避免反复请求');
      assert.equal(await reader.evaluate(element => element.scrollTop), scrollTop);
      fail = false;
      await panel.getByRole('button', { name: '重试加载更多', exact: true }).click();
      await panel.getByText('已加载 101 个片段 · 已到当前结果末尾').waitFor();
      assert.equal(await reader.locator('tbody tr').count(), 101, '仅去重重叠ID，保留原始重复行');
      assert.equal(await reader.evaluate(element => element.scrollTop), scrollTop);
      await reader.evaluate(element => {
        element.scrollTop = 500;
      });
      const readingTop = await reader.evaluate(element => element.scrollTop);
      const beforeExpand = listRequests;
      await panel.getByRole('button', { name: '展开阅读', exact: true }).click();
      const expanded = page.getByRole('dialog', { name: '专注日志阅读', exact: true });
      await expanded.waitFor();
      assert.equal(await reader.evaluate(element => element.scrollTop), readingTop);
      assert.equal(listRequests, beforeExpand, '展开阅读复用已加载日志');
      const expandedBox = await expanded.boundingBox();
      assert.equal(expandedBox.y, 0);
      assert.equal(expandedBox.height, page.viewportSize().height);
      await expanded.getByRole('button', { name: '退出阅读', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      assert(
        await expanded.evaluate(element => element.contains(document.activeElement)),
        '专注模式焦点不能跳到背景'
      );
      await reader.evaluate(element => {
        element.scrollTop = 500;
      });
      contextFail = true;
      await panel.getByRole('button', { name: '详情与上下文', exact: true }).click();
      const detail = page.getByRole('dialog', { name: '日志详情与上下文' });
      await detail.getByText('上下文合成失败', { exact: false }).waitFor();
      const beforeContextRetry = listRequests;
      contextFail = false;
      await detail.getByRole('button', { name: '重试上下文' }).click();
      await detail.getByText('上下文合成日志 [128]', { exact: true }).waitFor();
      assert.equal(listRequests, beforeContextRetry, '重试上下文不重新查询主列表');
      await detail.getByText(row.fileName, { exact: true }).waitFor();
      await detail.getByRole('button', { name: '整个实例上下文', exact: true }).click();
      await detail.getByText('上下文合成日志 [129]', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await detail.count(), 0);
      assert.equal(await reader.evaluate(element => element.scrollTop), readingTop);
      assert.equal(await page.evaluate(() => document.activeElement.textContent), '详情与上下文');
      assert(await expanded.isVisible(), 'Esc先关闭详情，保留专注阅读');
      await page.keyboard.press('Escape');
      assert.equal(await expanded.count(), 0);
      assert.equal(await reader.evaluate(element => element.scrollTop), readingTop);
      assert(
        await panel
          .getByRole('button', { name: '展开阅读' })
          .evaluate(element => element === document.activeElement)
      );
      await panel.getByRole('button', { name: '修改筛选', exact: true }).click();
      const accountInput = panel.getByRole('combobox', { name: '账号编号', exact: true });
      await accountInput.click();
      const candidates = page.getByRole('listbox', { name: '账号候选', exact: true });
      await candidates.getByRole('option', { name: '001', exact: true }).waitFor();
      const popupBox = await candidates.locator('..').boundingBox();
      const inputBox = await accountInput.boundingBox();
      assert(Math.abs(popupBox.width - inputBox.width) < 2, '下拉与输入框同宽');
      assert(
        popupBox.y >= 0 && popupBox.y + popupBox.height <= page.viewportSize().height + 1,
        '账号下拉高度应留在当前窗口内'
      );
      assert(
        popupBox.x >= 0 && popupBox.x + popupBox.width <= page.viewportSize().width,
        '账号下拉不得越过屏幕边缘'
      );
      await page.screenshot({
        path: path.resolve(`coverage/full-logs-${mode}-accounts.png`),
        fullPage: true,
        animations: 'disabled',
      });
      if (mobile) await candidates.getByRole('option', { name: '001', exact: true }).tap();
      else await candidates.getByRole('option', { name: '001', exact: true }).click();
      assert.equal(await accountInput.inputValue(), '001', '账号前导零保持原样');
      assert.equal(await candidates.count(), 0);
      await panel.getByRole('button', { name: '清空账号编号' }).click();
      await accountInput.click();
      await candidates.getByRole('option', { name: '001', exact: true }).waitFor();
      await page.getByRole('button', { name: '下一组账号候选', exact: true }).click();
      await candidates.getByRole('option', { name: '200', exact: true }).waitFor();
      await page.getByRole('button', { name: '账号候选首页', exact: true }).click();
      await candidates.getByRole('option', { name: '001', exact: true }).waitFor();
      await page.getByRole('button', { name: '下一组账号候选', exact: true }).focus();
      await page.keyboard.press('Escape');
      assert.equal(await candidates.count(), 0, '翻页按钮聚焦时Esc关闭并返回输入框');
      assert(await accountInput.evaluate(element => element === document.activeElement));
      await accountInput.fill('002');
      await candidates.getByRole('option', { name: '002', exact: true }).waitFor();
      await accountInput.press('ArrowDown');
      await accountInput.press('ArrowDown');
      await accountInput.press('Enter');
      assert.equal(await accountInput.inputValue(), '002', '键盘选择候选');
      assert.equal(await candidates.count(), 0);
      await accountInput.fill('777');
      await page.getByText('暂无匹配候选，可直接输入编号查询', { exact: true }).waitFor();
      assert.equal(await accountInput.inputValue(), '777', '无候选允许直接输入');
      await accountInput.press('Escape');
      assert.equal(await candidates.count(), 0);
      accountFail = true;
      await accountInput.fill('888');
      await page.getByText('账号候选合成失败，可直接输入编号查询', { exact: true }).waitFor();
      assert.equal(await accountInput.inputValue(), '888');
      accountFail = false;
      await accountInput.fill('');
      await candidates.getByRole('option', { name: '001', exact: true }).waitFor();
      await candidates.getByRole('option', { name: '全部账号', exact: true }).click();
      assert.equal(await accountInput.inputValue(), '');
      await accountInput.click();
      await candidates.getByRole('option', { name: '001', exact: true }).waitFor();
      await panel.getByLabel('正文关键词', { exact: true }).click();
      assert.equal(await candidates.count(), 0, '点外部收起');
      await panel.getByText('仅查看未识别账号的日志', { exact: true }).click();
      assert(await accountInput.isDisabled());
      assert.equal(await candidates.count(), 0);
      await panel.getByText('仅查看未识别账号的日志', { exact: true }).click();
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
      await first.waitFor();
      assert.equal(await first.locator('mark').innerText(), '店铺');
      assert.equal(await reader.evaluate(element => element.scrollTop), 0);
      assert(await panel.getByRole('button', { name: '复制选中日志' }).isDisabled());
      assert(await panel.getByLabel('服务器', { exact: true }).isVisible());
      await panel.getByLabel('软件实例', { exact: true }).selectOption(otherId);
      await panel.getByText('实例二账号128独立日志', { exact: true }).waitFor();
      assert.equal(await reader.locator('tbody tr').count(), 1);
      assert(await panel.getByLabel('服务器', { exact: true }).isVisible());
      await panel.getByLabel('软件实例', { exact: true }).selectOption(localId);
      await first.waitFor();
      fail = true;
      await panel.getByRole('button', { name: '重新查询日志，从头加载', exact: true }).click();
      await panel.getByText('合成日志读取失败', { exact: false }).waitFor();
      assert.equal(await reader.locator('tbody tr').count(), 0);
      fail = false;
      empty = true;
      await panel.getByRole('button', { name: '重新查询', exact: true }).click();
      await panel.getByText('当前条件下没有已上传的日志', { exact: false }).waitFor();
      empty = false;
      assert(await panel.getByLabel('服务器', { exact: true }).isVisible());
      await panel.getByRole('button', { name: '清空筛选', exact: true }).click();
      await first.waitFor();
      // 清空已经为空的筛选仍会重新读取，避免列表被清空后不再发请求。
      const reread = page.waitForRequest(
        req => new URL(req.url()).pathname === '/api/server-monitor/logs'
      );
      assert(await panel.getByLabel('服务器', { exact: true }).isVisible());
      await panel.getByRole('button', { name: '清空筛选', exact: true }).click();
      await reread;
      await first.waitFor();
      assert(await panel.getByLabel('服务器', { exact: true }).isVisible());
      await panel.getByRole('button', { name: '收起筛选', exact: true }).click();
      if (mobile) {
        await first.tap();
        await panel.getByRole('button', { name: '详情与上下文' }).tap();
        await detail.getByText('上下文合成日志 [128]', { exact: true }).waitFor();
        await page.setViewportSize({ width: 375, height: 500 });
        await detail.locator('.flex-1').evaluate(element => {
          element.scrollTop = element.scrollHeight;
        });
        assert(await detail.getByRole('button', { name: '关闭日志详情' }).isVisible());
        await detail.getByRole('button', { name: '关闭日志详情' }).tap();
        await page.setViewportSize({ width: 375, height: 740 });
      }
      await panel.getByRole('button', { name: '展开阅读', exact: true }).click();
      await reader.evaluate(element => {
        element.scrollTop = element.scrollHeight;
      });
      await panel.getByText('已加载 101 个片段 · 已到当前结果末尾').waitFor();
      const completedRequests = listRequests;
      await reader.evaluate(element => {
        element.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(400);
      assert.equal(listRequests, completedRequests, '末页不再自动请求');
      await reader.evaluate(element => {
        element.scrollTop = 0;
      });
      if (mobile) await expanded.getByRole('button', { name: '退出阅读', exact: true }).tap();
      else await expanded.getByRole('button', { name: '退出阅读', exact: true }).click();
      if (mode === 'portrait') {
        await page.waitForFunction(
          () =>
            document.querySelector('[aria-label="日志阅读区"]').getBoundingClientRect().height >
            1000
        );
        const box = await reader.boundingBox();
        assert(box.height > 1000, '竖屏日志高度突破旧760像素上限');
        assert(
          Math.abs(box.y + box.height - page.viewportSize().height) < 100,
          '竖屏日志填满剩余空间'
        );
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.waitForFunction(
          () =>
            document.querySelector('[aria-label="日志阅读区"]').getBoundingClientRect().height <
            1000
        );
        await page.setViewportSize({ width: 1080, height: 1920 });
        await page.waitForFunction(
          () =>
            document.querySelector('[aria-label="日志阅读区"]').getBoundingClientRect().height >
            1000
        );
      }
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        '页面不应横向溢出'
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.resolve(`coverage/full-logs-${mode}.png`),
        fullPage: true,
        animations: 'disabled',
      });
      allowed = false;
      await page.reload();
      await page.getByText('日志查询', { exact: true }).waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      await context.close();
      logger.info('完整日志浏览器合成验收通过', { viewport: mode });
    }
  } catch (error) {
    logger.error('完整日志浏览器合成验收失败', { message: error.message, stack: error.stack });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}
main();
