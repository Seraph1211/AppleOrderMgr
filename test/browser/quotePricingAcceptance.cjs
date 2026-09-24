/* global localStorage, document, window */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const BASE_URL = process.env.QUOTE_BROWSER_URL || 'http://127.0.0.1:5173';
const OUTPUT_DIR = process.env.QUOTE_BROWSER_OUTPUT || '/tmp/apple-quote-pricing-acceptance';

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
  await context.addInitScript(() => localStorage.setItem('token', 'synthetic-quote-token'));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  const writes = [];
  const orderWrites = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  let version = 3;
  let publicEnabled = true;
  let authMeCalls = 0;
  let adjustments = { black: { percentage: 0, fixedAmount: 0 } };
  const now = new Date().toISOString();
  const publicItems = [
    {
      productKey: 'a'.repeat(40),
      productName: 'iPhone 18 Pro 256GB 黑色',
      productModel: '18 Pro',
      storageGb: 256,
      color: '黑色',
      quotePrice: 9800,
      officialPrice: 9999,
    },
    {
      productKey: 'b'.repeat(40),
      productName: 'iPhone 18 Pro Max 256GB 银色',
      productModel: '18 Pro Max',
      storageGb: 256,
      color: '银色',
      quotePrice: 11200,
      officialPrice: 10999,
    },
  ];

  function adminItems() {
    return publicItems.map((item, index) => {
      const adjustment = index === 0 ? adjustments.black : { percentage: 0, fixedAmount: 0 };
      const basePrice = index === 0 ? 9800 : 11200;
      return {
        ...item,
        specCode: index === 0 ? 'TQ4/T74' : 'YQ4/Y74',
        basePrice,
        percentage: adjustment.percentage,
        fixedAmount: adjustment.fixedAmount,
        quotePrice: Math.round(
          basePrice * (1 + adjustment.percentage / 100) + adjustment.fixedAmount
        ),
      };
    });
  }

  await page.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      if (url.origin === BASE_URL) return route.continue();
      return route.abort();
    }
    const method = request.method();
    let data;
    if (url.pathname === '/api/auth/me') {
      authMeCalls += 1;
      data = {
        id: 1,
        username: 'quote-admin',
        nickname: '报价管理员',
        role: 'admin',
        status: 'active',
        permissions: [],
        permissionsVersion: 1,
        availableHome: '/profile',
      };
    } else if (url.pathname === '/api/public/apple-quotes') {
      assert.equal(request.headers().authorization, undefined);
      data = {
        enabled: true,
        updatedAt: now,
        stale: false,
        filters: {
          productModels: ['18 Pro', '18 Pro Max'],
          storageGb: [256],
          colors: ['黑色', '银色'],
        },
        items: publicItems,
      };
    } else if (url.pathname === '/api/quote-pricing/iphone18' && method === 'GET') {
      data = {
        publicEnabled,
        version,
        publicPath: '/quote/apple',
        sourceUpdatedAt: now,
        lastCheckedAt: now,
        defaultOrder: ['a'.repeat(40), 'b'.repeat(40)],
        items: adminItems(),
      };
    } else if (url.pathname === '/api/quote-pricing/iphone18/versions') {
      data = {
        items: [
          {
            id: '10000000-0000-4000-8000-000000000001',
            revision: 2,
            action: 'bulk_adjust',
            summary: { itemCount: 1 },
            actorName: '报价管理员',
            createdAt: now,
          },
        ],
      };
    } else if (url.pathname === '/api/quote-pricing/iphone18/adjustments' && method === 'PUT') {
      const body = request.postDataJSON();
      assert.equal(body.productKeys.length, 2);
      assert.equal(body.percentage, 5);
      assert.equal(body.fixedAmount, -100);
      assert.equal(body.expectedVersion, version);
      writes.push(body);
      adjustments = { black: { percentage: 5, fixedAmount: -100 } };
      version += 1;
      data = { version, selectedCount: 2 };
    } else if (
      url.pathname === '/api/quote-pricing/iphone18/display-order' &&
      method === 'PUT'
    ) {
      const body = request.postDataJSON();
      assert.equal(body.expectedVersion, version);
      assert.deepEqual(body.productKeys, ['b'.repeat(40), 'a'.repeat(40)]);
      orderWrites.push(body);
      publicItems.reverse();
      version += 1;
      data = { version, itemCount: 2 };
    } else if (url.pathname.endsWith('/availability') && method === 'PUT') {
      const body = request.postDataJSON();
      assert.equal(body.expectedVersion, version);
      publicEnabled = body.enabled;
      version += 1;
      data = { publicEnabled, version, publicPath: '/quote/apple' };
    } else if (url.pathname.endsWith('/adjustments/reset') && method === 'POST') {
      const body = request.postDataJSON();
      assert.equal(body.expectedVersion, version);
      version += 1;
      data = { version, selectedCount: body.productKeys.length, removedCount: 1 };
    } else if (url.pathname.includes('/versions/') && url.pathname.endsWith('/restore')) {
      const body = request.postDataJSON();
      assert.equal(body.expectedVersion, version);
      version += 1;
      data = { version, restoredFromRevision: 2, restoredCount: 1 };
    } else {
      throw new Error(`未处理的合成接口：${method} ${url.pathname}`);
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
  });

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  await page.goto(`${BASE_URL}/quote/iphone18`);
  await page.waitForURL(`${BASE_URL}/quote/apple`);
  await page.getByRole('heading', { name: 'Apple 实时报价' }).waitFor();
  assert.equal(await page.getByText('Apple 报价', { exact: true }).count(), 1);
  assert.equal(await page.getByText('页面仅展示对外报价', { exact: true }).count(), 0);
  assert.equal(await page.getByText('公开报价 · 人民币计价', { exact: true }).count(), 0);
  assert.equal(
    await page
      .getByText('覆盖 iPhone 18 Pro 与 iPhone 18 Pro Max，价格自动更新。', {
        exact: true,
      })
      .count(),
    0
  );
  assert.equal(await page.getByText('报价更新：', { exact: false }).count(), 1);
  assert.equal(authMeCalls, 0, '公开报价页不应触发登录会话检查');
  await page.getByText('iPhone 18 Pro 256GB 黑色', { exact: true }).waitFor();
  assert.equal(await page.getByText('¥9,800', { exact: true }).count(), 1);
  assert.equal(await page.getByText('明威', { exact: false }).count(), 0);
  await page.getByLabel('型号').selectOption('18 Pro Max');
  assert.equal(await page.getByText('iPhone 18 Pro 256GB 黑色', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '复制当前报价' }).click();
  await page.getByRole('button', { name: '已复制' }).waitFor();
  await page.screenshot({ path: `${OUTPUT_DIR}/public-desktop.png`, fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await page.getByRole('heading', { name: 'Apple 实时报价' }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${OUTPUT_DIR}/public-mobile.png`, fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE_URL}/quote-pricing`);
  await page.getByRole('heading', { name: 'Apple 报价管理' }).waitFor();
  await page.getByText('/quote/apple', { exact: false }).waitFor();
  assert.ok(authMeCalls > 0, '后台报价页应检查登录会话');
  await page
    .getByLabel('拖动 iPhone 18 Pro 256GB 黑色 调整顺序')
    .dragTo(page.getByLabel('拖动 iPhone 18 Pro Max 256GB 银色 调整顺序'));
  await page.getByRole('button', { name: '保存展示顺序' }).click();
  await page.getByText('展示顺序已保存，公开报价页面立即生效。').waitFor();
  assert.equal(orderWrites.length, 1);
  await page.goto(`${BASE_URL}/quote/apple`);
  const firstPublicProduct = page.locator('tbody tr').first().locator('td').first();
  await firstPublicProduct.getByText('iPhone 18 Pro Max 256GB 银色', { exact: true }).waitFor();
  await page.goto(`${BASE_URL}/quote-pricing`);
  await page.getByRole('heading', { name: 'Apple 报价管理' }).waitFor();
  await page.getByRole('button', { name: '选择全部商品' }).click();
  await page.getByLabel('百分比调整').fill('5');
  await page.getByLabel('固定金额调整').fill('-100');
  await page.getByRole('button', { name: '应用到 2 款' }).click();
  await page.getByText('已更新 2 款商品，公开报价立即生效。').waitFor();
  assert.equal(writes.length, 1);
  await page.getByRole('button', { name: '暂停公开' }).click();
  await page.getByText('公开报价链接已暂停。').waitFor();
  await page.screenshot({ path: `${OUTPUT_DIR}/admin-desktop.png`, fullPage: true });

  assert.deepEqual(pageErrors, []);
  await browser.close();
  process.stdout.write(`公开报价浏览器验收通过：${OUTPUT_DIR}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
