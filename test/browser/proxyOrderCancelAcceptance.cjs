/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const input = require('../../src/utils/proxyOrderInput');
const origin = process.env.PROXY_CANCEL_ORIGIN || 'http://127.0.0.1:5173';
const output = process.env.PROXY_CANCEL_OUTPUT || '/tmp/apple-proxy-cancel-20261025';

/** 在合成API上验证桌面和手机取消确认，阻断所有外部请求。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [375, 390, 1366, 1920]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const calls = [],
        errors = [];
      const draft = input.parseProxyText(
        '姓名：合成\n身份证后四位：0123\n手机号：13800000001\n邮箱：synthetic@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼'
      ).draft;
      const rows = [1, 2, 3, 4].map(id => ({
        ...draft,
        id,
        version: 1,
        status: 'pending',
        assignments:
          id === 2 || id === 4
            ? [
              {
                id: id * 10,
                accountEmail: 'synthetic@example.com',
                startedAt: '2026-10-25T01:00:00Z',
                endedAt: null,
              },
            ]
            : [],
        officialOrders: [],
        createdAt: '2026-10-25T01:00:00Z',
      }));
      let failure = false;
      let stale = true;
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-cancel'));
      await context.route('**/*', route => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        if (!path.startsWith('/api/'))
          return url.origin === origin ? route.continue() : route.abort();
        const body = request.postDataJSON();
        const fail = (message, details = {}) =>
          route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              error: { code: 'SYNTHETIC_FAILURE', message, details },
            }),
          });
        let data = {};
        if (path === '/api/auth/me')
          data = {
            id: 2,
            username: 'cancel',
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
        else if (path === '/api/proxy-orders') data = { rows, count: rows.length };
        else if (/\/proxy-orders\/\d+\/status$/.test(path)) {
          calls.push({ path, body });
          if (failure) return fail('合成状态保存失败');
          const row = rows.find(item => item.id === Number(path.split('/').at(-2)));
          if (row.id === 3 && stale) {
            stale = false;
            row.assignments = [{ id: 30, accountEmail: 'new@example.com', endedAt: null }];
            return fail('当前存在账号占用，请确认停抢', { requiresStoppedConfirmation: true });
          }
          const active = row.assignments.filter(a => !a.endedAt);
          if (body.status === 'cancelled' && active.length && body.confirmedStopped !== true)
            return fail('缺少停抢确认', { requiresStoppedConfirmation: true });
          row.status = body.status;
          row.version += 1;
          if (row.status === 'cancelled')
            active.forEach(a => {
              a.endedAt = '2026-10-25T02:00:00Z';
            });
          data = { id: row.id, version: row.version, released: active.length };
        } else if (/\/proxy-orders\/\d+$/.test(path))
          data = {
            ...rows.find(row => row.id === Number(path.split('/').pop())),
            events: [],
            links: [],
          };
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/proxy-orders');
      const selectStatus = async (name, label) => {
        if (width >= 768)
          await page.getByRole('combobox', { name, exact: true }).selectOption({ label });
        else {
          await page.getByRole('button', { name, exact: true }).click();
          await page.getByRole('option', { name: label, exact: true }).click();
        }
      };
      const dialogFor = id =>
        page.getByRole('dialog', { name: `调整代抢 #${id} 为已取消`, exact: true });

      // 退出取消弹窗无写入；无占用可直接取消。
      await selectStatus('代抢 #1 状态', '已取消');
      let dialog = dialogFor(1);
      assert.equal(await dialog.getByRole('checkbox').count(), 0);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(calls.length, 0);
      await selectStatus('代抢 #1 状态', '已取消');
      await dialog.getByRole('button', { name: '确认取消订单', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(calls[0].body.confirmedStopped, false);
      assert.equal(rows[0].status, 'cancelled');

      // 有占用必须勾选；失败保留弹窗及确认，再次提交成功。
      await selectStatus('代抢 #2 状态', '已取消');
      dialog = dialogFor(2);
      const confirm = dialog.getByRole('button', { name: '确认取消并释放', exact: true });
      assert.equal(await confirm.isDisabled(), true);
      assert.equal(calls.length, 1);
      await dialog.getByRole('checkbox').check();
      assert.equal(await confirm.isEnabled(), true);
      await page.screenshot({ path: `${output}/${width}-confirmation.png` });
      const box = await confirm.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= 900);
      if (width < 768) assert.ok(box.height >= 44);
      failure = true;
      await confirm.click();
      await dialog.getByText('合成状态保存失败', { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('checkbox').isChecked(), true);
      failure = false;
      await confirm.click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(calls.at(-1).body.confirmedStopped, true);
      assert.equal(calls.at(-1).body.expectedVersion, 1);
      assert.equal(rows[1].status, 'cancelled');

      // 服务器发现新增占用，必须补回确认，不能直接重试。
      await selectStatus('代抢 #3 状态', '已取消');
      dialog = dialogFor(3);
      await dialog.getByRole('button', { name: '确认取消订单', exact: true }).click();
      await dialog.getByRole('checkbox').waitFor();
      assert.equal(
        await dialog.getByRole('button', { name: '确认取消并释放', exact: true }).isDisabled(),
        true
      );
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: '确认取消并释放', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });

      // 详情取消后读取新状态和账号释放历史。
      await page.getByRole('button', { name: '#4 · 合成', exact: true }).click();
      const detail = page.getByRole('dialog', { name: '代抢 #4 · 合成', exact: true });
      await selectStatus('调整代抢状态', '已取消');
      dialog = dialogFor(4);
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: '确认取消并释放', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await detail.isVisible(), true);
      assert.equal(
        await detail.getByRole('button', { name: '确认停抢并释放', exact: true }).count(),
        0
      );
      assert.equal(rows[3].status, 'cancelled');
      if (width >= 768)
        assert.equal(
          await detail.getByRole('combobox', { name: '调整代抢状态' }).inputValue(),
          'cancelled'
        );
      else
        assert.equal(
          await detail.getByRole('button', { name: '调整代抢状态', exact: true }).innerText(),
          '已取消'
        );
      assert.equal(
        await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth),
        true
      );
      await page.screenshot({ path: `${output}/${width}-detail-released.png` });
      assert.deepEqual(errors, []);
      await context.close();
      process.stdout.write(`PASS ${width}px 无占用取消/停抢确认/失败保留/陈旧占用/详情释放刷新\n`);
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
