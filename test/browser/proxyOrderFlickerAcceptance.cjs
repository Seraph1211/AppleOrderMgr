/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const input = require('../../src/utils/proxyOrderInput');
const origin = process.env.PROXY_FLICKER_ORIGIN || 'http://127.0.0.1:5373';
const mode = process.env.PROXY_FLICKER_MODE || 'fixed';
const baselineModule =
  process.env.PROXY_FLICKER_BASELINE_MODULE || '/src/pages/proxyOrdersFlickerBaseline.jsx';
const output = process.env.PROXY_FLICKER_OUTPUT || `/tmp/apple-proxy-flicker-${mode}-20261016`;
const source =
  '姓名：张三\n身份证后四位：0123\n手机号：13800000001\n邮箱：synthetic@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼';

/** 真实React计时器/DOM回归；baseline仅替换Vite转换后的旧组件，API全部合成。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(['baseline', 'fixed'].includes(mode));
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const records = [];
  try {
    for (const width of mode === 'baseline' ? [1366] : [390, 1366]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const calls = [],
        errors = [];
      let mainDocumentRequests = 0,
        baselineOverrides = 0,
        holdLists = false;
      const held = [];
      const draft = input.parseProxyText(source).draft;
      let orders = Array.from({ length: 31 }, (_, index) => ({
        ...draft,
        id: index + 1,
        firstName: index === 30 ? '目标' : '三',
        phone: `1380000${String(index).padStart(4, '0')}`,
        version: 1,
        status: index === 1 ? 'rushing' : 'pending',
        assignments: [],
        officialOrders: [],
        notes: '原始备注',
        createdAt: '2026-10-16T01:00:00Z',
        updatedAt: '2026-10-16T02:00:00Z',
      }));
      let accounts = Array.from({ length: 31 }, (_, index) => ({
        id: index + 301,
        appleId: `account-${index}@example.com`,
        notes: '原始账号备注' + 'LongNote'.repeat(20),
        status: '使用中',
        isProxyPool: true,
        assignment: null,
        updatedAt: '2026-10-16T01:00:00Z',
      }));
      await context.addInitScript(() => {
        if (location.origin === 'null') return;
        localStorage.setItem('token', 'synthetic-proxy-flicker');
        sessionStorage.setItem(
          '__flickerDocumentLoads',
          String(Number(sessionStorage.getItem('__flickerDocumentLoads') || 0) + 1)
        );
        window.__flickerDocumentToken = Math.random().toString(36);
      });
      await context.route('**/*', async route => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        if (!path.startsWith('/api/')) {
          if (url.origin !== origin) {
            await route.abort();
            return;
          }
          if (mode === 'baseline' && path === '/src/pages/ProxyOrders.jsx') {
            baselineOverrides++;
            const response = await route.fetch({ url: origin + baselineModule });
            assert.equal(response.status(), 200);
            await route.fulfill({ response });
            return;
          }
          await route.continue();
          return;
        }
        const method = request.method(),
          body = request.postDataJSON();
        calls.push({ path, method, body, query: Object.fromEntries(url.searchParams) });
        let data = {};
        if (path === '/api/auth/me')
          data = {
            id: 2,
            username: 'flicker',
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
        else if (
          (path === '/api/proxy-orders' || path === '/api/proxy-orders/accounts') &&
          method === 'GET'
        ) {
          if (holdLists) await new Promise(resolve => held.push(resolve));
          const page = Number(url.searchParams.get('page') || 1),
            limit = Number(url.searchParams.get('limit') || 30),
            keyword = url.searchParams.get('keyword') || '',
            status = url.searchParams.get('status');
          let items;
          if (path === '/api/proxy-orders')
            items = orders.filter(
              row =>
                (!keyword || (row.lastName + row.firstName).includes(keyword)) &&
                (!status || row.status === status)
            );
          else items = accounts.filter(row => !keyword || row.appleId.includes(keyword));
          data = {
            rows: items.slice((page - 1) * limit, page * limit),
            count: items.length,
            availableCount: accounts.length,
          };
        } else if (/\/proxy-orders\/\d+\/notes$/.test(path)) {
          const id = Number(path.split('/').at(-2));
          orders = orders.map(row =>
            row.id === id ? { ...row, notes: body.notes, version: row.version + 1 } : row
          );
          data = orders.find(row => row.id === id);
        } else if (/\/proxy-orders\/accounts\/\d+$/.test(path) && method === 'PUT') {
          const id = Number(path.split('/').pop());
          accounts = accounts.map(row => (row.id === id ? { ...row, notes: body.notes } : row));
          data = { id };
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (request.resourceType() === 'document' && request.frame() === page.mainFrame())
          mainDocumentRequests++;
      });
      await page.clock.install();
      await page.goto(origin + '/proxy-orders');
      await page.getByLabel('选择 1', { exact: true }).waitFor();
      const documentToken = await page.evaluate(() => window.__flickerDocumentToken);
      const listCalls = path => calls.filter(call => call.path === path && call.method === 'GET');
      const installObserver = () =>
        page.evaluate(() => {
          window.__flickerObserver?.disconnect();
          window.__flickerTable = document.querySelector('table, .proxy-mobile-list');
          window.__flickerDetachments = 0;
          window.__flickerMounts = 1;
          window.__flickerObserver = new MutationObserver(() => {
            const current = document.querySelector('table, .proxy-mobile-list');
            if (window.__flickerTable && !window.__flickerTable.isConnected) {
              window.__flickerDetachments++;
              window.__flickerTable = null;
            }
            if (current && !window.__flickerTable) {
              window.__flickerMounts++;
              window.__flickerTable = current;
            }
          });
          window.__flickerObserver.observe(document.body, { childList: true, subtree: true });
        });
      const metrics = () =>
        page.evaluate(() => ({
          documentLoads: Number(sessionStorage.getItem('__flickerDocumentLoads')),
          documentToken: window.__flickerDocumentToken,
          tableDetachments: window.__flickerDetachments,
          tableMounts: window.__flickerMounts,
          tableConnected: Boolean(window.__flickerTable?.isConnected),
        }));
      const stable = async (name, path, checkbox, extra) => {
        await installObserver();
        const before = listCalls(path).length,
          authBefore = calls.filter(call => call.path === '/api/auth/me').length;
        const scroller = page.locator('table, .proxy-mobile-list').first().locator('..');
        await scroller.evaluate(node => {
          node.scrollLeft = node.scrollWidth;
        });
        const scroll = await scroller.evaluate(node => node.scrollLeft);
        holdLists = true;
        await page.clock.runFor(45000);
        const result = await metrics();
        assert.equal(result.documentLoads, 1);
        assert.equal(result.documentToken, documentToken);
        assert.equal(mainDocumentRequests, 1);
        assert.equal(listCalls(path).length, before);
        assert.equal(result.tableDetachments, 0);
        assert.equal(result.tableConnected, true);
        assert.equal(await checkbox.isChecked(), true);
        assert.equal(await scroller.evaluate(node => node.scrollLeft), scroll);
        if (extra) await extra();
        holdLists = false;
        const authAfter = calls.filter(call => call.path === '/api/auth/me').length;
        assert.ok(authAfter > authBefore);
        records.push({
          mode,
          width,
          name,
          simulatedMs: 45000,
          listRequestsBefore: before,
          listRequestsAfter: listCalls(path).length,
          authRequestsDuring: authAfter - authBefore,
          mainDocumentRequests,
          ...result,
        });
      };
      const activeTable = page.locator('table, .proxy-mobile-list').first();
      const reloadBy = async (path, action) => {
        const response = page.waitForResponse(
          result => new URL(result.url()).pathname === path && result.request().method() === 'GET'
        );
        await action();
        await response;
        await page.locator('table, .proxy-mobile-list').first().waitFor();
      };
      if (mode === 'baseline') {
        assert.ok(baselineOverrides > 0);
        for (const [tab, path, selection] of [
          ['orders', '/api/proxy-orders', '选择 1'],
          ['pool', '/api/proxy-orders/accounts', '选择 301'],
        ]) {
          if (tab === 'pool') {
            await page.getByRole('button', { name: '专用 AppleID 池', exact: true }).click();
            await page.getByLabel(selection, { exact: true }).waitFor();
          }
          const checkbox = page.getByLabel(selection, { exact: true });
          await checkbox.check();
          await installObserver();
          const before = listCalls(path).length;
          holdLists = true;
          await page.clock.runFor(21000);
          await page.getByText('加载中…', { exact: true }).waitFor();
          assert.equal(await page.locator('table, .proxy-mobile-list').count(), 0);
          const during = await metrics();
          assert.equal(during.documentLoads, 1);
          assert.equal(during.documentToken, documentToken);
          assert.equal(mainDocumentRequests, 1);
          assert.ok(during.tableDetachments >= 1);
          await page.screenshot({ path: `${output}/${width}-${tab}-table-missing.png` });
          holdLists = false;
          held.splice(0).forEach(resolve => resolve());
          await checkbox.waitFor();
          assert.equal(await checkbox.isChecked(), false);
          assert.ok(listCalls(path).length > before);
          records.push({
            mode,
            width,
            tab,
            simulatedMs: 21000,
            listRequestsBefore: before,
            listRequestsAfter: listCalls(path).length,
            mainDocumentRequests,
            checkedAfter: false,
            loadingObserved: true,
            ...during,
          });
        }
      } else {
        const orderSelection = page.getByLabel('选择 1', { exact: true });
        await orderSelection.check();
        await stable('orders-idle', '/api/proxy-orders', orderSelection);
        await page.getByLabel('编辑代抢 #1 备注', { exact: true }).click();
        const note = page.getByLabel('代抢 #1 备注', { exact: true });
        await note.fill('备注草稿跨周期保持');
        await stable('order-note-draft', '/api/proxy-orders', orderSelection, async () => {
          assert.equal(await note.inputValue(), '备注草稿跨周期保持');
        });
        const beforeSave = listCalls('/api/proxy-orders').length;
        await reloadBy('/api/proxy-orders', () =>
          page.getByRole('button', { name: '保存', exact: true }).click()
        );
        await note.waitFor({ state: 'hidden' });
        await orderSelection.waitFor();
        assert.ok(listCalls('/api/proxy-orders').length > beforeSave);
        assert.equal(orders[0].notes, '备注草稿跨周期保持');
        await orderSelection.check();
        await page.getByRole('button', { name: /^调整代抢 #1 状态，当前/ }).click();
        const stateDialog = page.getByRole('dialog', { name: '调整代抢 #1 状态', exact: true });
        await stateDialog.getByRole('button', { name: '抢购中', exact: true }).click();
        const reason = stateDialog.getByLabel('操作说明（选填，保留客户原备注）', { exact: true });
        await reason.fill('状态草稿跨周期保持');
        await stable('order-status-draft', '/api/proxy-orders', orderSelection, async () => {
          assert.equal(await reason.inputValue(), '状态草稿跨周期保持');
          assert.equal(
            await stateDialog.getByRole('button', { name: /^抢购中/ }).getAttribute('aria-pressed'),
            'true'
          );
        });
        await stateDialog.getByRole('button', { name: '取消', exact: true }).click();
        const refreshBefore = listCalls('/api/proxy-orders').length;
        await reloadBy('/api/proxy-orders', () =>
          page.getByRole('button', { name: '刷新列表', exact: true }).click()
        );
        await orderSelection.waitFor();
        await page.waitForFunction(() => !document.body.innerText.includes('加载中…'));
        assert.ok(listCalls('/api/proxy-orders').length > refreshBefore);
        assert.equal(await orderSelection.isChecked(), false);
        const search = page.getByLabel('搜索', { exact: true });
        await search.fill('目标');
        await page.getByLabel('选择 31', { exact: true }).waitFor();
        assert.equal(
          await page
            .locator('tbody tr, article[data-proxy-order-id], article[data-proxy-account-id]')
            .count(),
          1
        );
        assert.equal(listCalls('/api/proxy-orders').at(-1).query.keyword, '目标');
        await search.fill('');
        await orderSelection.waitFor();
        const filterResponse = page.waitForResponse(
          result =>
            new URL(result.url()).pathname === '/api/proxy-orders' &&
            result.request().method() === 'GET'
        );
        if (width < 768) {
          await page.getByRole('button', { name: '状态筛选', exact: true }).click();
          await page.getByRole('option', { name: '抢购中', exact: true }).click();
        } else await page.getByLabel('状态筛选', { exact: true }).selectOption('rushing');
        await filterResponse;
        await activeTable.waitFor();
        await page.getByLabel('选择 2', { exact: true }).waitFor();
        assert.equal(
          await page
            .locator('tbody tr, article[data-proxy-order-id], article[data-proxy-account-id]')
            .count(),
          1
        );
        assert.equal(listCalls('/api/proxy-orders').at(-1).query.status, 'rushing');
        if (width < 768) {
          await page.getByRole('button', { name: '状态筛选', exact: true }).click();
          await page.getByRole('option', { name: '全部状态', exact: true }).click();
        } else await page.getByLabel('状态筛选', { exact: true }).selectOption('');
        await orderSelection.waitFor();
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        await page.getByLabel('选择 31', { exact: true }).waitFor();
        assert.equal(listCalls('/api/proxy-orders').at(-1).query.page, '2');
        await page.getByRole('button', { name: '专用 AppleID 池', exact: true }).click();
        const poolSelection = page.getByLabel('选择 301', { exact: true });
        await poolSelection.waitFor();
        await poolSelection.check();
        await stable('pool-idle', '/api/proxy-orders/accounts', poolSelection);
        const poolRow = page
          .locator('tbody tr, article[data-proxy-order-id], article[data-proxy-account-id]')
          .filter({ has: poolSelection });
        await poolRow.getByRole('button', { name: '编辑', exact: true }).click();
        const accountDialog = page.getByRole('dialog', { name: '编辑代抢账号', exact: true });
        const accountNote = accountDialog.getByLabel('备注', { exact: true });
        await accountNote.fill('账号草稿跨周期保持');
        await stable('pool-edit-draft', '/api/proxy-orders/accounts', poolSelection, async () => {
          assert.equal(await accountNote.inputValue(), '账号草稿跨周期保持');
        });
        const poolBeforeSave = listCalls('/api/proxy-orders/accounts').length;
        await reloadBy('/api/proxy-orders/accounts', () =>
          accountDialog.getByRole('button', { name: '保存', exact: true }).click()
        );
        await accountDialog.waitFor({ state: 'hidden' });
        await poolSelection.waitFor();
        assert.ok(listCalls('/api/proxy-orders/accounts').length > poolBeforeSave);
        const poolBeforeRefresh = listCalls('/api/proxy-orders/accounts').length;
        await reloadBy('/api/proxy-orders/accounts', () =>
          page.getByRole('button', { name: '刷新列表', exact: true }).click()
        );
        await poolSelection.waitFor();
        await page.waitForFunction(() => !document.body.innerText.includes('加载中…'));
        assert.ok(listCalls('/api/proxy-orders/accounts').length > poolBeforeRefresh);
        await page.getByLabel('搜索', { exact: true }).fill('account-30@');
        await page.getByLabel('选择 331', { exact: true }).waitFor();
        assert.equal(
          await page
            .locator('tbody tr, article[data-proxy-order-id], article[data-proxy-account-id]')
            .count(),
          1
        );
        await page.screenshot({ path: `${output}/${width}-fixed-explicit-operations.png` });
        assert.equal(
          await page.evaluate(() => Number(sessionStorage.getItem('__flickerDocumentLoads'))),
          1
        );
        assert.equal(mainDocumentRequests, 1);
        assert.equal(await activeTable.count(), 1);
      }
      assert.deepEqual(errors, []);
      await context.close();
      process.stdout.write(
        `PASS ${mode} ${width}px document未重载/两tab计时器/表格及选择/${mode === 'fixed' ? '草稿和主动操作' : '闪烁复现'}\n`
      );
    }
  } finally {
    await browser.close();
    fs.writeFileSync(`${output}/metrics.json`, JSON.stringify(records, null, 2));
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
