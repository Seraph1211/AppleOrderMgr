/* eslint-env node, browser */
/* eslint-disable no-magic-numbers, camelcase -- 合成接口字段与验收屏宽 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const BEFORE = process.env.ORDERS_BEFORE_URL || 'http://127.0.0.1:5191';
const AFTER = process.env.ORDERS_AFTER_URL || 'http://127.0.0.1:5194';
const OUTPUT = process.env.ORDERS_ISOLATION_OUTPUT || 'output/订单UI验收/2026-10-29/其他页面对照';
const ROUTES = [
  '/',
  '/proxy-orders',
  '/stock',
  '/stock?view=sold',
  '/inventory-monitor',
  '/inventory-monitor/manage',
  '/payment-tasks',
  '/payment-dispatch',
  '/apple-ids',
  '/recipients',
  '/identity-verifications',
  '/channels',
  '/channels/验收/orders',
  '/mail-contacts',
  '/wecom-notifications',
  '/email-processing',
  '/server-monitor',
  '/server-monitor/logs',
  '/order-ingestion',
  '/quote-pricing',
  '/users',
  '/operation-logs',
  '/profile',
  '/change-password',
  '/orders/101',
  '/login',
  '/quote/apple',
  '/quote/duo',
];
const PERMISSION_VALUES = [
  ...fs
    .readFileSync(path.resolve(__dirname, '../../frontend/src/constants/permissions.js'), 'utf8')
    .matchAll(/:\s*'([^']+)'/g),
].map(match => match[1]);
const ORDER = {
  id: 101,
  order_number: 'W1029000001',
  recipient_name: '合成取机人',
  recipient_tag: '验收TAG',
  products: [{ name: 'iPhone 18 Pro 银色 256G', quantity: 1 }],
  official_order_status: 'PROCESSING',
  display_order_status: 'confirmed',
  notes: '合成备注',
};

/** 同一合成状态逐像素比较内容及页头；共享菜单单独检查交互，所有写请求被拒绝。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    fs.mkdirSync(OUTPUT, { recursive: true });
    const report = [];
    const contexts = [];
    const pages = [];
    const errors = [[], []];
    const apiStates = new Map();
    for (const [index, base] of [BEFORE, AFTER].entries()) {
      const context = await browser.newContext({ timezoneId: 'Asia/Shanghai' });
      contexts.push(context);
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-ui-isolation');
        const NativeDate = Date;
        globalThis.Date = class extends NativeDate {
          constructor(...args) {
            super(...(args.length ? args : ['2026-10-29T12:00:00.000Z']));
          }
          static now() {
            return 1793275200000;
          }
        };
      });
      await context.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === base || url.protocol === 'data:') await route.continue();
            else await route.abort();
            return;
          }
          assert.equal(route.request().method(), 'GET', '隔离回归不允许写请求');
          let data;
          const p = url.pathname;
          if (p === '/api/auth/me')
            data = {
              id: 1,
              username: '界面回归',
              nickname: '界面回归',
              role: 'admin',
              permissions: PERMISSION_VALUES,
              availableHome: '/',
              orderAccess: { mode: 'all' },
            };
          else if (p === '/api/apple-ids')
            data = {
              apple_ids: [
                {
                  id: 1,
                  account_number: 1,
                  apple_id: 'demo@example.test',
                  status: 'normal',
                  notes: '合成账号',
                },
              ],
              total: 1,
            };
          else if (p === '/api/recipients')
            data = {
              recipients: [
                {
                  id: 1,
                  name: '合成取机人',
                  tag: '验收TAG',
                  status: 'normal',
                  phone: '138****0001',
                  credit_rating: 'A',
                },
              ],
              total: 1,
            };
          else if (p === '/api/recipients/filter-options') data = { tags: ['验收TAG'] };
          else if (p === '/api/channels')
            data = {
              channels: [
                {
                  id: 1,
                  name: '合成渠道',
                  channelName: '合成渠道',
                  totalOrders: 1,
                  paidOrders: 0,
                  deliveredOrders: 0,
                  tag: '验收TAG',
                  order_count: 1,
                },
              ],
            };
          else if (p === '/api/users')
            data = {
              users: [
                {
                  id: 1,
                  username: '合成用户',
                  role: 'operator',
                  status: 'active',
                  permissions: [],
                },
              ],
              total: 1,
              page: 1,
              limit: 20,
            };
          else if (p === '/api/mail-contacts')
            data = { items: [{ id: 1, name: '合成联系人', email: 'demo@example.test' }], total: 1 };
          else if (p.endsWith('/stock/ledger/catalog'))
            data = {
              enabled: true,
              warehouses: [{ id: 'w1', name: '合成仓库' }],
              products: [],
              people: [],
              filterOptions: { modelNames: [], storageGbs: [], colorNames: [] },
            };
          else if (p.endsWith('/stock/ledger'))
            data = {
              items: [
                {
                  id: 'u1',
                  deviceNumber: 1,
                  serialNumber: 'TEST123456',
                  state: 'in_stock',
                  allowedActions: ['sell'],
                  warehouse: { id: 'w1', name: '合成仓库' },
                },
              ],
              total: 1,
              counts: { registered: 0, in_stock: 1, sold: 0, returned: 0 },
            };
          else if (p === '/api/orders/101') data = ORDER;
          else if (p === '/api/orders/101/link') data = { orderUrl: null };
          else if (p === '/api/orders/101/devices') data = { items: [] };
          else if (p === '/api/pickups') data = { items: [], total: 0 };
          else if (p.endsWith('/sources')) data = { items: [], total: 0 };
          else if (p === '/api/orders') data = { orders: [ORDER], total: 1 };
          else if (p === '/api/orders/filter-options')
            data = { productOptions: [], recipientTags: ['验收TAG'], stores: [], payers: [] };
          else if (p === '/api/system/auto-refresh') data = { isRunning: false };
          else if (p === '/api/payment-tasks')
            data = {
              items: [
                {
                  id: 1,
                  orderId: 101,
                  orderNumber: ORDER.order_number,
                  version: 1,
                  processingStatus: 'pending',
                  products: ORDER.products,
                  officialOrderAmount: '9999.00',
                  officialPaymentStatus: 'unpaid',
                  officialOrderStatus: 'PROCESSING',
                  recipientTag: '验收TAG',
                  paymentMethod: 'WECHAT',
                },
              ],
              pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
              productOptions: [],
              recipientTagOptions: ['验收TAG'],
              officialOrderStatuses: ['PROCESSING'],
              serverTime: '2026-10-29T12:00:00.000Z',
            };
          else if (p.startsWith('/api/dashboard/')) {
            if (p.endsWith('/stats'))
              data = {
                totalOrders: 1,
                paidOrders: 0,
                totalAmount: 9999,
                availableRecipients: 1,
                missingAmountOrders: 0,
                orderGrowth: 0,
                amountGrowth: 0,
              };
            else if (p.endsWith('/filter-options'))
              data = {
                productOptions: [],
                recipientTags: ['验收TAG'],
                displayOrderStatuses: ['confirmed'],
                officialOrderStatuses: ['PROCESSING'],
              };
            else if (p.endsWith('/recent-orders')) data = [ORDER];
            else data = [];
          } else if (p === '/api/email-processing/metrics')
            data = { worker: { isRunning: false, isConnected: false }, queue: {}, counts: {} };
          if (data === undefined) {
            apiStates.set(p, '故障状态');
            await route.fulfill({
              status: 503,
              json: { success: false, error: { message: '合成接口故障：隔离回归' } },
            });
          } else {
            apiStates.set(p, '合成数据');
            await route.fulfill({ json: { success: true, data } });
          }
        } catch (error) {
          errors[index].push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.on('pageerror', error => {
        errors[index].push(error.message);
        process.stderr.write(`pageerror ${index}: ${error.message}\n`);
      });
      page.setDefaultTimeout(5000);
      pages.push(page);
    }
    const compare = async (label, locatorFor) => {
      const buffers = [];
      const layouts = [];
      for (const [i, p] of pages.entries()) {
        await p.mouse.move(1, 1);
        const target = await locatorFor(p);
        layouts.push(
          await target.evaluate(root =>
            [...root.querySelectorAll('*')]
              .filter(node => node.getClientRects().length)
              .map(node => {
                const style = getComputedStyle(node),
                  box = node.getBoundingClientRect();
                return {
                  tag: node.tagName,
                  text: node.children.length ? undefined : node.textContent,
                  rect: [box.x, box.y, box.width, box.height].map(
                    value => Math.round(value * 1000) / 1000
                  ),
                  style: Object.fromEntries(
                    [
                      'font-family',
                      'font-size',
                      'font-weight',
                      'line-height',
                      'color',
                      'background-color',
                      'border-color',
                      'border-width',
                      'border-radius',
                      'padding',
                      'margin',
                      'display',
                      'position',
                      'box-shadow',
                      'outline',
                      'opacity',
                    ].map(key => [key, style.getPropertyValue(key)])
                  ),
                };
              })
          )
        );
        buffers.push(
          await target.screenshot({
            path: path.join(OUTPUT, `${label}-${i ? '改造后' : '改造前'}.png`),
            animations: 'disabled',
            caret: 'hide',
          })
        );
      }
      const a = PNG.sync.read(buffers[0]),
        b = PNG.sync.read(buffers[1]);
      let different = 0;
      let antialiasOnly = 0;
      let maxDelta = 0;
      if (a.width !== b.width || a.height !== b.height) different = -1;
      else
        for (let n = 0; n < a.data.length; n += 4) {
          const delta = Math.max(
            ...[0, 1, 2, 3].map(channel => Math.abs(a.data[n + channel] - b.data[n + channel]))
          );
          maxDelta = Math.max(maxDelta, delta);
          if (delta > 1) different++;
          else if (delta === 1) antialiasOnly++;
        }
      report.push({
        label,
        width: a.width,
        height: a.height,
        differentPixels: different,
        antialiasOnlyPixels: antialiasOnly,
      });
      fs.writeFileSync(
        path.join(OUTPUT, 'partial-report.json'),
        JSON.stringify({ report, errors }, null, 2)
      );
      process.stdout.write(`${label}: ${different} pixels\n`);
      assert.deepEqual(layouts[1], layouts[0], `${label}内容结构、几何及计算样式必须相同`);
      assert(
        different === 0 || (different <= 16 && maxDelta <= 10),
        `${label}截图差异超出最多16个边缘像素、单通道10级的抗锯齿误差：${different}/${maxDelta}`
      );
    };
    for (const width of [1440, 390]) {
      for (const route of ROUTES.filter(
        value => !(process.env.ORDERS_ISOLATION_SKIP_ROUTES || '').split(',').includes(value)
      )) {
        const label = `${width}-${route.replaceAll('/', '_').replaceAll('?', '_') || '仪表板'}`;
        for (const [i, p] of pages.entries()) {
          await p.setViewportSize({ width, height: 900 });
          // 登录页必须以未登录会话比较，其他路由恢复同一合成身份。
          await p.goto(`${i ? AFTER : BEFORE}/login`);
          await p.evaluate(
            ({ login }) => {
              if (login) localStorage.removeItem('token');
              else localStorage.setItem('token', 'synthetic-ui-isolation');
            },
            { login: route === '/login' }
          );
          await p.goto(`${i ? AFTER : BEFORE}${route}`);
          await p.locator('body').waitFor();
          await p.waitForTimeout(400);
          await p.evaluate(() => document.fonts.ready);
        }
        await compare(label, p =>
          p.locator(route.startsWith('/quote/') || route === '/login' ? 'body' : '.app-content')
        );
        if (!route.startsWith('/quote/') && route !== '/login')
          await compare(`${label}-页头`, p => p.locator('header').first());
        // 共用筛选、列设置和通用弹窗在非订单路由也必须保持原样。
        if (
          [
            '/apple-ids',
            '/recipients',
            '/payment-tasks',
            '/server-monitor/logs',
            '/users',
          ].includes(route)
        ) {
          const buttonName =
            route === '/recipients'
              ? '取机人TAG筛选'
              : route === '/payment-tasks'
                ? '订单TAG筛选'
                : '列设置';
          const buttons = pages.map(p => p.getByRole('button', { name: buttonName, exact: true }));
          if ((await buttons[0].count()) && (await buttons[1].count())) {
            for (const button of buttons) await button.click();
            await compare(`${label}-共用控件`, p =>
              p
                .locator('[role="dialog"],dialog[open]')
                .last()
                .count()
                .then(async n =>
                  n
                    ? p.locator('[role="dialog"],dialog[open]').last()
                    : (await p.locator('.fixed .max-w-md').count())
                      ? p.locator('.fixed .max-w-md').last()
                      : p.locator('.app-content')
                )
            );
          }
        }
      }
    }
    // 切换路由后的实例样式不残留；订单断点不改变其他页1024px常驻导航。
    const p = pages[1];
    for (const width of [1050, 768, 390, 320]) {
      await p.setViewportSize({ width, height: 900 });
      await p.goto(`${AFTER}/orders`);
      await p.getByRole('heading', { name: '订单管理', exact: true }).waitFor();
      const trigger = p.getByRole('button', { name: '打开导航', exact: true });
      await trigger.click();
      const nav = p.getByRole('dialog', { name: '应用导航' });
      await nav.waitFor();
      assert.equal(await p.locator('.app-main').evaluate(node => node.inert), true);
      const links = nav.locator('a:visible,button:visible');
      await links.first().focus();
      await p.keyboard.press('Shift+Tab');
      assert.equal(await links.last().evaluate(node => node === document.activeElement), true);
      await p.keyboard.press('Escape');
      await nav.waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
      assert.equal(await p.locator('.app-main').evaluate(node => node.inert), false);
      await p.goto(`${AFTER}/apple-ids`);
      await p.getByRole('heading', { name: 'Apple ID 管理' }).waitFor();
      assert.equal(await p.locator('[data-orders-ui]').count(), 0);
      if (width === 1050)
        assert.equal(
          await p.getByRole('button', { name: '打开导航', exact: true }).isVisible(),
          false
        );
    }
    fs.writeFileSync(
      path.join(OUTPUT, 'report.json'),
      JSON.stringify(
        {
          report,
          apiStates: [...apiStates],
          errors,
          coverage: '28个其他路由×1440/390px；原有数据及故障状态、共用控件；导航1050/768/390/320px',
        },
        null,
        2
      )
    );
    assert.deepEqual(errors[1], errors[0], '改造后不得新增运行异常');
    process.stdout.write(
      `PASS: ${report.length}组结构、几何与计算样式一致，截图通过边缘抗锯齿检查；导航焦点及隔离通过\n`
    );
    for (const context of contexts) await context.close();
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
