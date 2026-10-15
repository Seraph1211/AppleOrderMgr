/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const input = require('../../src/utils/proxyOrderInput');
const origin = process.env.PROXY_V2_ORIGIN || 'http://127.0.0.1:5373';
const output = process.env.PROXY_V2_OUTPUT || '/tmp/apple-proxy-orders-v2-20261015';
const source =
  '姓名：张三\n身份证后四位：0123\n手机号：13800000001\n邮箱：customer1@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼\n备注：只能10.24～10.25取货';

/** 二期页面独立合成验收；阻断非本地请求，所有业务 API 使用合成数据。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [1440, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const errors = [],
        calls = [];
      const base = input.parseProxyText(source).draft;
      let rows = [
        {
          ...base,
          id: 1,
          version: 1,
          status: 'succeeded',
          assigned: true,
          assignments: [{ id: 1, accountEmail: 'pool@example.com' }],
          assignmentCount: 1,
          anomaly: '',
          createdAt: '2026-10-15T01:00:00Z',
        },
      ];
      let failure = false;
      const officialOrders = [
        {
          id: 9101,
          orderNumber: 'W9900000001',
          products: [{ name: 'iPhone Duo 星光白色 256GB', quantity: 1 }],
          pickupStore: 'Apple 重庆解放碑',
          status: 'PROCESSING',
          officialStatusObservedAt: '2026-10-15T02:00:00Z',
        },
        {
          id: 9102,
          orderNumber: 'W9900000002',
          products: [{ name: 'iPhone Duo 星光白色 256GB', quantity: 1 }],
          pickupStore: 'Apple 重庆万象城',
          status: null,
          officialStatusObservedAt: null,
        },
        {
          id: 9103,
          orderNumber: 'W9900000003',
          products: [{ name: 'iPhone Duo 星光白色 256GB', quantity: 1 }],
          pickupStore: 'Apple 重庆解放碑',
          status: 'READY_FOR_PICKUP',
          officialStatusObservedAt: '2026-10-15T02:05:00Z',
        },
      ];
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-proxy-v2');
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: value => {
              window.__copy = value;
              return Promise.resolve();
            },
          },
        });
      });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === origin) return route.continue();
          return route.abort();
        }
        const method = route.request().method(),
          body = route.request().postDataJSON();
        calls.push({ path: url.pathname, method, body });
        let data = {};
        if (url.pathname === '/api/auth/me')
          data = {
            id: 2,
            username: 'acceptance',
            role: 'operator',
            availableHome: '/proxy-orders',
            permissions: ['proxy_orders.read'],
          };
        else if (url.pathname.endsWith('/stores')) data = input.STORES;
        else if (url.pathname.endsWith('/catalog'))
          data = {
            productCandidates: input.PRODUCT_CANDIDATES,
            paymentMethods: input.PAYMENT_METHODS,
          };
        else if (url.pathname.endsWith('/parse')) data = input.parseProxyText(body.text);
        else if (url.pathname.endsWith('/address'))
          data = input.generateProxyAddress(body.storeCode);
        else if (url.pathname === '/api/proxy-orders' && method === 'GET')
          data = { rows, count: rows.length };
        else if (url.pathname === '/api/proxy-orders' && method === 'POST') {
          data = { ...body, id: rows.length + 1, version: 1, status: 'pending', assigned: false };
          rows.push(data);
        } else if (url.pathname.endsWith('/accounts'))
          data = { rows: [], count: 0, availableCount: 0 };
        else if (url.pathname.endsWith('/copy'))
          data = { count: 1, text: 'synthetic-template-for-browser-only' };
        else if (/\/proxy-orders\/\d+$/.test(url.pathname))
          data = {
            ...rows.find(row => row.id === Number(url.pathname.split('/').pop())),
            assignments: [],
            events: [],
            links: [],
            officialOrders,
          };
        else if (/\/proxy-orders\/\d+\/(status|notes)$/.test(url.pathname)) {
          if (failure)
            return route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, message: '合成保存失败，请重试' }),
            });
          const id = Number(url.pathname.split('/').at(-2));
          rows = rows.map(row =>
            row.id === id ? { ...row, ...body, version: row.version + 1 } : row
          );
          data = rows.find(row => row.id === id);
        }
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/proxy-orders');
      await page
        .getByRole('button', { name: '#1 · 张三' })
        .waitFor({ timeout: 10000 })
        .catch(async error => {
          process.stderr.write(
            JSON.stringify({ errors, calls, text: await page.locator('body').innerText() }) + '\n'
          );
          throw error;
        });
      assert.equal(
        await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth),
        true
      );
      await page.screenshot({ path: `${output}/${width}-list.png`, fullPage: true });
      const status = page.locator(
        'select[aria-label="代抢 #1 状态"],select[data-responsive-select="代抢 #1 状态"]'
      );
      if (width === 375) {
        await page.getByRole('button', { name: '代抢 #1 状态', exact: true }).click();
        await page.getByRole('option', { name: '待处理', exact: true }).click();
      } else {
        await status.selectOption('pending');
      }
      let dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '确认修改' }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(rows[0].status, 'pending');
      await page.getByLabel('编辑代抢 #1 备注').click();
      const notes = page.getByLabel('代抢 #1 备注', { exact: true });
      await notes.fill('独立浏览器备注草稿');
      failure = true;
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByText('合成保存失败，请重试').waitFor();
      assert.equal(await notes.inputValue(), '独立浏览器备注草稿');
      failure = false;
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await notes.waitFor({ state: 'hidden' });
      assert.equal(rows[0].notes, '独立浏览器备注草稿');
      await page.getByRole('button', { name: '#1 · 张三' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByText('W9900000001', { exact: true }).waitFor();
      await dialog.getByText('W9900000002', { exact: true }).waitFor();
      await dialog.getByText('处理中', { exact: true }).waitFor();
      await dialog.getByText('可取货', { exact: true }).waitFor();
      assert.ok(await dialog.getByText('未获取', { exact: true }).count());
      assert.equal(await dialog.getByText('PROCESSING', { exact: true }).count(), 0);
      assert.equal(await dialog.getByText('READY_FOR_PICKUP', { exact: true }).count(), 0);
      assert.equal(await dialog.getByRole('link').count(), 0);
      await page.screenshot({ path: `${output}/${width}-detail.png`, fullPage: true });
      await dialog.getByText('W9900000001', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/${width}-linked-orders.png`, fullPage: true });
      await dialog.getByRole('button', { name: '解除误关联' }).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/${width}-linked-actions.png`, fullPage: true });
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '登记代抢', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('客户抢购信息').fill(source);
      await dialog.getByRole('button', { name: '一键登记', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(rows.length, 2);
      assert.equal(rows[1].idLast4, '0123');
      assert.equal(rows[1].orderSource, '闲鱼');
      await page.getByRole('button', { name: '登记代抢', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('客户抢购信息').fill(source.replace('Duo 白', '18PM 白'));
      await dialog.getByRole('button', { name: '一键登记', exact: true }).click();
      await dialog.getByText('请核对原文并修改下方资料。').waitFor();
      assert.equal(rows.length, 2);
      await page.screenshot({ path: `${output}/${width}-preview.png`, fullPage: true });
      assert.deepEqual(errors, []);
      assert.ok(
        calls.some(
          call =>
            call.path.endsWith('/status') &&
            call.body.status === 'pending' &&
            call.body.reason === ''
        )
      );
      await context.close();
      process.stdout.write(
        `PASS ${width}px 合成登记、歧义、状态恢复、备注失败重试、多订单官网状态与权限链接\n`
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
