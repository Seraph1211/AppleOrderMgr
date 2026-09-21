/* eslint-disable camelcase -- 合成 API 数据遵循响应契约 */
/* global localStorage, document, navigator, getComputedStyle */
const assert = require('node:assert/strict');
const logger = require('../src/utils/logger');

/** 使用独立浏览器和合成 API 验证订单列表及单行刷新。 */
async function main() {
  let browser;
  let context;
  try {
    if (!process.env.ORDERS_BROWSER_WS) throw new Error('需要专用临时浏览器地址');
    const { chromium } = require('playwright-core');
    browser = await chromium.connectOverCDP(process.env.ORDERS_BROWSER_WS, {
      headers: { Host: process.env.ORDERS_BROWSER_HOST_HEADER || '127.0.0.1' },
      timeout: 15000,
    });
    context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    let permissionMode = 'refresh';
    let submits = 0;
    let mailSubmits = 0;
    let polls = 0;
    let outcome = 'succeeded';
    let timestamp = '2026-09-09T00:00:00Z';
    let latestOrderQuery = new URLSearchParams();
    let latestExportQuery = new URLSearchParams();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: 'synthetic',
            role: 'readOnly',
            permissions:
              permissionMode === 'refresh'
                ? ['orders.read', 'orders.refresh', 'order_mail.manage']
                : permissionMode === 'export'
                  ? ['orders.read', 'orders.export']
                  : ['orders.read'],
            availableHome: '/orders',
          };
        else if (url.pathname === '/api/orders/filter-options')
          data = {
            productNames: ['iPhone 18 Pro Max 512GB 勃艮第酒红色'],
            productOptions: [
              {
                value:
                  'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478',
                label: 'iPhone 18 Pro Max 512GB 勃艮第酒红色',
                aliases: [],
                count: 1,
              },
            ],
            productModels: ['MODEL-18'],
            stores: ['Apple Store 零售店'],
            recipients: [],
            payers: [],
          };
        else if (url.pathname === '/api/system/auto-refresh') data = { isRunning: false };
        else if (url.pathname === '/api/orders/export') {
          latestExportQuery = new URLSearchParams(url.searchParams);
          await route.fulfill({
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            headers: { 'Content-Disposition': 'attachment; filename="orders.xlsx"' },
            body: Buffer.from('synthetic-xlsx'),
          });
          return;
        } else if (url.pathname === '/api/orders') {
          latestOrderQuery = new URLSearchParams(url.searchParams);
          data = {
            total: 1,
            orders: [
              {
                id: 1,
                order_number: 'W1234567890',
                apple_id: 'snapshot@example.test',
                recipient_name: '邮件取机人',
                recipient_tag: '测试标签',
                recipient_phone: '13800138000',
                recipient_email: 'order-contact@example.test',
                status: 'payment_due',
                products: [{ name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', quantity: 2 }],
                pickup_store: 'Apple Store 零售店',
                official_status_observed_at: '2026-09-18T01:02:36+08:00',
                official_fulfillment_message: '请于 明天 的 19:15 – 19:30 之间到店签到',
                pickup_time: '2026/09/19 19:15 – 19:30',
                official_pickup_date: '2026/09/19',
                official_pickup_time_slot: '19:15 – 19:30',
                official_products: [
                  {
                    name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色',
                    quantity: 2,
                    pickupTime: '2026/09/19 19:15 – 19:30',
                    fulfillmentMessage: '请于 明天 的 19:15 – 19:30 之间到店签到',
                  },
                ],
                validation_status: 'abnormal',
                validation_issues: [{ message: '合成商品信息需要核对' }],
                last_crawled_at: timestamp,
                email_lifecycle_updated_at: '2026-09-21T03:04:05Z',
                updated_at: '2030-01-01T00:00:00Z',
                refresh: { freshness_status: 'fresh' },
              },
            ],
          };
        } else if (url.pathname === '/api/orders/1/link') {
          data = {
            id: 1,
            orderNumber: 'W1234567890',
            orderUrl: 'https://secure.example.invalid/order/W1234567890',
          };
        } else if (url.pathname === '/api/orders/1/refresh') {
          submits += 1;
          polls = 0;
          data = { jobId: submits, status: 'pending' };
        } else if (url.pathname === '/api/orders/1/email-lifecycle/replay') {
          mailSubmits += 1;
          data = {
            mode: 'shadow',
            results: [
              { orderId: 1, messageCount: 3, enqueued: 3, active: 0, expired: 0 },
            ],
            totals: {
              orders: 1,
              messages: 3,
              enqueued: 3,
              active: 0,
              expired: 0,
              withoutMail: 0,
            },
          };
        } else if (url.pathname === '/api/orders/email-lifecycle/replay') {
          mailSubmits += 1;
          assert.deepEqual(JSON.parse(route.request().postData()).orderIds, [1]);
          data = {
            mode: 'shadow',
            results: [
              { orderId: 1, messageCount: 3, enqueued: 3, active: 0, expired: 0 },
            ],
            totals: {
              orders: 1,
              messages: 3,
              enqueued: 3,
              active: 0,
              expired: 0,
              withoutMail: 0,
            },
          };
        } else if (url.pathname === '/api/orders/1' && route.request().method() === 'GET') {
          data = {
            id: 1,
            order_number: 'W1234567890',
            ingestion_source: 'aos',
            apple_id: { id: null, apple_id: 'snapshot@example.test', nickname: null },
            recipient: { id: null, name: '邮件取机人', id_card_last4: '1234' },
            recipient_phone: '13800138000',
            recipient_email: 'order-contact@example.test',
            products: [
              { name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', model: 'MODEL-18', quantity: 2 },
            ],
            status: 'payment_due',
            payment_status: 'unpaid',
            pickup_status: 'not_ready',
            pickup_store: 'Apple Store 零售店',
            official_status_observed_at: '2026-09-18T01:02:36+08:00',
            official_fulfillment_message: '请于 明天 的 19:15 – 19:30 之间到店签到',
            pickup_time: '2026/09/19 19:15 – 19:30',
            official_pickup_date: '2026/09/19',
            official_pickup_time_slot: '19:15 – 19:30',
            official_products: [
              {
                name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色',
                quantity: 2,
                pickupTime: '2026/09/19 19:15 – 19:30',
                fulfillmentMessage: '请于 明天 的 19:15 – 19:30 之间到店签到',
              },
            ],
            last_crawled_at: timestamp,
            refresh: { freshness_status: 'fresh' },
          };
        } else if (url.pathname.startsWith('/api/order-refresh/jobs/')) {
          polls += 1;
          const status = polls === 1 ? 'running' : outcome;
          if (status === 'succeeded') timestamp = '2026-09-09T01:00:00Z';
          data = { status, lastErrorMessage: status === 'failed' ? '合成官网超时，可重试' : null };
        } else throw new Error(`未配置路径 ${url.pathname}`);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    await context.addInitScript(() => {
      localStorage.setItem('token', 'synthetic-token');
      localStorage.setItem(
        'columnConfig:orders',
        JSON.stringify({
          columns: [
            { key: 'freshnessStatus', visible: true },
            { key: 'recipientPhone', visible: true },
            { key: 'lastCrawledAt', visible: false },
            { key: 'pickupTime', visible: true },
          ],
        })
      );
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'http://127.0.0.1:5173',
    });
    await page.goto('http://127.0.0.1:5173/orders', { waitUntil: 'networkidle' });
    await page.getByRole('columnheader', { name: '最后更新时间' }).waitFor();
    assert.equal(await page.getByRole('columnheader', { name: '刷新状态' }).count(), 0);
    assert.equal(await page.getByRole('columnheader', { name: '联系电话' }).count(), 0);
    assert.equal(await page.getByRole('columnheader', { name: '校验状态' }).count(), 0);
    assert.equal(await page.getByRole('columnheader', { name: 'Apple ID' }).count(), 0);
    await page.getByRole('columnheader', { name: '取货时间' }).waitFor();
    await page.getByRole('columnheader', { name: 'TAG', exact: true }).waitFor();
    const statusHint = page.getByRole('button', { name: '订单状态说明', exact: true });
    await statusHint.hover();
    await page.getByRole('tooltip').waitFor({ state: 'visible', timeout: 500 });
    assert.match(await page.getByRole('tooltip').innerText(), /订单已确认：已下单，待付款/);
    assert.match(await page.getByRole('tooltip').innerText(), /处理中：订单已付款/);
    assert.match(await page.getByRole('tooltip').innerText(), /可取货：订单可取货/);
    assert.equal(await statusHint.evaluate(element => getComputedStyle(element).cursor), 'default');
    assert.equal(await statusHint.getAttribute('title'), null);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('tooltip').count(), 0);
    const pickupHint = page.getByRole('button', { name: '取货信息说明', exact: true });
    await pickupHint.hover();
    await page.getByRole('tooltip').waitFor({ state: 'visible', timeout: 500 });
    assert.equal(await page.getByRole('tooltip').innerText(), '基于邮件数据更新');
    assert.equal(await pickupHint.evaluate(element => getComputedStyle(element).cursor), 'default');
    assert.equal(await pickupHint.getAttribute('title'), null);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('columnheader', { name: '付款状态' }).count(), 0);
    assert.equal(await page.getByText('付款状态（邮件）', { exact: true }).count(), 0);
    const row = page.locator('tbody tr').first();
    assert.doesNotMatch(await row.innerText(), /snapshot@example.test/);
    assert.match(await row.innerText(), /邮件取机人/);
    assert.match(await row.innerText(), /测试标签/);
    assert.doesNotMatch(await row.innerText(), /2030|13800138000/);
    const rowText = await row.innerText();
    assert.equal(
      await row.getByText('iPhone 18 Pro Max 512GB 勃艮第酒红色 ×2', { exact: true }).count(),
      1,
      rowText
    );
    assert.match(await row.innerText(), /2026\/09\/19 19:15 – 19:30/);
    assert.equal(await row.getByRole('button', { name: '查看 1 项订单冲突' }).count(), 1);
    assert.equal((await row.getAttribute('class')).includes('bg-red'), false);

    const search = page.getByPlaceholder('搜索系统订单 ID、官网订单号、Apple ID 或取机人...');
    const systemIdRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/api/orders' && url.searchParams.get('keyword') === '1';
    });
    await search.fill('1');
    const searchRequest = await systemIdRequest;
    assert.equal(new URL(searchRequest.url()).searchParams.get('keyword'), '1');
    await search.fill('');
    await row.getByRole('button', { name: '复制订单链接 W1234567890' }).click();
    await page.getByText('订单链接已复制', { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      'https://secure.example.invalid/order/W1234567890'
    );

    assert.equal(await page.getByRole('button', { name: '官网状态筛选' }).count(), 0);
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      const fields = await page.locator('.order-filter-fields > div').evaluateAll(elements =>
        elements.filter(element => !element.classList.contains('order-date-filter')).map(element => ({ top: element.getBoundingClientRect().top, text: element.textContent }))
      );
      const pickupTop = await page.locator('input[aria-label="取货日期筛选"]').evaluate(element => element.parentElement.getBoundingClientRect().top);
      assert.equal(fields.filter(field => Math.abs(field.top - pickupTop) < 2).length, 6, width + 'px 六项筛选应在同一行');
    }
    await page.getByRole('button', { name: '邮件订单状态筛选' }).click();
    await page.getByRole('option', { name: '可取货', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '商品信息筛选' }).click();
    const productOption = page.getByRole('option', {
      name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色',
    });
    const productOptionLabel = productOption.locator('span').last();
    assert.equal(
      await productOptionLabel.evaluate(element => element.scrollWidth <= element.clientWidth),
      true
    );
    await productOption.click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '取货门店筛选' }).click();
    await page.getByRole('option', { name: 'Apple Store 零售店' }).click();
    await page.keyboard.press('Escape');
    await page.locator('input[aria-label="取货日期筛选"]').fill('2026-09-19');
    await page.waitForFunction(() => document.querySelector('tbody tr'));
    assert.equal(latestOrderQuery.has('statuses'), false);
    assert.deepEqual(JSON.parse(latestOrderQuery.get('emailOrderStatuses')), ['ready_for_pickup']);
    assert.deepEqual(JSON.parse(latestOrderQuery.get('productKeys')), [
      'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478',
    ]);
    assert.deepEqual(JSON.parse(latestOrderQuery.get('pickupStores')), ['Apple Store 零售店']);
    assert.equal(latestOrderQuery.get('pickupDate'), '2026-09-19');

    await row.getByRole('button', { name: '查看', exact: true }).click();
    await page.getByRole('heading', { name: '订单详情' }).waitFor();
    assert.equal(await page.getByText('Apple ID', { exact: true }).count(), 1);
    assert.equal(await page.getByText('snapshot@example.test', { exact: true }).count(), 1);
    assert.equal(await page.getByText('下单手机号', { exact: true }).count(), 1);
    assert.equal(await page.getByText('13800138000', { exact: true }).count(), 1);
    assert.equal(await page.getByText('下单邮箱', { exact: true }).count(), 1);
    assert.equal(await page.getByText('order-contact@example.test', { exact: true }).count(), 1);
    assert.equal(await page.getByText('2026/09/19', { exact: true }).count(), 1);
    assert.equal(await page.getByText('19:15 – 19:30', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    const headers = (await page.locator('thead th').allTextContents()).map(text => text.trim());
    const lastUpdatedColumn = headers.indexOf('最后更新时间');
    assert.ok(lastUpdatedColumn >= 0);
    const initialTime = await row.locator('td').nth(lastUpdatedColumn).innerText();
    await row.getByRole('button', { name: '刷新官网 W1234567890' }).click();
    assert.equal(await row.getByRole('button', { name: '排队中 W1234567890' }).isDisabled(), true);
    await row.getByRole('button', { name: '刷新中 W1234567890' }).waitFor();
    await row.getByText('刷新成功', { exact: true }).waitFor();
    assert.equal(await row.locator('td').nth(lastUpdatedColumn).innerText(), initialTime);
    assert.equal(submits, 1);
    await page.screenshot({ path: '/tmp/orders-browser-desktop.png', fullPage: true });
    outcome = 'failed';
    const successTime = await row.locator('td').nth(lastUpdatedColumn).innerText();
    await row.getByRole('button', { name: '刷新官网 W1234567890' }).click();
    await row.locator('summary').waitFor();
    await row.locator('summary').click();
    await row.getByText('合成官网超时，可重试').waitFor();
    assert.equal(await row.locator('td').nth(lastUpdatedColumn).innerText(), successTime);
    assert.equal(await row.getByRole('button', { name: '刷新官网 W1234567890' }).isEnabled(), true);
    await row.getByRole('button', { name: '刷新邮件状态 W1234567890' }).click();
    await page.getByText(/当前为影子模式，解析结果不会写入订单状态/).waitFor();
    const mailSelection = page.getByRole('checkbox', { name: '选择订单 W1234567890' });
    await mailSelection.check();
    await page.getByRole('button', { name: '批量刷新邮件状态' }).click();
    await page.getByText(/已为 1 个订单提交 3 封邮件/).waitFor();
    assert.equal(mailSubmits, 2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => document.querySelector('aside').getBoundingClientRect().right <= 0
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    const button = row.getByRole('button', { name: '刷新官网 W1234567890' });
    const bounds = await button.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await page.screenshot({ path: '/tmp/orders-browser-mobile.png', fullPage: true });
    permissionMode = 'export';
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: /刷新官网 W/ }).count(), 0);
    const selection = page.getByRole('checkbox', { name: '选择订单 W1234567890' });
    await selection.check();
    await page.getByRole('button', { name: '导出选中订单' }).click();
    await page.getByRole('heading', { name: '导出选中订单' }).waitFor();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 Excel' }).click();
    await download;
    assert.deepEqual(JSON.parse(latestExportQuery.get('orderIds')), [1]);
    assert.ok(JSON.parse(latestExportQuery.get('fields')).includes('systemOrderId'));
    assert.equal(await page.getByRole('button', { name: '批量刷新官网' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '批量刷新邮件状态' }).count(), 0);

    permissionMode = 'read';
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('checkbox', { name: '选择订单 W1234567890' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '导出选中订单' }).count(), 0);
    await page.goto('http://127.0.0.1:5173/orders/1', { waitUntil: 'networkidle' });
    try {
      await page.getByRole('heading', { name: '订单详情' }).waitFor();
    } catch (error) {
      throw new Error(
        `${error.message}\n页面内容：${await page.locator('body').innerText()}\n请求错误：${errors.join('；')}`
      );
    }
    assert.equal(await page.getByText('下单手机号', { exact: true }).count(), 1);
    assert.equal(await page.getByText('下单邮箱', { exact: true }).count(), 1);
    assert.equal(await page.getByText('order-contact@example.test', { exact: true }).count(), 1);
    assert.equal(await page.getByText('预约取货日期', { exact: true }).count(), 1);
    assert.equal(await page.getByText('预约时段：19:15 – 19:30', { exact: true }).count(), 1);
    assert.equal(submits, 2);
    assert.deepEqual(errors, []);
    logger.info('订单列表浏览器验证通过', {
      checks: [
        '旧列配置迁移',
        '邮件信息',
        '商品数量',
        '邮件状态商品门店多选和取货日期筛选',
        '官网状态筛选移除与桌面六项同排',
        '取货时间提取展示',
        '校验与 Apple ID 主表移除',
        '异常图标保留且行不标红',
        '弹窗和独立详情下单联系方式及绝对预约时间',
        '邮件更新时间不受官网刷新影响',
        '排队执行成功',
        '失败可重试',
        '窄屏固定操作',
        '系统订单 ID 搜索',
        '官网订单号复制链接',
        '导出权限独立于刷新权限',
        '只读权限',
      ],
      submits,
      mailSubmits,
    });
  } catch (error) {
    logger.error('订单列表浏览器验证失败', { error: error.message, stack: error.stack });
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}
main();
