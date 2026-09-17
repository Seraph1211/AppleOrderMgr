/* eslint-disable camelcase -- 合成 API 数据遵循响应契约 */
/* global localStorage, document */
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
    let permitted = true;
    let submits = 0;
    let polls = 0;
    let outcome = 'succeeded';
    let timestamp = '2026-09-09T00:00:00Z';
    let latestOrderQuery = new URLSearchParams();
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
            permissions: permitted ? ['orders.read', 'orders.refresh'] : ['orders.read'],
            availableHome: '/orders',
          };
        else if (url.pathname === '/api/orders/filter-options')
          data = {
            productNames: ['iPhone 18 Pro Max 512GB 勃艮第酒红色'],
            productModels: ['MODEL-18'],
            stores: ['Apple Store 零售店'],
            recipients: [],
            payers: [],
          };
        else if (url.pathname === '/api/system/auto-refresh') data = { isRunning: false };
        else if (url.pathname === '/api/orders') {
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
                updated_at: '2030-01-01T00:00:00Z',
                refresh: { freshness_status: 'fresh' },
              },
            ],
          };
        } else if (url.pathname === '/api/orders/1/refresh') {
          submits += 1;
          polls = 0;
          data = { jobId: submits, status: 'pending' };
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
          ],
        })
      );
    });
    await page.goto('http://127.0.0.1:5173/orders', { waitUntil: 'networkidle' });
    await page.getByRole('columnheader', { name: '最后更新时间' }).waitFor();
    assert.equal(await page.getByRole('columnheader', { name: '刷新状态' }).count(), 0);
    assert.equal(await page.getByRole('columnheader', { name: '联系电话' }).count(), 0);
    assert.equal(await page.getByRole('columnheader', { name: '校验状态' }).count(), 0);
    assert.equal(await page.getByRole('columnheader', { name: 'Apple ID' }).count(), 0);
    await page.getByRole('columnheader', { name: '取货时间' }).waitFor();
    await page.getByRole('columnheader', { name: '取机人标签' }).waitFor();
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

    await page.getByRole('button', { name: '官网状态筛选' }).click();
    await page.getByRole('option', { name: '等待付款' }).click();
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
    assert.deepEqual(JSON.parse(latestOrderQuery.get('statuses')), ['payment_due']);
    assert.deepEqual(JSON.parse(latestOrderQuery.get('productNames')), [
      'iPhone 18 Pro Max 512GB 勃艮第酒红色',
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
    await row.getByRole('button', { name: '手动刷新 W1234567890' }).click();
    assert.equal(await row.getByRole('button', { name: '排队中 W1234567890' }).isDisabled(), true);
    await row.getByRole('button', { name: '刷新中 W1234567890' }).waitFor();
    await row.getByText('刷新成功', { exact: true }).waitFor();
    await page.waitForFunction(() =>
      document.querySelector('tbody tr').textContent.includes('9:00:00')
    );
    assert.notEqual(await row.locator('td').nth(lastUpdatedColumn).innerText(), initialTime);
    assert.equal(submits, 1);
    await page.screenshot({ path: '/tmp/orders-browser-desktop.png', fullPage: true });
    outcome = 'failed';
    const successTime = await row.locator('td').nth(lastUpdatedColumn).innerText();
    await row.getByRole('button', { name: '手动刷新 W1234567890' }).click();
    await row.getByText('合成官网超时，可重试').waitFor();
    assert.equal(await row.locator('td').nth(lastUpdatedColumn).innerText(), successTime);
    assert.equal(await row.getByRole('button', { name: '手动刷新 W1234567890' }).isEnabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => document.querySelector('aside').getBoundingClientRect().right <= 0
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    const button = row.getByRole('button', { name: '手动刷新 W1234567890' });
    const bounds = await button.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await page.screenshot({ path: '/tmp/orders-browser-mobile.png', fullPage: true });
    permitted = false;
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: /手动刷新/ }).count(), 0);
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
        '状态商品门店多选和取货日期筛选',
        '取货时间提取展示',
        '校验与 Apple ID 主表移除',
        '异常图标保留且行不标红',
        '弹窗和独立详情下单联系方式及绝对预约时间',
        '官网更新时间',
        '排队执行成功',
        '失败可重试',
        '窄屏固定操作',
        '只读权限',
      ],
      submits,
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
