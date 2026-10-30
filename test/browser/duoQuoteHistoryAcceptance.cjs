/* global document, window */
/* eslint-disable no-magic-numbers -- 固定合成时间与响应式视口。 */
/* eslint-disable no-console -- CLI验收脚本需要输出执行结果。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const baseUrl = process.env.DUO_HISTORY_BROWSER_URL || 'http://127.0.0.1:5173';
const output = process.env.DUO_HISTORY_BROWSER_OUTPUT || '/tmp/apple-duo-history-browser';
fs.mkdirSync(output, { recursive: true });

async function chooseRange(page, label) {
  await page.getByRole('button', { name: /时间范围，?/ }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

function points(offset) {
  return [
    { changedAt: '2026-10-24T00:00:00.000Z', price: 16000 + offset, baseline: true },
    { changedAt: '2026-10-28T08:00:00.000Z', price: 16100 + offset, baseline: false },
  ];
}

function response(range = '7d') {
  return {
    enabled: true,
    version: 2,
    range,
    rangeStart: '2026-10-24T00:00:00.000Z',
    rangeEnd: '2026-10-30T06:00:00.000Z',
    availableFrom: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-30T05:03:56.000Z',
    lastCheckedAt: '2026-10-30T05:04:00.000Z',
    stale: false,
    capacities: [256, 512, 1024, 2048].map((storageGb, index) => ({
      storageGb,
      retailSeries: [
        {
          key: 'retail-midnight',
          label: '夜空色零售价',
          productKey: `midnight-${storageGb}`,
          productName: `iPhone Duo 夜空色 ${storageGb}G`,
          color: '夜空色',
          points: points(index * 1000),
        },
        {
          key: 'retail-starlight',
          label: '星光白色零售价',
          productKey: `starlight-${storageGb}`,
          productName: `iPhone Duo 星光白色 ${storageGb}G`,
          color: '星光白色',
          points: points(index * 1000 - 100),
        },
      ],
      officialSeries: [
        { key: 'official', label: '官网价', color: null, points: points(index * 1000 - 500) },
      ],
    })),
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10000);
    await page.clock.install();
    await page.addInitScript(() => {
      window.EventSource = class extends window.EventTarget {
        constructor(url) {
          super();
          this.url = url;
          window.__historyStream = this;
        }
        close() {
          this.closed = true;
        }
      };
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let calls = 0;
    let mode = 'ok';
    let stale = false;
    let firstHistory = true;
    const requestedRanges = [];
    await page.route('**/api/public/duo-quotes/history?*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(request.headers().authorization, undefined);
      calls++;
      const range = url.searchParams.get('range');
      requestedRanges.push(range);
      if (firstHistory) {
        firstHistory = false;
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      const data = response(range);
      data.stale = stale;
      if (mode === 'empty') {
        data.capacities.forEach(capacity => {
          [...capacity.retailSeries, ...capacity.officialSeries].forEach(series => {
            series.points = [];
          });
        });
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      return route.fulfill({
        status: mode === 'error' ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          mode === 'error'
            ? { success: false, error: { message: '价格走势暂时不可用' } }
            : { success: true, data }
        ),
      });
    });

    await page.goto(`${baseUrl}/quote/duo/history`, { waitUntil: 'commit' });
    await page.locator('.duo-history-skeleton').waitFor();
    await page.getByRole('heading', { name: 'iPhone Duo 价格走势' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'iPhone Duo 价格走势' }).count(), 1);
    await page.getByText('夜空色零售价', { exact: true }).first().waitFor();
    assert.equal(requestedRanges[0], '7d');
    assert.equal(await page.title(), 'iPhone Duo 价格走势');
    assert.deepEqual(await page.locator('.duo-history-legend > span').allTextContents(), [
      '夜空色零售价',
      '星光白色零售价',
      '官网价',
    ]);
    const summary = await page.locator('.duo-history-summary').innerText();
    assert.ok(summary.includes('¥16,100'));
    assert.ok(summary.includes('溢价'));
    assert.equal(await page.locator('.recharts-line-curve').count(), 3);
    assert.ok((await page.locator('.recharts-line-dots circle').count()) >= 2);
    const rangeTrigger = page.getByRole('button', { name: /时间范围，?/ });
    assert.equal(await rangeTrigger.getAttribute('aria-expanded'), 'false');
    await rangeTrigger.click();
    assert.equal(await rangeTrigger.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await page.getByRole('option').allTextContents(), [
      '24小时',
      '近7天',
      '近30天',
      '全部',
    ]);
    assert.equal(await page.getByRole('option', { name: '近7天' }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByText('全选', { exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await rangeTrigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await rangeTrigger.evaluate(element => element === document.activeElement), true);
    await page.locator('.recharts-wrapper').hover({ position: { x: 420, y: 180 } });
    await page.locator('.duo-history-tooltip').waitFor();
    const tooltip = await page.locator('.duo-history-tooltip').innerText();
    assert.ok(tooltip.includes('¥'));
    assert.ok(tooltip.includes('溢价'));

    await chooseRange(page, '近30天');
    await page.waitForFunction(() => document.body.innerText.includes('30天'));
    assert.equal(requestedRanges.at(-1), '30d');
    await page.getByRole('button', { name: '512G' }).click();
    assert.ok((await page.locator('.duo-history-summary').innerText()).includes('¥17,100'));

    const beforePoll = calls;
    await page.clock.fastForward(60_000);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(calls > beforePoll);

    const beforeEvent = calls;
    await page.evaluate(() => {
      window.__historyStream.dispatchEvent(
        new MessageEvent('quote-version', { data: JSON.stringify({ version: 3 }) })
      );
    });
    await page.waitForFunction(
      expected => window.performance.getEntriesByType('resource').length >= expected,
      0
    );
    await page.waitForTimeout(100);
    assert.ok(calls > beforeEvent);
    assert.ok((await page.locator('.duo-history-summary').innerText()).includes('¥17,100'));

    mode = 'error';
    await chooseRange(page, '24小时');
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('.recharts-line-curve').count(), 3);
    mode = 'ok';
    stale = true;
    await page.getByRole('button', { name: '重试' }).click();
    await page.getByRole('alert').waitFor({ state: 'detached' });
    await page.getByText('来源数据更新存在延迟').waitFor();

    stale = false;
    mode = 'empty';
    await chooseRange(page, '全部');
    await page.getByText('所选时间范围内暂无可展示的价格变更。').waitFor();
    assert.ok((await page.locator('.recharts-cartesian-axis').count()) >= 2);
    mode = 'ok';
    await chooseRange(page, '近7天');
    await page.getByText('所选时间范围内暂无可展示的价格变更。').waitFor({ state: 'detached' });

    const dimensions = [];
    for (const [width, height] of [
      [1440, 900],
      [768, 1024],
      [390, 844],
      [375, 812],
      [320, 740],
    ]) {
      await page.setViewportSize({ width, height });
      await page.reload();
      await page.getByRole('heading', { name: 'iPhone Duo 价格走势' }).waitFor();
      await page.getByText('夜空色零售价', { exact: true }).first().waitFor();
      assert.equal(await page.getByRole('heading', { name: 'iPhone Duo 价格走势' }).count(), 1);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `horizontal overflow at ${width}`
      );
      if (width < 640) {
        const controls = await page
          .locator('.duo-history-mobile-select select, .duo-history-range-trigger')
          .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
        assert.ok(controls.every(heightValue => heightValue >= 44));
        assert.equal(
          await page.locator('.duo-history-chart').evaluate(element => element.clientHeight),
          240
        );
        assert.equal(
          await page.locator('.recharts-xAxis .recharts-cartesian-axis-tick').count(),
          3
        );
      }
      dimensions.push({ width, height });
      await page.locator('.duo-history-header').scrollIntoViewIfNeeded();
      await new Promise(resolve => setTimeout(resolve, 100));
      await page.screenshot({
        path: path.join(output, `duo-history-${width}.png`),
        fullPage: false,
        captureBeyondViewport: false,
      });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, 'result.json'),
      `${JSON.stringify({ calls, requestedRanges, dimensions }, null, 2)}\n`
    );
    console.log(`Duo price history acceptance passed: ${output}`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
