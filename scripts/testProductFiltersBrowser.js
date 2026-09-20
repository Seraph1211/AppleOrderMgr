/* global localStorage */
/* eslint-disable camelcase -- 合成订单 API 沿用 snake_case */
const assert = require('node:assert/strict');

/** 专用临时浏览器、全合成 API：验证三页商品即时筛选与官网不可用状态。 */
async function main() {
  let browser;
  let context;
  try {
    if (!process.env.PRODUCT_FILTER_BROWSER_WS) throw new Error('需要专用临时浏览器地址');
    const { chromium } = require('playwright-core');
    browser = await chromium.connectOverCDP(process.env.PRODUCT_FILTER_BROWSER_WS);
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-token'));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const queries = [];
    const writes = [];
    const label = 'iPhone 18 Pro Max 512GB 勃艮第酒红色';
    const key = 'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478';
    let mode = 'orders';
    let zero = false;
    let fail = false;
    const products = [
      { name: label, model: 'MJYD4CH/A', quantity: 1, filterKeys: [key] },
      {
        name: '配件',
        quantity: 1,
        filterKeys: ['name:' + 'a'.repeat(64)],
        filterNeedsReview: true,
      },
    ];
    const options = () => {
      if (zero) return [];
      return [
        {
          value: key,
          label: `${label} · MJYD4CH/A`,
          keys: [key],
          aliases: ['iPhone 18 Pro Max 勃艮第酒红色 512G'],
          count: 1,
        },
      ];
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        if (route.request().method() !== 'GET') writes.push(url.pathname);
        let data = {};
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: 'synthetic',
            role: mode === 'payment-dispatch' ? 'admin' : 'operator',
            permissions: ['orders.read', 'payment_dispatch.read', 'payment_tasks.read_own'],
            availableHome: `/${mode}`,
          };
        else if (url.pathname === '/api/orders/filter-options')
          data = { productOptions: options(), recipientTags: [], stores: [] };
        else if (url.pathname === '/api/system/auto-refresh')
          data = { isRunning: false, pauseReason: '代理池耗尽' };
        else if (url.pathname === '/api/payment-dispatch/overview')
          data = { settings: { enabled: false, mode: 'manual', version: 0 }, staff: [] };
        else if (
          ['/api/orders', '/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(
            url.pathname
          )
        ) {
          queries.push(Object.fromEntries(url.searchParams));
          if (fail) {
            await route.fulfill({
              status: 503,
              json: { success: false, error: { message: '合成查询失败' } },
            });
            return;
          }
          if (url.pathname === '/api/orders') {
            const order = {
              id: 1,
              order_number: 'W1234567890',
              products,
              status: 'pending',
              validation_status: 'unavailable',
              order_date: '2026-09-19T01:00:00Z',
            };
            data = { orders: zero ? [] : [order], total: zero ? 0 : 1 };
          } else {
            const task = {
              id: 1,
              orderId: 1,
              orderNumber: 'W1234567890',
              products,
              processingStatus: 'pending',
              officialOrderStatus: 'pending',
              officialPaymentStatus: 'unknown',
              orderDate: '2026-09-19T01:00:00Z',
              deadlineAt: null,
              version: 0,
              autoAssignment: {},
            };
            data = {
              items: zero ? [] : [task],
              pagination: { page: 1, limit: 20, total: zero ? 0 : 1, totalPages: zero ? 0 : 1 },
              productOptions: options(),
              recipientTagOptions: [],
              serverTime: new Date().toISOString(),
            };
          }
        }
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    for (mode of ['orders', 'payment-dispatch', 'payment-tasks']) {
      zero = false;
      fail = false;
      queries.length = 0;
      await page.goto(`http://127.0.0.1:5173/${mode}`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '商品信息筛选', exact: true }).waitFor();
      if (mode !== 'orders')
        await page.getByPlaceholder('订单号', { exact: true }).fill('尚未提交');
      await page.getByRole('button', { name: '商品信息筛选', exact: true }).click();
      await page.getByPlaceholder('搜索 商品', { exact: true }).fill('勃艮第酒红色 512G');
      const nextResponse = page.waitForResponse(
        response =>
          response.url().includes('productKeys=') && !response.url().includes('filter-options')
      );
      await page.getByRole('option', { name: /MJYD4CH\/A/ }).click();
      await nextResponse;
      await page.keyboard.press('Escape');
      assert.deepEqual(JSON.parse(queries.at(-1).productKeys), [key]);
      if (mode !== 'orders') {
        assert(!queries.at(-1).orderNumber, '商品即时筛选不能带入其他未提交草稿');
        assert(await page.getByText('其他条件待应用，请点击筛选').isVisible());
      }
      await page.locator('tbody').getByText(`${label} ×1`, { exact: true }).waitFor();
      assert((await page.locator('tbody .bg-primary-light').count()) > 0, '应高亮命中商品');
      assert(
        await page.locator('tbody').getByText('配件 ×1', { exact: true }).isVisible(),
        '仍展示未命中商品'
      );
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        if (mode === 'payment-tasks' && width < 768)
          await page.getByRole('button', { name: '筛选任务', exact: true }).click();
        await page.getByRole('button', { name: '商品信息筛选', exact: true }).click();
        const box = await page.getByRole('listbox').boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width + 1, `${mode} ${width} 下拉不越界`);
        await page.screenshot({ path: `/tmp/product-filter-${mode}-${width}.png` });
        await page.keyboard.press('Escape');
      }
      zero = true;
      if (mode === 'orders')
        await page.getByPlaceholder('搜索订单号、Apple ID 或取机人...').fill('none');
      else await page.getByRole('button', { name: '筛选', exact: true }).click();
      await page.getByText('W1234567890', { exact: true }).waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '商品信息筛选', exact: true }).click();
      assert(
        await page.getByRole('option', { name: /MJYD4CH\/A.*（0）/ }).isVisible(),
        '保留零结果已选商品'
      );
      await page.keyboard.press('Escape');
      fail = true;
      zero = false;
      if (mode === 'orders')
        await page.getByPlaceholder('搜索订单号、Apple ID 或取机人...').fill('error');
      else {
        await page.getByPlaceholder('订单号', { exact: true }).fill('error');
        await page.getByRole('button', { name: '筛选', exact: true }).click();
      }
      await page.getByText('合成查询失败', { exact: false }).first().waitFor();
      assert.equal(
        await page.getByText('W1234567890', { exact: true }).count(),
        0,
        '失败时不能显示旧结果冒充新条件'
      );
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, [], '不得触发官网刷新或业务写入');
    process.stdout.write(
      '三页即时筛选、别名搜索、多商品高亮、零结果保留、375/768/1440px 验证通过\n'
    );
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

main();
