/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const input = require('../../src/utils/proxyOrderInput');
const origin = process.env.PROXY_DISPLAY_ORIGIN || 'http://127.0.0.1:5373';
const output = process.env.PROXY_DISPLAY_OUTPUT || '/tmp/apple-proxy-display-20261016';
const headers = [
  '编号',
  '姓名 / 身份证',
  '手机号',
  '邮箱',
  '机型',
  '取机城市',
  '支付方式',
  '订单来源',
  '备注',
  '状态',
  '登记时间',
  '更新时间',
];
const source =
  '姓名：张三\n身份证后四位：0123\n手机号：13800000001\n邮箱：synthetic@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼';
const labels = { pending: '待处理', rushing: '抢购中', succeeded: '抢购成功', cancelled: '已取消' };

/** 独立检查12列契约及页面交互；全部API合成拦截，禁止外部请求。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [375, 390, 768, 1366, 1920]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        timezoneId: 'Asia/Shanghai',
      });
      const errors = [],
        calls = [];
      const draft = input.parseProxyText(source).draft;
      const poolEmail = 'account-' + 'abcdefgh'.repeat(20) + '@example.com';
      const poolNotes = '账号池长备注\n' + 'UnbrokenNote'.repeat(30);
      const notes = '完整备注第一行\n' + '长备注用于独立检查换行和完整阅读，'.repeat(12);
      let rows = [
        {
          ...draft,
          id: 101,
          lastName: '张',
          firstName: '一',
          idLast4: '000X',
          phone: '13800000001',
          email: 'customer-one@example.com',
          quantity: 2,
          storeCity: '重庆',
          orderSource: '自定义来源-验收',
          paymentMethod: '花呗12期',
          notes,
          status: 'pending',
          version: 1,
          assignments: [{ id: 201, accountEmail: 'pool@example.com', endedAt: null }],
          productCandidates: [
            { productModel: 'iPhone 18 Pro Max', color: '银色', storage: '256GB' },
            { productModel: 'iPhone 18 Pro Max', color: '黑色', storage: '512GB' },
            { productModel: 'iPhone Duo', color: '星光白色', storage: '1TB' },
          ],
          createdAt: '2026-10-16T02:11:12Z',
          updatedAt: '2026-10-16T12:21:22Z',
        },
        {
          ...draft,
          id: 102,
          lastName: '李',
          firstName: '二',
          idLast4: '',
          phone: '',
          email: '',
          storeCity: '',
          storeCodes: [],
          orderSource: '',
          paymentMethod: '',
          notes: '',
          status: 'rushing',
          version: 1,
          assignments: [],
          productCandidates: [],
          productModel: 'iPhone 17 Pro',
          color: '银色',
          storage: '256GB',
          createdAt: null,
          updatedAt: null,
        },
        {
          ...draft,
          id: 103,
          storeCity: '',
          storeCodes: ['R480', 'R573'],
          lastName: '王',
          firstName: '三',
          status: 'succeeded',
          version: 1,
          assignments: [{ id: 203, accountEmail: 'succeeded@example.com', endedAt: null }],
          createdAt: '2026-10-16T02:11:12Z',
          updatedAt: '2026-10-16T12:21:22Z',
        },
        {
          ...draft,
          id: 104,
          storeCity: '',
          storeCodes: ['R480', 'R572'],
          lastName: '赵',
          firstName: '四',
          status: 'cancelled',
          version: 1,
          assignments: [],
          notes: 'LongWord'.repeat(45),
          createdAt: '2026-10-16T02:11:12Z',
          updatedAt: '2026-10-16T12:21:22Z',
        },
      ];
      let statusFailure = false;
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-proxy-display');
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: value => {
              window.__copied = value;
              return Promise.resolve();
            },
          },
        });
      });
      await context.route('**/*', route => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        if (!path.startsWith('/api/'))
          return url.origin === origin ? route.continue() : route.abort();
        const method = request.method(),
          body = request.postDataJSON();
        calls.push({ path, method, body });
        let data = {};
        if (path === '/api/auth/me')
          data = {
            id: 2,
            username: 'display',
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
        else if (path === '/api/proxy-orders/accounts')
          data = {
            rows: [
              {
                id: 301,
                appleId: poolEmail,
                notes: poolNotes,
                status: '使用中',
                assignment: null,
                isProxyPool: true,
                updatedAt: '2026-10-16T12:21:22Z',
              },
            ],
            availableCount: 1,
            count: 1,
          };
        else if (path.endsWith('/copy')) data = { text: 'synthetic-display-template', count: 1 };
        else if (/\/proxy-orders\/\d+\/status$/.test(path)) {
          if (statusFailure)
            return route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({
                success: false,
                error: { code: 'SYNTHETIC_STATUS_FAILURE', message: '合成状态保存失败' },
              }),
            });
          const id = Number(path.split('/').at(-2));
          rows = rows.map(row =>
            row.id === id ? { ...row, status: body.status, version: row.version + 1 } : row
          );
          data = rows.find(row => row.id === id);
        } else if (/\/proxy-orders\/\d+$/.test(path))
          data = {
            ...rows.find(row => row.id === Number(path.split('/').pop())),
            events: [],
            links: [],
            officialOrders: [],
          };
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/proxy-orders');
      await page.getByRole('button', { name: '删除代抢 #101', exact: true }).waitFor();
      const table = page.locator('table').first();
      const row = id =>
        table
          .locator('tbody tr')
          .filter({ has: page.getByRole('button', { name: `删除代抢 #${id}`, exact: true }) });
      const headings = await table.locator('thead th').allTextContents();
      assert.deepEqual(headings.map(text => text.trim()).filter(Boolean), [...headers, '操作']);
      const cells = row(101).locator('td');
      assert.equal(await cells.count(), 14);
      assert.match(await cells.nth(1).innerText(), /101/);
      assert.match(await cells.nth(2).innerText(), /张一/);
      assert.match(await cells.nth(2).innerText(), /000X/);
      assert.equal((await cells.nth(3).innerText()).trim(), '13800000001');
      assert.equal((await cells.nth(4).innerText()).trim(), 'customer-one@example.com');
      const productText = (await cells.nth(5).innerText()).replace(/\s/g, '');
      for (const name of [
        'iPhone18ProMax银色256G',
        'iPhone18ProMax黑色512G',
        'iPhoneDuo星光白色1T',
      ])
        assert.ok(productText.includes(name));
      assert.equal((await cells.nth(6).innerText()).trim(), '重庆');
      assert.equal((await cells.nth(7).innerText()).trim(), '花呗12期');
      assert.equal((await cells.nth(8).innerText()).trim(), '自定义来源-验收');
      assert.ok((await cells.nth(9).innerText()).includes(notes));
      assert.ok((await cells.nth(11).innerText()).includes('10:11:12'));
      assert.ok((await cells.nth(12).innerText()).includes('20:21:22'));
      const empty = row(102).locator('td');
      for (const index of [3, 4, 6, 7, 8, 11, 12])
        assert.equal((await empty.nth(index).innerText()).trim(), '—');
      assert.match(await empty.nth(2).innerText(), /李二/);
      assert.ok((await empty.nth(5).innerText()).includes('iPhone 17 Pro'));
      const colors = {
        pending: 'rgb(254, 243, 199)',
        rushing: 'rgb(219, 234, 254)',
        succeeded: 'rgb(220, 252, 231)',
        cancelled: 'rgb(243, 244, 246)',
      };
      for (const [index, status] of ['pending', 'rushing', 'succeeded', 'cancelled'].entries()) {
        const badge = row(101 + index)
          .locator('td')
          .nth(10)
          .locator('button');
        assert.ok((await badge.innerText()).includes(labels[status]));
        assert.equal(
          await badge.evaluate(node => getComputedStyle(node).backgroundColor),
          colors[status]
        );
        assert.equal(
          await badge.evaluate(
            node => node.classList.contains('btn') && node.classList.contains('badge')
          ),
          true
        );
        const box = await badge.boundingBox();
        if (width < 768) assert.ok(box.height >= 44);
        else assert.ok(box.height <= 40);
      }
      assert.equal((await row(103).locator('td').nth(6).innerText()).trim(), '重庆');
      assert.equal((await row(104).locator('td').nth(6).innerText()).trim(), '—');
      assert.equal(
        await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth),
        true
      );
      const scroller = table.locator('..');
      if (width === 1920) {
        assert.equal(
          await table.evaluate(node => node.scrollWidth <= node.parentElement.clientWidth),
          true
        );
        const actionsBox = await cells.nth(13).boundingBox();
        const statusBox = await cells.nth(10).getByRole('button').boundingBox();
        assert.ok(statusBox.x + statusBox.width <= actionsBox.x);
        for (const index of [11, 12]) {
          const dateBox = await cells.nth(index).boundingBox();
          assert.ok(dateBox.x + dateBox.width <= actionsBox.x + 1);
        }
      }
      if (width < 1920) {
        assert.equal(await scroller.evaluate(node => node.scrollWidth > node.clientWidth), true);
        await scroller.evaluate(node => {
          node.scrollLeft = node.scrollWidth;
        });
        assert.ok(await scroller.evaluate(node => node.scrollLeft > 0));
      }
      await page.screenshot({ path: `${output}/${width}-right.png` });
      await scroller.evaluate(node => {
        node.scrollLeft = 0;
      });
      await page.screenshot({ path: `${output}/${width}-left.png` });

      // 功能交互在完成表格契约断言后执行。
      await row(101).getByRole('button', { name: '详情', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '代抢 #101 · 张一', exact: true });
      await dialog.waitFor();
      assert.ok((await dialog.innerText()).includes('customer-one@example.com'));
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await row(102).getByRole('button', { name: '分配账号', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '分配抢购账号', exact: true });
      await dialog.getByRole('button', { name: '确认分配', exact: true }).waitFor();
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await row(101).getByRole('button', { name: '复制模板', exact: true }).click();
      await page.waitForFunction(() => window.__copied === 'synthetic-display-template');
      await row(101).getByRole('button', { name: '删除代抢 #101', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '删除代抢 #101', exact: true });
      assert.equal(
        await dialog.getByRole('button', { name: '确认删除', exact: true }).isDisabled(),
        true
      );
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(
        calls.some(call => call.path.endsWith('/delete')),
        false
      );

      // 状态按钮及保存由当前紧凑状态组件的可访问控件驱动。
      const statusButton = row(101).getByRole('button', { name: /^调整代抢 #101 状态，当前/ });
      const statusCalls = () => calls.filter(call => call.path.endsWith('/status'));
      await statusButton.focus();
      await page.keyboard.press('Enter');
      dialog = page.getByRole('dialog', { name: '调整代抢 #101 状态', exact: true });
      await dialog.waitFor();
      const options = dialog.getByRole('group', { name: '选择代抢状态', exact: true });
      assert.equal(await options.getByRole('button').count(), 4);
      assert.equal(
        await dialog.getByRole('button', { name: '确认修改', exact: true }).isDisabled(),
        true
      );
      await options.getByRole('button', { name: '抢购成功', exact: true }).click();
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(statusCalls().length, 0);
      assert.equal(rows[0].status, 'pending');
      await statusButton.click();
      dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '已取消', exact: true }).click();
      await dialog
        .getByLabel('操作说明（选填，保留客户原备注）', { exact: true })
        .fill('取消说明-独立验收');
      const noteField = dialog.getByLabel('操作说明（选填，保留客户原备注）', { exact: true });
      if (width < 768) {
        assert.ok(
          await noteField.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize) >= 16)
        );
        assert.ok((await noteField.boundingBox()).height >= 44);
        const heights = await dialog
          .getByRole('button')
          .evaluateAll(nodes =>
            nodes
              .filter(node => node.getClientRects().length)
              .map(node => node.getBoundingClientRect().height)
          );
        assert.ok(heights.every(height => height >= 44));
      }
      await dialog.getByRole('button', { name: '确认修改', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
      assert.equal(rows[0].status, 'cancelled');
      assert.equal(rows[0].notes, notes);
      assert.deepEqual(statusCalls()[0].body, {
        expectedVersion: 1,
        status: 'cancelled',
        reason: '取消说明-独立验收',
      });
      await statusButton.click();
      dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '待处理', exact: true }).click();
      await dialog
        .getByLabel('操作说明（选填，保留客户原备注）', { exact: true })
        .fill('恢复说明草稿-独立验收');
      statusFailure = true;
      await dialog.getByRole('button', { name: '确认修改', exact: true }).click();
      await dialog.getByText('合成状态保存失败', { exact: true }).waitFor();
      assert.equal(rows[0].status, 'cancelled');
      assert.equal(
        await dialog.getByLabel('操作说明（选填，保留客户原备注）', { exact: true }).inputValue(),
        '恢复说明草稿-独立验收'
      );
      await page.screenshot({ path: `${output}/${width}-status-error.png` });
      statusFailure = false;
      await dialog.getByRole('button', { name: '确认修改', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(rows[0].status, 'pending');
      const retries = statusCalls().slice(-2);
      assert.deepEqual(
        retries.map(call => call.body),
        [
          { expectedVersion: 2, status: 'pending', reason: '恢复说明草稿-独立验收' },
          { expectedVersion: 2, status: 'pending', reason: '恢复说明草稿-独立验收' },
        ]
      );
      await page.getByRole('button', { name: '专用 AppleID 池', exact: true }).click();
      await page.getByText(poolEmail, { exact: true }).waitFor();
      const accountEmailCell = page.locator('.proxy-account-email-cell');
      const accountNotesCell = page.locator('.proxy-account-notes-cell');
      assert.equal((await accountNotesCell.innerText()).trim(), poolNotes);
      assert.equal(
        await accountEmailCell.evaluate(node => getComputedStyle(node).whiteSpace),
        'normal'
      );
      assert.equal(
        await accountEmailCell.evaluate(node => getComputedStyle(node).overflowWrap),
        'anywhere'
      );
      assert.equal(
        await accountNotesCell.evaluate(node => getComputedStyle(node).overflowWrap),
        'anywhere'
      );
      assert.equal(
        await accountEmailCell.evaluate(node => node.scrollWidth <= node.clientWidth),
        true
      );
      assert.equal(
        await accountNotesCell.evaluate(node => node.scrollWidth <= node.clientWidth),
        true
      );
      assert.equal(
        await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth),
        true
      );
      const poolScroller = accountEmailCell.locator('xpath=ancestor::table').locator('..');
      await poolScroller.evaluate(node => {
        node.scrollLeft = 0;
      });
      await page.screenshot({ path: `${output}/${width}-account-pool.png` });
      if (width < 768) {
        await poolScroller.evaluate(node => {
          node.scrollLeft = node.scrollWidth;
        });
        await page.screenshot({ path: `${output}/${width}-account-pool-right.png` });
      }
      assert.deepEqual(errors, []);
      await context.close();
      process.stdout.write(
        `PASS ${width}px 12列/全空长字段/多候选/灰色取消/状态保存/功能入口/横滚\n`
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
