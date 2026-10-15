/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const input = require('../../src/utils/proxyOrderInput');
const origin = process.env.PROXY_FEEDBACK_ORIGIN || 'http://127.0.0.1:5373';
const output = process.env.PROXY_FEEDBACK_OUTPUT || '/tmp/apple-proxy-feedback-20261016';
const source =
  '姓名：合成\n身份证后四位：0123\n手机号：13800000001\n邮箱：synthetic@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼';
const template = 'synthetic-browser-template-only';

/** 使用标准 Playwright/Chrome 合成验收分配、剪贴板故障和响应式弹窗。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [375, 390, 1366, 1920]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const errors = [],
        calls = [];
      const draft = input.parseProxyText(source).draft;
      let rows = [1, 2].map(id => ({
        ...draft,
        id,
        firstName: id === 1 ? '成' : '二',
        lastName: '合',
        version: 1,
        status: 'pending',
        assignments: [],
        officialOrders: [],
        createdAt: '2026-10-16T01:00:00Z',
      }));
      const accounts = [
        {
          id: 10,
          appleId: 'legacy-used@example.com',
          status: '使用中',
          notes: '等待工作人员确认停止',
          isProxyPool: true,
        },
        { id: 11, appleId: 'available-one@example.com', status: '已下架', isProxyPool: true },
        { id: 12, appleId: 'available-two@example.com', status: '未使用', isProxyPool: true },
      ];
      let assignFailure = false,
        copyFailure = false;
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-proxy-feedback');
        window.__clipboardMode = 'reject';
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          get: () => {
            if (window.__clipboardMode === 'unsupported') return undefined;
            return {
              writeText: value => {
                if (window.__clipboardMode === 'success') {
                  window.__copied = value;
                  return Promise.resolve();
                }
                return Promise.reject(
                  new DOMException('synthetic clipboard rejected', 'NotAllowedError')
                );
              },
            };
          },
        });
      });
      await context.route('**/*', route => {
        const request = route.request(),
          url = new URL(request.url());
        if (!url.pathname.startsWith('/api/'))
          return url.origin === origin ? route.continue() : route.abort();
        const body = request.postDataJSON(),
          method = request.method(),
          path = url.pathname;
        calls.push({ path, method, body, query: url.search });
        const fail = message =>
          route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, error: { code: 'SYNTHETIC_FAILURE', message } }),
          });
        let data = {};
        if (path === '/api/auth/me')
          data = {
            id: 2,
            username: 'feedback',
            role: 'operator',
            availableHome: '/proxy-orders',
            permissions: ['proxy_orders.read'],
          };
        else if (path.endsWith('/stores')) data = input.STORES;
        else if (path.endsWith('/catalog'))
          data = {
            productCandidates: input.PRODUCT_CANDIDATES,
            paymentMethods: input.PAYMENT_METHODS,
          };
        else if (path.endsWith('/parse')) data = input.parseProxyText(body.text);
        else if (path.endsWith('/address')) data = input.generateProxyAddress(body.storeCode);
        else if (path === '/api/proxy-orders' && method === 'GET')
          data = { rows, count: rows.length };
        else if (path === '/api/proxy-orders/accounts' && method === 'GET') {
          const available = accounts.filter(
            account => ['未使用', '使用中'].includes(account.status) && !account.assignment
          );
          data = {
            rows: url.searchParams.get('availableOnly') === 'true' ? available : accounts,
            count:
              url.searchParams.get('availableOnly') === 'true' ? available.length : accounts.length,
            availableCount: available.length,
          };
        } else if (/\/proxy-orders\/\d+\/accounts$/.test(path)) {
          if (assignFailure) return fail('合成分配失败，请刷新后重试');
          const row = rows.find(item => item.id === Number(path.split('/').at(-2)));
          let selected;
          if (body.accountIds)
            selected = accounts.filter(account => body.accountIds.includes(account.id));
          else
            selected = accounts
              .filter(
                account => ['未使用', '使用中'].includes(account.status) && !account.assignment
              )
              .slice(0, Number(body.count));
          if (!selected.length) return fail('可用账号不足');
          selected.forEach(account => {
            account.status = '使用中';
            account.assignment = { id: account.id, proxyOrderId: row.id };
            row.assignments.push({
              id: account.id,
              appleIdRef: account.id,
              accountEmail: account.appleId,
              startedAt: '2026-10-16T02:00:00Z',
              endedAt: null,
            });
          });
          row.version++;
          data = { id: row.id, version: row.version, assigned: selected.length };
        } else if (/\/proxy-orders\/\d+$/.test(path))
          data = {
            ...rows.find(row => row.id === Number(path.split('/').pop())),
            events: [],
            links: [],
          };
        else if (path.endsWith('/copy')) {
          if (copyFailure) return fail('合成模板生成失败，请核对账号状态');
          data = { count: 1, text: template };
        }
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/proxy-orders');
      const rowLocator = id =>
        page.locator('tbody tr').filter({
          has: page.getByRole('button', {
            name: `#${id} · 合${id === 1 ? '成' : '二'}`,
            exact: true,
          }),
        });
      await page.getByRole('button', { name: '#1 · 合成', exact: true }).waitFor();
      const first = rowLocator(1);
      const disabledCopy = first.getByRole('button', { name: '复制模板', exact: true });
      assert.equal(await disabledCopy.isDisabled(), true);
      assert.match(await first.innerText(), /待分配|先分配|未分配/);
      await page.screenshot({ path: `${output}/${width}-list.png`, fullPage: false });
      await first.getByRole('button', { name: '分配账号', exact: true }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '确认分配', exact: true }).waitFor();
      assignFailure = true;
      await dialog.getByRole('button', { name: '确认分配', exact: true }).click();
      const alert = dialog.getByText('合成分配失败，请刷新后重试', { exact: true });
      await alert.waitFor();
      assert.equal(await alert.isVisible(), true);
      await page.screenshot({ path: `${output}/${width}-assignment-error.png`, fullPage: false });
      assignFailure = false;
      await dialog.getByRole('button', { name: '确认分配', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByText('legacy-used@example.com', { exact: true }).waitFor();
      assert.equal(rows[0].assignments.length, 1);
      assert.equal(accounts[0].status, '使用中');
      assert.ok(
        calls.some(call => call.path === '/api/proxy-orders/1/accounts' && call.body.count === 1)
      );

      await dialog.getByRole('button', { name: '复制模板', exact: true }).click();
      let fallback = page
        .getByRole('dialog', { name: /手动复制|复制模板/ })
        .filter({ has: page.getByLabel('待复制内容') });
      await fallback.waitFor();
      assert.equal(await fallback.getByLabel('待复制内容').inputValue(), template);
      await fallback.getByLabel('待复制内容').focus();
      assert.equal(
        await fallback
          .getByLabel('待复制内容')
          .evaluate(node => node.selectionEnd - node.selectionStart),
        template.length
      );
      await page.screenshot({ path: `${output}/${width}-clipboard-rejected.png`, fullPage: false });
      await page.evaluate(() => {
        window.__clipboardMode = 'success';
      });
      await fallback.getByRole('button', { name: '复制到剪贴板', exact: true }).click();
      await fallback.getByText('已复制到剪贴板。', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__copied), template);
      await fallback.getByRole('button', { name: '关闭', exact: true }).click();
      assert.equal(await page.getByLabel('待复制内容').count(), 0);
      assert.equal(
        await page.evaluate(value => Object.values(localStorage).includes(value), template),
        false
      );
      await page.evaluate(() => {
        window.__clipboardMode = 'unsupported';
      });
      await page.getByRole('dialog').getByRole('button', { name: '复制模板', exact: true }).click();
      fallback = page.getByRole('dialog').filter({ has: page.getByLabel('待复制内容') });
      await fallback.waitFor();
      assert.equal(await fallback.getByLabel('待复制内容').inputValue(), template);
      await fallback.getByRole('button', { name: '关闭', exact: true }).click();
      copyFailure = true;
      await page.getByRole('dialog').getByRole('button', { name: '复制模板', exact: true }).click();
      await page.getByRole('dialog').getByText('合成模板生成失败，请核对账号状态').waitFor();
      assert.equal(
        await page.getByRole('dialog').getByText('正在生成并复制模板…', { exact: true }).count(),
        0
      );
      copyFailure = false;
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      await first.getByRole('button', { name: '追加账号', exact: true }).click();
      dialog = page.getByRole('dialog');
      if (width < 768) {
        await dialog.getByRole('button', { name: '分配账号选择', exact: true }).click();
        await page.getByRole('option', { name: 'available-two@example.com', exact: true }).click();
      } else await dialog.getByLabel('分配账号选择', { exact: true }).selectOption('12');
      await dialog.getByRole('button', { name: '确认分配', exact: true }).click();
      await page.getByRole('dialog', { name: '代抢 #1 · 合成', exact: true }).waitFor();
      await page
        .getByRole('dialog', { name: '代抢 #1 · 合成', exact: true })
        .getByText('available-two@example.com', { exact: true })
        .waitFor();
      assert.equal(rows[0].assignments.length, 2);
      assert.equal(accounts[0].status, '使用中');
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      await rowLocator(2).getByRole('button', { name: '分配账号', exact: true }).click();
      dialog = page.getByRole('dialog');
      assert.equal(
        await dialog.getByRole('button', { name: '确认分配', exact: true }).isDisabled(),
        true
      );
      assert.match(await dialog.innerText(), /0|没有|暂无/);
      assert.match(await dialog.innerText(), /使用中|停抢|导入/);
      await page.screenshot({ path: `${output}/${width}-empty-pool.png`, fullPage: false });
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();

      const register = page.getByRole('button', { name: '登记代抢', exact: true });
      await register.click();
      dialog = page.getByRole('dialog');
      const textarea = dialog.getByLabel('客户抢购信息');
      await textarea.waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            document.activeElement.tagName === 'TEXTAREA' ||
            document.activeElement.tagName === 'INPUT'
        ),
        false
      );
      await textarea.focus();
      if (width < 768) {
        const controls = await dialog
          .locator('input:not([type=checkbox]),textarea,select')
          .evaluateAll(nodes =>
            nodes
              .filter(node => node.getClientRects().length)
              .map(node => ({
                size: Number.parseFloat(getComputedStyle(node).fontSize),
                height: node.getBoundingClientRect().height,
              }))
          );
        assert.ok(controls.every(control => control.size >= 16));
        assert.ok(controls.every(control => control.height >= 44));
      }
      assert.equal(
        await page
          .locator('body')
          .evaluate(
            node => node.style.position === 'fixed' || getComputedStyle(node).overflow === 'hidden'
          ),
        true
      );
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true);
      await textarea.fill(source);
      await dialog.getByRole('button', { name: '识别并预览', exact: true }).click();
      await dialog.getByRole('button', { name: '确认保存', exact: true }).waitFor();
      const scroller = dialog.locator('.proxy-dialog-body');
      await scroller.hover();
      await page.mouse.wheel(0, 2000);
      await page.waitForFunction(() => document.querySelector('.proxy-dialog-body')?.scrollTop > 0);
      if (width < 768) {
        const allFields = await dialog
          .locator('input:not([type=checkbox]),textarea,select')
          .evaluateAll(nodes =>
            nodes
              .filter(node => node.getClientRects().length)
              .map(node => ({
                size: Number.parseFloat(getComputedStyle(node).fontSize),
                height: node.getBoundingClientRect().height,
                label:
                  node.getAttribute('aria-label') || node.closest('label')?.innerText?.slice(0, 30),
              }))
          );
        assert.ok(allFields.every(field => field.size >= 16));
        assert.ok(
          allFields.every(field => field.height >= 44),
          JSON.stringify(allFields.filter(field => field.height < 44))
        );
        const buttons = await dialog
          .locator('button')
          .evaluateAll(nodes =>
            nodes
              .filter(node => node.getClientRects().length)
              .map(node => node.getBoundingClientRect().height)
          );
        assert.ok(
          buttons.every(height => height >= 44),
          JSON.stringify(buttons)
        );
        await page.setViewportSize({ width, height: 600 });
        await page
          .waitForFunction(
            () => {
              const box = document.querySelector('[role=dialog]')?.getBoundingClientRect();
              return box && box.y >= 0 && box.bottom <= 601;
            },
            null,
            { timeout: 3000 }
          )
          .catch(async error => {
            process.stderr.write(
              JSON.stringify(
                await dialog.evaluate(node => ({
                  box: node.getBoundingClientRect().toJSON(),
                  style: node.getAttribute('style'),
                  overlay: node.parentElement.getBoundingClientRect().toJSON(),
                  padding: getComputedStyle(node.parentElement).padding,
                  vv: {
                    height: window.visualViewport.height,
                    top: window.visualViewport.offsetTop,
                  },
                  innerHeight: window.innerHeight,
                }))
              ) + '\n'
            );
            throw error;
          });
        const box = await dialog.boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= 601);
        await page.screenshot({ path: `${output}/${width}-reduced-viewport.png`, fullPage: false });
        await page.setViewportSize({ width, height: 900 });
        await page.waitForFunction(() => window.visualViewport.height === 900);
        await page.evaluate(
          () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        );
      }
      await dialog.getByRole('button', { name: '关闭', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(
        await dialog
          .getByRole('button', { name: '确认保存', exact: true })
          .evaluate(node => document.activeElement === node),
        true
      );
      await page.screenshot({
        path: `${output}/${width}-registration-scroll.png`,
        fullPage: false,
      });
      assert.equal(
        await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth),
        true
      );
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await register.evaluate(node => document.activeElement === node), true);
      assert.equal(
        await page.locator('body').evaluate(node => node.style.position === 'fixed'),
        false
      );
      assert.deepEqual(errors, []);
      await context.close();
      process.stdout.write(
        `PASS ${width}px 分配/空池/错误可见/剪贴板拒绝及缺失/焦点/输入字号/滚动\n`
      );
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
