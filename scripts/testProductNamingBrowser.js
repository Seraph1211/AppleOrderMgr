/* global localStorage, window, navigator, document */
/* eslint-disable no-magic-numbers -- 合成视口和规格测试数据 */
/* eslint-disable camelcase -- 合成订单 API 保留既有字段协议 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

/** 仅拦截合成 API，独立 Chrome 验证商品标准名、复制和 PC/H5；不读取真实业务。 */
async function main() {
  let browser;
  try {
    const base = process.env.PRODUCT_NAMING_BROWSER_URL || 'http://127.0.0.1:5178';
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('只允许本机合成前端');
    const output = path.resolve(
      process.env.PRODUCT_NAMING_BROWSER_OUTPUT || '.tmp/product-naming-frontend'
    );
    fs.mkdirSync(output, { recursive: true });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const products = [
      {
        name: 'iPhone 18 Pro Max 256GB 黑色',
        model: 'MJY64CH/A',
        quantity: 1,
        filterKeys: ['historic-key'],
      },
      {
        name: 'iPhone 18 Pro Max 黑色 256G',
        model: 'MJY64CH/A',
        quantity: 2,
        filterKeys: ['new-key'],
      },
      { model: 'MK2T4CH/A', quantity: 1 },
      { name: 'iPhone 18 Pro Max 银色 256G', model: 'MJY64CH/A', quantity: 1 },
      {
        name: 'iPhone 18 Pro Max 256GB 黑色',
        model: 'MJY64CH/A',
        quantity: 4,
        nameNeedsReview: true,
        nameReviewReason: 'sku_conflict',
      },
    ];
    const canonical = 'iPhone 18 Pro Max 黑色 256G';
    const duo = 'iPhone Duo 星光白色 1T';
    const task = {
      id: 1,
      orderId: 101,
      orderNumber: 'W1234567890',
      products,
      paymentMethod: '招行12期',
      processingStatus: 'pending',
      officialPaymentStatus: 'unknown',
      officialOrderStatus: 'pending',
      orderDate: '2026-10-15T01:00:00Z',
      version: 0,
    };
    const fixture = {
      id: 1,
      order_number: task.orderNumber,
      products,
      status: 'pending',
      order_date: task.orderDate,
    };
    const errors = [];
    const writes = [];
    for (const width of [1440, 375]) {
      const context = await browser.newContext({
        viewport: { width, height: 950 },
        serviceWorkers: 'block',
      });
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-product-name-token');
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: text => {
              window.copiedText = text;
              return Promise.resolve();
            },
            write: async items => {
              window.copiedText = await (await items[0].getType('text/plain')).text();
            },
          },
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => {
        errors.push(error.message);
        process.stderr.write(`PAGEERROR: ${error.message}\n`);
      });
      await page.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === base) await route.continue();
            else await route.abort();
            return;
          }
          if (route.request().method() !== 'GET') writes.push(url.pathname);
          let data = {};
          if (url.pathname === '/api/auth/me')
            data = {
              id: 1,
              username: 'synthetic-product-review',
              role: 'admin',
              permissions: [
                'orders.read',
                'payment_dispatch.read',
                'payment_dispatch.link.read',
                'payment_tasks.read_own',
                'payment_tasks.link.read_own',
                'proxy_orders.read',
              ],
              availableHome: '/orders',
            };
          else if (url.pathname === '/api/orders/filter-options')
            data = {
              productOptions: [
                {
                  value: 'historic-key',
                  label: 'iPhone 18 Pro Max 256GB 黑色 · MJY64CH/A',
                  keys: ['historic-key'],
                  aliases: ['iPhone 18 Pro Max 黑色 256G'],
                  count: 1,
                },
              ],
              recipientTags: [],
              stores: [],
            };
          else if (url.pathname === '/api/orders') data = { orders: [fixture], total: 1 };
          else if (url.pathname.endsWith('/devices')) data = { items: [] };
          else if (url.pathname.startsWith('/api/orders/')) data = fixture;
          else if (url.pathname === '/api/payment-dispatch/overview')
            data = { settings: { enabled: false, mode: 'manual', version: 0 }, staff: [] };
          else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(url.pathname))
            data = {
              items: [task],
              productOptions: [],
              recipientTagOptions: [],
              officialOrderStatuses: [],
              pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
            };
          else if (url.pathname.endsWith('/payment-link'))
            data = { paymentUrl: 'https://example.com/synthetic-order' };
          else if (url.pathname.endsWith('/payment-code'))
            data = { ...task, availability: 'missing' };
          else if (url.pathname === '/api/public/apple-quotes')
            data = {
              enabled: true,
              updatedAt: '2026-10-15T01:00:00Z',
              filters: { productModels: ['18 Pro Max'], storageGb: [256], colors: ['黑色'] },
              items: [
                {
                  productKey: 'synthetic',
                  productName: 'iPhone 18 Pro Max 256GB 黑色',
                  productModel: '18 Pro Max',
                  storageGb: 256,
                  color: '黑色',
                  quotePrice: 9000,
                },
              ],
            };
          else if (url.pathname === '/api/proxy-orders/stores') data = [];
          else if (url.pathname === '/api/proxy-orders')
            data = {
              count: 1,
              rows: [
                {
                  id: 1,
                  lastName: '合',
                  firstName: '成',
                  productModel: 'iPhone 18 Pro Max',
                  color: '酒红色',
                  storage: '256GB',
                  quantity: 1,
                  assignments: [],
                  status: 'pending',
                  storeCodes: [],
                  billing: {},
                },
              ],
            };
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      for (const screen of ['orders', 'payment-dispatch', 'payment-tasks']) {
        await page.goto(`${base}/${screen}`, { waitUntil: 'networkidle' });
        if (screen === 'orders' && width < 768) {
          await page.getByText(`${canonical} ×3，另 3 款`, { exact: true }).waitFor();
          await page.getByRole('button', { name: '查看', exact: true }).click();
          await page.getByText(duo, { exact: true }).last().waitFor();
          await page
            .getByText('商品信息待核对', { exact: true })
            .filter({ visible: true })
            .first()
            .waitFor();
          await page
            .getByRole('button', { name: '关闭订单详情', exact: true })
            .click()
            .catch(async error => {
              process.stderr.write(`${page.url()}: ${await page.locator('body').innerText()}\n`);
              throw error;
            });
        } else {
          const region = page.locator('tbody');
          await region.getByText(`${canonical} ×3`, { exact: true }).first().waitFor();
          await region.getByText(`${duo} ×1`, { exact: true }).first().waitFor();
          await region
            .getByText('iPhone 18 Pro Max 256GB 黑色 ×4', { exact: true })
            .first()
            .waitFor();
          await region.getByText('商品信息待核对', { exact: true }).first().waitFor();
        }
        if (screen !== 'orders') {
          await page
            .getByRole('button', { name: /^复制订单信息/ })
            .first()
            .click();
          await page.waitForFunction(() =>
            window.copiedText?.includes('iPhone 18 Pro Max 黑色 256G x 3')
          );
          assert.match(await page.evaluate(() => window.copiedText), /iPhone Duo 星光白色 1T x 1/);
          assert.match(
            await page.evaluate(() => window.copiedText),
            /iPhone 18 Pro Max 256GB 黑色 x 4/
          );
          await page.getByRole('button', { name: '查看付款码', exact: true }).first().click();
          await page.getByRole('dialog').getByText(`${canonical} ×3`, { exact: false }).waitFor();
          await page.getByRole('button', { name: '关闭付款码', exact: true }).click();
        }
        await page.screenshot({
          path: path.join(output, `${screen}-${width}.png`),
          fullPage: true,
        });
      }
      await page.goto(`${base}/proxy-orders`, { waitUntil: 'networkidle' });
      await page.getByText('iPhone 18 Pro Max 勃艮第酒红色 256G × 1', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, `proxy-${width}.png`), fullPage: true });
      await page.goto(`${base}/quote/apple`, { waitUntil: 'networkidle' });
      await page.getByText(canonical, { exact: true }).waitFor();
      await page.getByRole('button', { name: '复制当前报价', exact: true }).click();
      await page.waitForFunction(() =>
        window.copiedText?.startsWith('iPhone 18 Pro Max 黑色 256G｜报价')
      );
      const bounds = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert.ok(bounds.scroll <= bounds.width + 1, `报价${width}无页面溢出`);
      await page.screenshot({ path: path.join(output, `quotes-${width}.png`), fullPage: true });
      await context.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, [], '仅合成读取与本地剪贴板，不执行业务写入');
    fs.writeFileSync(
      path.join(output, '结果.json'),
      JSON.stringify(
        {
          widths: [1440, 375],
          screens: ['orders', 'payment-dispatch', 'payment-tasks', 'proxy-orders', 'quote/apple'],
          errors,
          writes,
        },
        null,
        2
      )
    );
    process.stdout.write(
      `商品名称 PC/H5、付款复制/付款码、代抢和报价合成验收通过；证据 ${output}\n`
    );
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}
main();
