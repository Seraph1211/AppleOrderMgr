/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const input = require('../../src/utils/proxyOrderInput');
const origin = process.env.PROXY_DELETE_ORIGIN || 'http://127.0.0.1:5373';
const output = process.env.PROXY_DELETE_OUTPUT || '/tmp/apple-proxy-delete-20261016';
const source =
  '姓名：张三\n身份证后四位：0123\n手机号：13800000001\n邮箱：synthetic@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼';

/** 在合成API和标准Chrome上独立验证软删除交互，阻断外部请求。 */
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
      let rows = Array.from({ length: 34 }, (_, index) => ({
        ...draft,
        id: index + 1,
        version: 1,
        status: 'pending',
        assignments:
          index === 1
            ? [{ id: 21, accountEmail: 'synthetic-used@example.com', endedAt: null }]
            : [],
        officialOrders: [],
        createdAt: '2026-10-16T01:00:00Z',
      }));
      let failure = false,
        needsStopped = true;
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-proxy-delete');
      });
      await context.route('**/*', route => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        if (!path.startsWith('/api/'))
          return url.origin === origin ? route.continue() : route.abort();
        const method = request.method(),
          body = request.postDataJSON();
        calls.push({ path, method, body, page: url.searchParams.get('page') });
        const fail = (message, details = {}) =>
          route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              error: { code: 'SYNTHETIC_DELETE_ERROR', message, details },
            }),
          });
        let data = {};
        if (path === '/api/auth/me')
          data = {
            id: 2,
            username: 'deletion',
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
        else if (path === '/api/proxy-orders') {
          const page = Number(url.searchParams.get('page') || 1),
            limit = Number(url.searchParams.get('limit') || 30);
          data = { rows: rows.slice((page - 1) * limit, page * limit), count: rows.length };
        } else if (/\/proxy-orders\/\d+\/delete$/.test(path)) {
          const id = Number(path.split('/').at(-2));
          if (failure) return fail('合成删除失败，请刷新后重试');
          if (id === 3 && needsStopped) {
            needsStopped = false;
            return fail('当前存在账号占用，请确认外部任务已停止', {
              requiresStoppedConfirmation: true,
            });
          }
          const row = rows.find(item => item.id === id);
          rows = rows.filter(item => item.id !== id);
          data = { id, version: row.version + 1, deleted: true };
        } else if (/\/proxy-orders\/\d+$/.test(path)) {
          const id = Number(path.split('/').pop());
          data = { ...rows.find(row => row.id === id), events: [], links: [] };
          if (id === 1)
            data.assignments = [
              {
                id: 99,
                accountEmail: 'released@example.com',
                startedAt: '2026-10-15T01:00:00Z',
                endedAt: '2026-10-15T02:00:00Z',
              },
            ];
        }
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/proxy-orders');
      const row = id =>
        page
          .locator('tbody tr')
          .filter({ has: page.getByRole('button', { name: `删除代抢 #${id}`, exact: true }) });
      const deleteCalls = () => calls.filter(call => call.path.endsWith('/delete'));
      await page.getByRole('button', { name: '删除代抢 #1', exact: true }).waitFor();
      await row(1).getByRole('checkbox').check();
      await page.getByRole('button', { name: '删除代抢 #1', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '删除代抢 #1', exact: true });
      assert.equal(await dialog.getByRole('checkbox').count(), 0);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(deleteCalls().length, 0);
      assert.equal(await row(1).getByRole('checkbox').isChecked(), true);
      await row(1).getByRole('button', { name: '详情', exact: true }).click();
      const detail = page.getByRole('dialog', { name: '代抢 #1 · 张三', exact: true });
      await detail.getByRole('button', { name: '删除订单', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '删除代抢 #1', exact: true });
      assert.equal(await dialog.getByRole('checkbox').count(), 0);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await detail.isVisible(), true);
      assert.equal(deleteCalls().length, 0);
      await detail.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '删除代抢 #1', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '删除代抢 #1', exact: true });
      await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page
        .getByRole('button', { name: '删除代抢 #1', exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(rows.length, 33);
      assert.equal(await page.getByRole('button', { name: /复制选中/ }).isDisabled(), true);

      await page.getByRole('button', { name: '删除代抢 #2', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '删除代抢 #2', exact: true });
      const confirm = dialog.getByRole('button', { name: '确认删除', exact: true });
      const stopped = dialog.getByRole('checkbox', {
        name: '已确认外部抢购任务停止，释放该订单账号占用',
        exact: true,
      });
      assert.equal(await confirm.isDisabled(), true);
      await stopped.check();
      assert.equal(await confirm.isEnabled(), true);
      const box = await confirm.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= 900);
      if (width < 768) assert.ok(box.height >= 44);
      await page.screenshot({ path: `${output}/${width}-confirmation.png` });
      failure = true;
      await confirm.click();
      await dialog.getByText('合成删除失败，请刷新后重试', { exact: true }).waitFor();
      assert.equal(await stopped.isChecked(), true);
      assert.equal(await confirm.isEnabled(), true);
      await page.screenshot({ path: `${output}/${width}-failure.png` });
      failure = false;
      await confirm.click();
      await dialog.waitFor({ state: 'hidden' });
      await page
        .getByRole('button', { name: '删除代抢 #2', exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(rows.length, 32);
      const occupiedRequest = deleteCalls().find(call => call.path.endsWith('/2/delete'));
      assert.equal(occupiedRequest.body.confirmedStopped, true);
      assert.equal(occupiedRequest.body.expectedVersion, 1);

      // 页面数据陈旧：后端发现新增占用时必须补回确认，不允许直接重试释放。
      await page.getByRole('button', { name: '删除代抢 #3', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '删除代抢 #3', exact: true });
      await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
      await dialog.getByRole('checkbox').waitFor();
      assert.equal(
        await dialog.getByRole('button', { name: '确认删除', exact: true }).isDisabled(),
        true
      );
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page
        .getByRole('button', { name: '删除代抢 #3', exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(rows.length, 31);

      // 最末页唯一记录删除后应退回上一页并清除已选ID。
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.getByRole('button', { name: '删除代抢 #34', exact: true }).waitFor();
      await row(34).getByRole('checkbox').check();
      await page.getByRole('button', { name: '删除代抢 #34', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '删除代抢 #34', exact: true });
      await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '删除代抢 #4', exact: true }).waitFor();
      await page.getByText('共 30 条 · 第 1 页', { exact: true }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: '上一页', exact: true }).isDisabled(),
        true
      );
      assert.equal(await page.getByRole('button', { name: /复制选中/ }).isDisabled(), true);
      assert.equal(
        await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth),
        true
      );
      await page.screenshot({ path: `${output}/${width}-last-page-restored.png` });
      assert.deepEqual(errors, []);
      await context.close();
      process.stdout.write(
        `PASS ${width}px 删除确认/取消/占用确认/失败保留/陈旧占用/末页恢复/选择清除\n`
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
