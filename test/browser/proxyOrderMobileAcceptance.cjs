/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const input = require('../../src/utils/proxyOrderInput');
const origin = process.env.PROXY_MOBILE_ORIGIN || 'http://127.0.0.1:5373';
const output = process.env.PROXY_MOBILE_OUTPUT || '/tmp/apple-proxy-mobile-20261016';
const source =
  '姓名：张三\n身份证后四位：000X\n手机号：13800000001\n邮箱：synthetic@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼\n备注：手机登记合成备注';
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
  '操作',
];

/** 移动摘要/表单及桌面契约独立验收，所有API合成，不访问生产。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const metrics = [];
  try {
    for (const width of [375, 390, 430, 768, 1366]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        timezoneId: 'Asia/Shanghai',
      });
      const mobile = width < 768,
        calls = [],
        errors = [];
      const draft = input.parseProxyText(source).draft;
      const longNotes = '手机长备注\n' + '无空格长文本LongText'.repeat(24);
      const poolEmail = 'pool-' + 'abcdefgh'.repeat(18) + '@example.com';
      let orders = [
        {
          ...draft,
          id: 1,
          firstName: '三',
          idLast4: '000X',
          platformOrderNumber: 'SYNTHETIC-PLATFORM',
          status: 'pending',
          version: 1,
          assignments: [{ id: 11, accountEmail: 'synthetic-pool@example.com', endedAt: null }],
          productCandidates: [
            { productModel: 'iPhone 18 Pro Max', color: '银色', storage: '256GB' },
            { productModel: 'iPhone Duo', color: '夜空色', storage: '1TB' },
          ],
          orderSource: '自定义来源手机验收',
          notes: longNotes,
          createdAt: '2026-10-16T02:11:12Z',
          updatedAt: '2026-10-16T12:21:22Z',
        },
        {
          ...draft,
          id: 2,
          firstName: '二',
          status: 'pending',
          version: 1,
          assignments: [],
          createdAt: '2026-10-16T02:11:12Z',
          updatedAt: '2026-10-16T12:21:22Z',
        },
        {
          ...draft,
          id: 3,
          firstName: '三号',
          status: 'cancelled',
          version: 1,
          assignments: [],
          notes: '已取消样本',
          createdAt: null,
          updatedAt: null,
        },
      ];
      let saveFailure = true;
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-proxy-mobile');
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: value => {
              window.__mobileCopy = value;
              return Promise.resolve();
            },
          },
        });
      });
      await context.route('**/*', async route => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        if (!path.startsWith('/api/')) {
          if (url.origin === origin) await route.continue();
          else await route.abort();
          return;
        }
        const method = request.method(),
          body = request.postDataJSON();
        calls.push({ path, method, body, query: Object.fromEntries(url.searchParams) });
        let data = {};
        if (path === '/api/auth/me')
          data = {
            id: 2,
            username: 'mobile',
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
        else if (path === '/api/proxy-orders' && method === 'GET') {
          const keyword = url.searchParams.get('keyword') || '',
            status = url.searchParams.get('status') || '';
          const rows = orders.filter(
            row =>
              (!keyword || (row.lastName + row.firstName).includes(keyword)) &&
              (!status || row.status === status)
          );
          data = { rows, count: rows.length };
        } else if (path === '/api/proxy-orders' && method === 'POST') {
          const row = {
            ...body,
            id: 4,
            version: 1,
            status: 'pending',
            assignments: [],
            createdAt: '2026-10-16T03:00:00Z',
            updatedAt: '2026-10-16T03:00:00Z',
          };
          orders.push(row);
          data = {
            id: 4,
            version: 1,
            assigned: 0,
            assignmentStatus: 'awaiting_account',
            assignmentMessage: '订单已保存，暂无可用专用账号，待分配',
          };
        } else if (path === '/api/proxy-orders/accounts')
          data = {
            rows: [
              {
                id: 301,
                appleId: poolEmail,
                status: '使用中',
                isProxyPool: true,
                assignment: null,
                notes: longNotes,
                updatedAt: '2026-10-16T02:00:00Z',
              },
            ],
            count: 1,
            availableCount: 1,
          };
        else if (path.endsWith('/copy'))
          data = { text: 'synthetic-mobile-template', count: body.ids.length };
        else if (/\/proxy-orders\/\d+\/delete$/.test(path)) {
          const id = Number(path.split('/').at(-2));
          orders = orders.filter(row => row.id !== id);
          data = { id, version: 2, deleted: true };
        } else if (/\/proxy-orders\/\d+$/.test(path)) {
          const id = Number(path.split('/').pop());
          if (method === 'PUT') {
            if (saveFailure) {
              await route.fulfill({
                status: 409,
                contentType: 'application/json',
                body: JSON.stringify({
                  success: false,
                  error: { code: 'SYNTHETIC_SAVE_FAILURE', message: '合成编辑失败，请重试' },
                }),
              });
              return;
            }
            orders = orders.map(row =>
              row.id === id ? { ...row, ...body, version: row.version + 1 } : row
            );
            data = { id, version: 2 };
          } else
            data = {
              ...orders.find(row => row.id === id),
              events: [],
              links: [],
              officialOrders: [],
            };
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install();
      await page.goto(origin + '/proxy-orders');
      await page.getByRole('checkbox', { name: '选择 1', exact: true }).waitFor();
      const entry = id => {
        const selector = mobile ? 'article[data-proxy-order-id]' : 'tbody tr';
        return page
          .locator(selector)
          .filter({ has: page.getByRole('checkbox', { name: `选择 ${id}`, exact: true }) });
      };
      if (mobile) {
        assert.equal(await page.locator('table:visible').count(), 0);
        assert.equal(await page.getByRole('article').count(), 3);
        const boxes = await entry(1)
          .getByRole('button')
          .evaluateAll(nodes =>
            nodes
              .filter(node => node.getClientRects().length)
              .map(node => ({
                x: node.getBoundingClientRect().x,
                right: node.getBoundingClientRect().right,
                height: node.getBoundingClientRect().height,
              }))
          );
        assert.ok(
          boxes.every(box => box.x >= 0 && box.right <= windowWidth(width) && box.height >= 44)
        );
      } else {
        const actual = await page.locator('table:visible thead th').allTextContents();
        assert.deepEqual(actual.map(value => value.trim()).filter(Boolean), headers);
      }
      assert.equal(
        await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth),
        true
      );
      await page.screenshot({ path: `${output}/${width}-summary.png` });
      if (mobile) {
        await page.getByRole('button', { name: '状态筛选', exact: true }).click();
        await page.getByRole('option', { name: '已取消', exact: true }).waitFor();
        assert.equal(
          await page.evaluate(() => ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)),
          false
        );
        const filtered = page.waitForResponse(
          response => new URL(response.url()).pathname === '/api/proxy-orders'
        );
        await page.getByRole('option', { name: '已取消', exact: true }).click();
        await page.clock.runFor(300);
        await filtered;
        await entry(3).waitFor();
        assert.equal(await entry(1).count(), 0);
        assert.ok(
          (await page.getByRole('button', { name: '状态筛选', exact: true }).innerText()).includes(
            '已取消'
          )
        );
        await page.getByRole('button', { name: '状态筛选', exact: true }).click();
        const unfiltered = page.waitForResponse(
          response => new URL(response.url()).pathname === '/api/proxy-orders'
        );
        await page.getByRole('option', { name: '全部状态', exact: true }).click();
        await page.clock.runFor(300);
        await unfiltered;
        await entry(1).waitFor();
      }
      let reload = page.waitForResponse(
        response => new URL(response.url()).pathname === '/api/proxy-orders'
      );
      await page.getByRole('textbox', { name: '搜索', exact: true }).fill('张二');
      await page.clock.runFor(300);
      await reload;
      await entry(2).waitFor();
      assert.equal(await entry(1).count(), 0);
      reload = page.waitForResponse(
        response => new URL(response.url()).pathname === '/api/proxy-orders'
      );
      await page.getByRole('textbox', { name: '搜索', exact: true }).fill('');
      await page.clock.runFor(300);
      await reload;
      await entry(1).waitFor();
      await entry(1).getByRole('checkbox').check();
      await page.getByRole('button', { name: '复制选中（1）', exact: true }).click();
      await page.waitForFunction(() => window.__mobileCopy === 'synthetic-mobile-template');
      assert.deepEqual(calls.find(call => call.path.endsWith('/copy')).body.ids, [1]);
      if (mobile) {
        await page.getByRole('button', { name: '清空选择', exact: true }).click();
        await page.getByRole('checkbox', { name: '全选当前页', exact: true }).check();
        assert.equal(
          await page
            .getByRole('checkbox', { name: /^选择 / })
            .evaluateAll(nodes => nodes.every(node => node.checked)),
          true
        );
        await page.getByRole('button', { name: '清空选择', exact: true }).click();
      }
      await entry(1).getByRole('button', { name: /详情/ }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '编辑资料', exact: true }).waitFor();
      for (const value of [
        '编号',
        '姓名',
        '取机城市',
        '登记时间',
        '更新时间',
        '身份证后四位',
        '000X',
        '13800000001',
        'synthetic@example.com',
        'iPhone 18 Pro Max',
        '银色',
        '256',
        'iPhone Duo',
        '夜空色',
        '1T',
        '自定义来源手机验收',
      ]) {
        assert.ok((await dialog.innerText()).includes(value), `detail missing ${value}`);
      }
      assert.ok((await dialog.innerText()).includes(longNotes));
      await dialog.getByRole('button', { name: '编辑资料', exact: true }).click();
      await page.getByRole('heading', { name: '编辑代抢 #1', exact: true }).waitFor();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('备注', { exact: true }).fill('手机编辑保留草稿');
      if (mobile) {
        const geometry = await dialog
          .locator('input:not([type=checkbox]), textarea, button')
          .evaluateAll(nodes =>
            nodes
              .filter(node => node.getClientRects().length)
              .map(node => ({
                tag: node.tagName,
                height: node.getBoundingClientRect().height,
                font: parseFloat(getComputedStyle(node).fontSize),
              }))
          );
        assert.ok(geometry.filter(item => item.tag !== 'BUTTON').every(item => item.font >= 16));
        assert.ok(
          geometry.every(item => item.height >= 44),
          JSON.stringify(geometry)
        );
      }
      await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
      await dialog.getByText('合成编辑失败，请重试', { exact: true }).waitFor();
      assert.equal(
        await dialog.getByLabel('备注', { exact: true }).inputValue(),
        '手机编辑保留草稿'
      );
      await page.screenshot({ path: `${output}/${width}-edit-error.png` });
      saveFailure = false;
      let loaded = page.waitForResponse(
        response =>
          new URL(response.url()).pathname === '/api/proxy-orders' &&
          response.request().method() === 'GET'
      );
      await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
      await loaded;
      await entry(1).waitFor();
      assert.equal(calls.filter(call => call.method === 'PUT').at(-1).body.expectedVersion, 1);
      assert.equal(orders[0].notes, '手机编辑保留草稿');
      // 真实React计时器跨越两个旧轮询周期，摘要/表格节点及选择不得丢失。
      await entry(1).getByRole('checkbox').check();
      await entry(1).evaluate(node => {
        window.__mobileStableNode = node;
      });
      const requestCount = calls.filter(
        call => call.path === '/api/proxy-orders' && call.method === 'GET'
      ).length;
      await entry(1)
        .getByRole('button', { name: /调整代抢 #1 状态/ })
        .click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('操作说明（选填，保留客户原备注）').fill('跨周期状态说明');
      await page.clock.runFor(45000);
      assert.equal(
        await dialog.getByLabel('操作说明（选填，保留客户原备注）').inputValue(),
        '跨周期状态说明'
      );
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(
        calls.filter(call => call.path === '/api/proxy-orders' && call.method === 'GET').length,
        requestCount
      );
      assert.equal(await page.evaluate(() => window.__mobileStableNode.isConnected), true);
      assert.equal(await entry(1).getByRole('checkbox').isChecked(), true);
      const more = entry(1).locator('summary');
      if (mobile) await more.click();
      await entry(1).getByRole('button', { name: '删除代抢 #1', exact: true }).click();
      dialog = page.getByRole('dialog');
      const confirmation = dialog.getByRole('checkbox');
      assert.equal(
        await dialog.getByRole('button', { name: '确认删除', exact: true }).isDisabled(),
        true
      );
      await confirmation.check();
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(calls.filter(call => call.path.endsWith('/delete')).length, 0);
      if (mobile) await entry(2).locator('summary').click();
      await entry(2).getByRole('button', { name: '删除代抢 #2', exact: true }).click();
      dialog = page.getByRole('dialog');
      assert.equal(await dialog.getByRole('checkbox').count(), 0);
      loaded = page.waitForResponse(
        response =>
          new URL(response.url()).pathname === '/api/proxy-orders' &&
          response.request().method() === 'GET'
      );
      await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
      await loaded;
      await entry(1).waitFor();
      assert.equal(await entry(2).count(), 0);
      await page.getByRole('button', { name: '登记代抢', exact: true }).click();
      dialog = page.getByRole('dialog');
      assert.equal(
        await page.evaluate(() => ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)),
        false
      );
      await dialog.getByLabel('客户抢购信息').fill(source);
      await dialog.getByRole('button', { name: '识别并预览', exact: true }).click();
      await dialog.getByLabel('手机号', { exact: true }).waitFor();
      assert.equal(
        await dialog.getByLabel('身份证（完整号码或后四位）', { exact: true }).inputValue(),
        '000X'
      );
      if (mobile) {
        const sizes = await dialog
          .locator('input:not([type=checkbox]),textarea,button')
          .evaluateAll(nodes =>
            nodes
              .filter(node => node.getClientRects().length)
              .map(node => ({
                tag: node.tagName,
                font: parseFloat(getComputedStyle(node).fontSize),
                height: node.getBoundingClientRect().height,
              }))
          );
        assert.ok(
          sizes.every(node => node.height >= 44 && (node.tag === 'BUTTON' || node.font >= 16)),
          JSON.stringify(sizes)
        );
        await dialog
          .getByRole('button', { name: '确认保存', exact: true })
          .scrollIntoViewIfNeeded();
        const box = await dialog
          .getByRole('button', { name: '确认保存', exact: true })
          .boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= 901);
      }
      await page.screenshot({ path: `${output}/${width}-register.png` });
      loaded = page.waitForResponse(
        response =>
          new URL(response.url()).pathname === '/api/proxy-orders' &&
          response.request().method() === 'GET'
      );
      await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
      await loaded;
      await entry(4).waitFor();
      assert.equal(orders.find(row => row.id === 4).idLast4, '000X');
      await page.getByRole('button', { name: '专用 AppleID 池', exact: true }).click();
      await page.getByText(poolEmail, { exact: true }).waitFor();
      if (mobile) {
        const account = page.locator('article[data-proxy-account-id]');
        assert.equal(await account.count(), 1);
        assert.equal(await account.getByRole('button', { name: /编辑/ }).isVisible(), true);
        const note = account.locator('details');
        assert.equal(await note.getAttribute('open'), null);
        await note.locator('summary').click();
        assert.ok((await note.innerText()).includes(longNotes));
      }
      assert.equal(
        await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth),
        true
      );
      await page.screenshot({ path: `${output}/${width}-pool.png` });
      assert.deepEqual(errors, []);
      await context.close();
      metrics.push({
        width,
        mobile,
        complete: true,
        stableMilliseconds: 45000,
        listRequestsDuringIdle: 0,
      });
      process.stdout.write(
        `PASS ${width}px 摘要/完整详情/搜索筛选/复制/编辑重试/登记/删除/45秒稳定/账号池\n`
      );
    }
  } finally {
    await browser.close();
    fs.writeFileSync(`${output}/metrics.json`, JSON.stringify(metrics, null, 2));
  }
}
function windowWidth(width) {
  return width + 1;
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
