/* global localStorage, document, window, getComputedStyle */
/* eslint-disable no-magic-numbers -- 合成报价与固定视口边界。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const output = process.env.DUO_BROWSER_OUTPUT || '/tmp/apple-duo-retail-browser';
const baseUrl = process.env.DUO_BROWSER_URL || 'http://127.0.0.1:5173';
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1392, height: 1412 } });
    page.setDefaultTimeout(10000);
    await page.clock.install();
    await page.addInitScript(() => localStorage.setItem('token', 'synthetic-old-token'));
    await page.addInitScript(() => {
      // 本文件专注布局／筛选／轮询；原生SSE与竞态由独立实时验收覆盖。
      window.EventSource = class extends window.EventTarget {
        static get OPEN() {
          return 1;
        }
        static get CLOSED() {
          return 2;
        }
        constructor(url) {
          super();
          this.url = url;
          this.readyState = 1;
        }
        close() {
          this.readyState = 2;
        }
      };
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let calls = 0;
    let mode = 'ok';
    let authCalls = 0;
    const prices = [16400, 16300, 18750, 18450, 22750, 22750, 27350, 27350];
    const officials = [15999, 15999, 17999, 17999, 21499, 21499, 26499, 26499];
    const data = {
      enabled: true,
      stale: false,
      version: 0,
      updatedAt: '2026-10-25T05:41:04Z',
      items: [256, 512, 1024, 2048].flatMap((storageGb, i) =>
        ['星光白色', '夜空色'].map((color, j) => ({
          productKey: `${i}-${j}`,
          productModel: 'Duo',
          storageGb,
          color,
          retailPrice: prices[i * 2 + j],
          officialPrice: officials[i * 2 + j],
          premiumAmount: Math.floor((prices[i * 2 + j] - officials[i * 2 + j]) / 10) * 10,
        }))
      ),
    };
    await page.route('**/api/**', route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return route.continue();
      if (pathname !== '/api/public/duo-quotes') {
        authCalls++;
        return route.abort();
      }
      calls++;
      assert.equal(request.headers().authorization, undefined);
      return route.fulfill({
        status: mode === 'error' ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          mode === 'error'
            ? { success: false, error: { message: '报价数据暂不可用' } }
            : { success: true, data }
        ),
      });
    });
    await page.goto(`${baseUrl}/quote/duo`);
    await page.getByRole('heading', { name: 'iPhone Duo 报价表' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 8);
    assert.equal(await page.title(), 'iPhone Duo 报价表');
    const body = await page.locator('body').innerText();
    assert.ok(!/明威|批发|差价|公式|说明|＝/.test(body));
    assert.ok(body.includes('2026-10-25 13:41:04'));
    assert.deepEqual(await page.locator('thead th').allTextContents(), [
      '容量',
      '颜色',
      '零售价',
      '官网价',
      '溢价额',
    ]);
    assert.equal(await page.locator('tbody tr').count(), 8);
    assert.ok((await page.locator('tbody tr').first().innerText()).includes('¥16,300'));
    assert.ok((await page.locator('tbody tr').first().innerText()).includes('+300'));
    assert.deepEqual(
      await page.locator('tbody tr td:nth-child(2)').allTextContents(),
      [256, 512, 1024, 2048].flatMap(() => ['夜空色', '星光白色'])
    );
    const tableTop = await page
      .locator('.duo-quote-table-wrap')
      .evaluate(element => element.getBoundingClientRect().top);
    assert.ok(tableTop < 280, `desktop table starts too low: ${tableTop}`);
    await page.screenshot({ path: path.join(output, 'reference-1392.png'), fullPage: false });
    const dimensions = [];
    for (const [width, height] of [
      [1920, 1080],
      [1440, 900],
      [1366, 768],
      [1280, 720],
      [1024, 768],
      [768, 1024],
      [430, 932],
      [393, 852],
      [375, 812],
      [320, 740],
    ]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.locator('tbody tr').count(), 8);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `overflow at ${width}`
      );
      if (width < 768) {
        const fontSize = await page
          .locator('.duo-filter-option')
          .first()
          .evaluate(element => parseFloat(getComputedStyle(element).fontSize));
        assert.ok(fontSize <= 14, `mobile filter font ${fontSize}`);
        const height = await page
          .locator('.duo-quote-filters')
          .evaluate(element => element.getBoundingClientRect().height);
        assert.ok(height < 230, `mobile filter height ${height}`);
      }
      const pills = await page.locator('.duo-filter-option').evaluateAll(elements =>
        elements.map(element => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { width: box.width, height: box.height, radius: parseFloat(style.borderRadius) };
        })
      );
      assert.ok(
        pills.every(pill => pill.width / pill.height >= 1.6 && pill.radius >= pill.height / 2),
        `pill shape at ${width}`
      );
      assert.ok(
        pills.every(pill => Math.abs(pill.height - pills[0].height) < 1),
        `unequal pill height at ${width}`
      );
      assert.ok(pills[6].width > pills[5].width, `content width at ${width}`);
      const tableBottom = await page
        .locator('.duo-quote-table-wrap')
        .evaluate(element => element.getBoundingClientRect().bottom);
      if (width >= 1024)
        assert.ok(
          tableBottom <= height,
          `all eight rows should fit ${width}x${height}: ${tableBottom}`
        );
      const rows = await page.locator('tbody tr').count();
      dimensions.push({ width, height, rows, tableBottom, pills });
      if ([375, 393, 320, 1366, 1440].includes(width))
        await page.screenshot({
          path: path.join(output, `width-${width}.png`),
          fullPage: width < 768,
        });
    }
    const capacities = page.getByRole('group', { name: '容量', exact: true });
    const colors = page.getByRole('group', { name: '颜色', exact: true });
    assert.deepEqual(await colors.getByRole('button').allTextContents(), [
      '全部',
      '夜空色',
      '星光白色',
    ]);
    const beforeSelected = await capacities
      .getByRole('button', { name: '512G', exact: true })
      .boundingBox();
    await capacities.getByRole('button', { name: '512G', exact: true }).click();
    const afterSelected = await capacities
      .getByRole('button', { name: '512G', exact: true })
      .boundingBox();
    assert.equal(beforeSelected.width, afterSelected.width);
    assert.equal(beforeSelected.height, afterSelected.height);
    assert.equal(await page.locator('tbody tr').count(), 2);
    await capacities.getByRole('button', { name: '256G', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 4);
    assert.equal(
      await capacities
        .getByRole('button', { name: '512G', exact: true })
        .getAttribute('aria-pressed'),
      'true'
    );
    await colors.getByRole('button', { name: '夜空色', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 2);
    await colors.getByRole('button', { name: '星光白色', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 4);
    assert.deepEqual(await page.locator('tbody tr td:nth-child(2)').allTextContents(), [
      '夜空色',
      '星光白色',
      '夜空色',
      '星光白色',
    ]);
    await colors.getByRole('button', { name: '夜空色', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 2);
    assert.ok((await page.locator('tbody').innerText()).includes('星光白色'));
    await colors.getByRole('button', { name: '星光白色', exact: true }).click();
    assert.equal(
      await colors.getByRole('button', { name: '全部', exact: true }).getAttribute('aria-pressed'),
      'true'
    );
    assert.equal(await page.locator('tbody tr').count(), 4);
    await colors.getByRole('button', { name: '夜空色', exact: true }).click();
    await capacities.getByRole('button', { name: '2TB', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 3);
    const before = calls;
    await page.clock.fastForward(60000);
    await page.waitForFunction(() => document.querySelector('[aria-busy="false"]'));
    assert.ok(calls > before);
    for (const name of ['256G', '512G', '2TB']) {
      assert.equal(
        await capacities.getByRole('button', { name, exact: true }).getAttribute('aria-pressed'),
        'true'
      );
    }
    assert.equal(
      await colors
        .getByRole('button', { name: '夜空色', exact: true })
        .getAttribute('aria-pressed'),
      'true'
    );
    assert.equal(await page.locator('tbody tr').count(), 3);
    for (const name of ['256G', '512G', '2TB']) {
      await capacities.getByRole('button', { name, exact: true }).click();
    }
    assert.equal(
      await capacities
        .getByRole('button', { name: '全部', exact: true })
        .getAttribute('aria-pressed'),
      'true'
    );
    assert.equal(await page.locator('tbody tr').count(), 4);
    await capacities.getByRole('button', { name: '256G', exact: true }).click();
    await capacities.getByRole('button', { name: '512G', exact: true }).click();
    await capacities.getByRole('button', { name: '全部', exact: true }).click();
    await colors.getByRole('button', { name: '全部', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 8);
    data.stale = true;
    await page.clock.fastForward(60000);
    await page.getByText('报价更新延迟', { exact: true }).waitFor();
    mode = 'error';
    await page.clock.fastForward(60000);
    await page.getByText('报价数据暂不可用', { exact: true }).waitFor();
    assert.equal(await page.locator('tbody td[colspan="5"]').count(), 1);
    mode = 'ok';
    data.stale = false;
    data.items[0].retailPrice = null;
    data.items[0].premiumAmount = null;
    await page.clock.fastForward(60000);
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 8);
    assert.equal(
      (
        await page
          .locator('tbody tr')
          .filter({ hasText: '星光白色' })
          .first()
          .locator('td')
          .allTextContents()
      )[2],
      '—'
    );
    assert.equal(authCalls, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, 'browser-result.json'),
      JSON.stringify({
        passed: true,
        dimensions,
        calls,
        authCalls,
        errors,
        filters: true,
        multiSelect: true,
        autoRefresh: true,
        errorRecovery: true,
        nullPrice: true,
        tableTop,
      })
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(String(error));
  process.exit(1);
});
