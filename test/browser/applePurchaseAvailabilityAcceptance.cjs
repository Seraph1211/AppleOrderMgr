/* global document, innerWidth */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const root = process.env.AVAILABILITY_BROWSER_URL || 'http://127.0.0.1:4178';
const routePath = '/inventory/availability';
const apiPrefix = '/api/public/apple-purchase-availability';
const terminalId = '00000000-0000-4000-8000-000000000001';
const HOUR = 3_600_000;
const SAMPLE_COUNT = 245;
const latest = Math.floor(Date.now() / HOUR) * HOUR;
const rows = Array.from({ length: SAMPLE_COUNT }, (_, index) => {
  const time = new Date(latest - index * 1000).toISOString();
  return {
    sequence: String(SAMPLE_COUNT - index),
    id: `fixture-${index}`,
    detectedAt: time,
    ingestedAt: time,
    terminalId,
    city: '上海',
    storeId: 'fixture-store',
    store: '合成门店',
    family: 'iphone_duo',
    color: index % 2 ? '夜空色' : '星光白色',
    storage: '256GB',
    productName: 'iPhone Duo 256GB',
    partNumber: 'FIXTURE-PART',
  };
});
const catalog = {
  snapshot: String(SAMPLE_COUNT),
  firstDetectedAt: rows.at(-1).detectedAt,
  lastDetectedAt: rows[0].detectedAt,
  lastSyncAt: rows[0].ingestedAt,
  cities: ['上海'],
  families: ['iphone_duo'],
  colors: ['星光白色', '夜空色'],
  capacities: ['256GB'],
  stores: [{ id: 'fixture-store', city: '上海', name: '合成门店' }],
  terminals: [{ id: terminalId, name: '合成同步终端' }],
};

async function installRoutes(page) {
  const requests = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    assert.ok(url.pathname.startsWith(apiPrefix + '/'), url.pathname);
    requests.push(url);
    assert.equal(route.request().method(), 'GET');
    assert.equal(route.request().headers().authorization, undefined);
    if (url.pathname === `${apiPrefix}/events`) {
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: inventory-version\ndata: {"observations":"246","monitorChanges":"0"}\n\n',
      });
    }
    if (url.pathname.endsWith('/options')) return route.fulfill({ json: catalog });
    if (url.pathname.endsWith('/changes')) {
      const cursor = url.searchParams.get('cursor');
      return route.fulfill({
        json: {
          snapshot: '1',
          items: [
            {
              sequence: '1',
              changedAt: rows[0].detectedAt,
              changeType: 'configuration_updated',
              terminal: '终端示例',
              previousRevision: 1,
              revision: 2,
              changes: [{ kind: 'products', before: 1, after: 2, added: 1, removed: 0 }],
            },
          ],
          nextCursor: cursor ? null : 'next-changes',
        },
      });
    }
    const params = url.searchParams;
    assert.equal(params.get('snapshot'), catalog.snapshot);
    const matches = rows.filter(row =>
      ['city', 'storeId', 'family', 'color', 'storage', 'terminalId'].every(
        key => !params.has(key) || params.getAll(key).includes(row[key])
      )
    );
    if (url.pathname.endsWith('/trend')) {
      const interval = params.get('interval');
      const offset = interval === 'day' ? 8 * HOUR : 0;
      const step = interval === 'day' ? 24 * HOUR : HOUR;
      const totals = new Map();
      for (const row of matches) {
        const bucket = Math.floor((Date.parse(row.detectedAt) + offset) / step) * step - offset;
        totals.set(bucket, (totals.get(bucket) || 0) + 1);
      }
      return route.fulfill({
        json: {
          points: [...totals].map(([time, count]) => ({
            time: new Date(time).toISOString(),
            family: 'iphone_duo',
            count,
          })),
        },
      });
    }
    const limit = Number(params.get('limit'));
    const start = Number(params.get('cursor') || 0);
    return route.fulfill({
      json: {
        total: matches.length,
        items: matches.slice(start, start + limit),
        nextCursor: start + limit < matches.length ? String(start + limit) : null,
      },
    });
  });
  return requests;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1440, 768, 390, 320]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        hasTouch: width < 600,
      });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const requests = await installRoutes(page);
      await page.goto(`${root}${routePath}`);
      await page.getByText(`${SAMPLE_COUNT} 条`, { exact: true }).waitFor();
      await page.getByRole('button', { name: '有新记录，刷新' }).waitFor();
      assert.equal(await page.locator('tbody tr').count(), 20);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width < 600) await page.getByRole('button', { name: '筛选', exact: true }).tap();
      await page.getByRole('button', { name: /^选择机型，/ }).click();
      await page.getByRole('checkbox', { name: 'iPhone Duo', exact: true }).check();
      await page.getByRole('button', { name: '完成' }).click();
      assert.equal(await page.getByRole('button', { name: /锁定/ }).count(), 0);
      await page.getByRole('button', { name: /^选择颜色，/ }).click();
      await page.getByRole('checkbox', { name: '星光白色', exact: true }).check();
      await page.getByRole('checkbox', { name: '夜空色', exact: true }).check();
      await page.getByRole('button', { name: '完成' }).click();
      if (width < 600) await page.getByRole('button', { name: '查看结果' }).tap();
      if (width === 1440) {
        await page.getByRole('combobox', { name: '每页条数' }).selectOption('200');
        await page.locator('tbody tr').nth(199).waitFor();
        await page.getByRole('button', { name: '下一页' }).click();
        await page.getByText('第 201–245 条，共 245 条', { exact: true }).waitFor();
        assert.ok(requests.some(url => url.searchParams.get('cursor') === '200'));
      }
      await page.getByRole('tab', { name: '趋势统计' }).click();
      await page.getByText('匹配记录 245 次 · 北京时间').waitFor();
      await page.getByRole('button', { name: '按天' }).click();
      await page.getByText('匹配记录 245 次 · 北京时间').waitFor();
      const trend = requests.filter(url => url.pathname.endsWith('/trend')).at(-1);
      assert.equal(trend.searchParams.get('interval'), 'day');
      assert.equal(trend.searchParams.get('family'), 'iphone_duo');
      assert.deepEqual(trend.searchParams.getAll('color'), ['星光白色', '夜空色']);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.getByRole('tab', { name: '检测任务配置变更' }).click();
      await page.getByText('监控料号 1 → 2（新增 1）').waitFor();
      await page.getByRole('button', { name: '下一页' }).click();
      await page.getByRole('button', { name: '下一页' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '下一页' }).isDisabled(), true);
      await page.getByRole('tab', { name: '有货明细' }).click();
      await page.getByText(`${SAMPLE_COUNT} 条`, { exact: true }).waitFor();
      if (width < 600) await page.getByRole('button', { name: '筛选 (2)', exact: true }).waitFor();
      await page.close();
    }
    process.stdout.write('独立有货记录浏览器验收通过\n');
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
