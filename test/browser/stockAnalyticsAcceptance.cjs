/* eslint-env node, browser */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const output =
  process.env.OUTPUT_DIR || process.env.STOCK_ANALYTICS_OUTPUT || '.tmp/stock-analytics-ui';
const baseUrl = process.env.STOCK_BASE_URL || process.env.STOCK_UI_URL || 'http://127.0.0.1:5334';
const labels = ['未收款', '已代收待转回', '公司已到账', '待核实', '已有部分到账'];
const statuses = ['unpaid', 'agent_pending', 'company_received', 'unknown', 'legacy_partial'];
const permissions = [
  'stock.read',
  'stock.sales.read',
  'stock.profit.read',
  'stock.collections.read',
  'stock.receipts.read',
  'stock.catalog.manage',
];
const product = { id: 'p1', modelName: 'iPhone 18 Pro Max', storageGb: 512, colorName: '蓝色' };
const units = statuses.map((paymentStatus, index) => ({
  id: `u${index}`,
  deviceNumber: index + 1,
  serialNumber: `A12345678${index}`,
  state: 'sold',
  product,
  allowedActions: [],
  receivedOn: '2026-10-01',
  soldOn: '2026-10-09',
  paymentStatus,
  saleAmount: '10000.00',
  settlementAmount: '9900.00',
  grossProfit: ['100.00', '-200.00', '0.00', null, '88.88'][index],
}));
async function setup(browser, width, restricted = false) {
  const page = await browser.newPage({ viewport: { width, height: width === 375 ? 667 : 1000 } });
  const state = { errors: [], ledger: [], statistics: [], mode: 'normal', writes: [] };
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('token', 'synthetic-analytics'));
  await page.route('**/api/**', async route => {
    const req = route.request(),
      url = new URL(req.url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (req.method() !== 'GET') state.writes.push(url.pathname);
    let data = {};
    if (url.pathname.endsWith('/auth/me'))
      data = {
        id: 1,
        role: 'operator',
        username: '合成验收',
        permissions: restricted ? ['stock.read'] : permissions,
      };
    else if (url.pathname.endsWith('/ledger/catalog'))
      data = {
        enabled: true,
        products: [product],
        filterOptions: { modelNames: [product.modelName], storageGbs: [512], colorNames: ['蓝色'] },
        warehouses: [{ id: 'w1', name: '长沙 明威' }],
        people: [],
      };
    else if (url.pathname.endsWith('/ledger/statistics')) {
      state.statistics.push(Object.fromEntries(url.searchParams));
      if (state.mode === 'slow') await new Promise(resolve => setTimeout(resolve, 800));
      if (state.mode === 'error')
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: '合成统计失败' }),
        });
      const filtered =
        url.searchParams.get('states') === '["registered"]' ||
        url.searchParams.get('warehouseIds') === '["unassigned"]';
      data =
        state.mode === 'empty'
          ? { total: 0, items: [], models: [], states: [], warehouses: [] }
          : filtered
            ? {
              total: 3,
              models: [{ modelName: '机型待补', count: 3 }],
              items: [{ modelName: '机型待补', storageGb: null, colorName: null, count: 3 }],
              states: [{ state: 'registered', count: 3 }],
              warehouses: [{ warehouseId: null, warehouseName: '未分配仓库', count: 3 }],
            }
            : {
              total: 29,
              models: [
                { modelName: product.modelName, count: 26 },
                { modelName: '机型待补', count: 3 },
              ],
              items: [
                { ...product, count: 26 },
                { modelName: '机型待补', storageGb: null, colorName: null, count: 3 },
              ],
              states: [
                { state: 'in_stock', count: 21 },
                { state: 'sold', count: 5 },
                { state: 'registered', count: 3 },
              ],
              warehouses: [
                { warehouseId: 'w1', warehouseName: '长沙 明威', count: 26 },
                { warehouseId: null, warehouseName: '未分配仓库', count: 3 },
              ],
            };
    } else if (url.pathname.endsWith('/ledger')) {
      state.ledger.push(Object.fromEntries(url.searchParams));
      data = {
        items: units,
        total: 5,
        counts: { pending: 3, inStock: 21, sold: 5, returned: 0 },
        page: 1,
        pageSize: 20,
      };
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
  });
  await page.goto(`${baseUrl}/stock?view=sold`);
  await page.getByRole('tab', { name: /^已售/ }).waitFor();
  return { page, state };
}
async function waitQuery(page, state, predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate(state)) return;
    await page.waitForTimeout(100);
  }
  assert.fail('筛选请求未达到预期');
}
async function verifyStatisticsSearch(page, state, width) {
  const status = page.getByRole('button', { name: '统计设备状态', exact: true });
  const warehouse = page.getByRole('button', { name: '统计仓库', exact: true });
  const boxes = await Promise.all([status.boundingBox(), warehouse.boundingBox()]);
  const availableWidth = await page.locator('.stock-dialog-scroll').evaluate(node => {
    const style = getComputedStyle(node);
    return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  for (const box of boxes) {
    assert.ok(box.width >= (width >= 640 ? 279 : availableWidth - 1), JSON.stringify(boxes));
    assert.ok(box.x >= 0 && box.x + box.width <= width);
  }
  if (width >= 640) assert.ok(Math.abs(boxes[0].y - boxes[1].y) < 2);
  else assert.ok(boxes[1].y > boxes[0].y + boxes[0].height);
  for (const [trigger, itemLabel, keyword, optionName, queryKey, selected] of [
    [status, '状态', '未入库', '未入库', 'states', 'registered'],
    [warehouse, '仓库', '长沙', '长沙 明威', 'warehouseIds', 'w1'],
  ]) {
    await trigger.click();
    const search = page.getByPlaceholder(`搜索 ${itemLabel}`, { exact: true });
    const searchBox = await search.boundingBox();
    assert.ok(searchBox.width >= (width >= 640 ? 260 : availableWidth - 20), JSON.stringify(searchBox));
    assert.ok(searchBox.x >= 0 && searchBox.x + searchBox.width <= width);
    await search.fill(keyword);
    const option = page.getByRole('listbox').getByRole('option', { name: optionName, exact: true });
    await option.waitFor();
    assert.equal(await page.getByRole('listbox').getByRole('option').count(), 1);
    assert.ok(await option.locator('span[title]').evaluate(n => n.scrollWidth <= n.clientWidth));
    await option.click();
    await waitQuery(page, state, current => current.statistics.at(-1)[queryKey] === JSON.stringify([selected]));
    assert.equal(await option.getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: new RegExp('^统计.*取消全选搜索结果$') }).click();
    assert.equal(await option.getAttribute('aria-selected'), 'false');
    await page.getByRole('button', { name: new RegExp('^统计.*全选搜索结果$') }).click();
    assert.equal(await option.getAttribute('aria-selected'), 'true');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: `${output}/statistics-search-${itemLabel}-${width}.png` });
    await search.fill('没有此项');
    assert.equal(await page.getByRole('button', { name: new RegExp('^统计.*全选搜索结果$') }).isDisabled(), true);
    await search.fill('');
    await page.getByRole('button', { name: new RegExp('^统计.*全选$') }).click();
    await waitQuery(page, state, current => JSON.parse(current.statistics.at(-1)[queryKey]).length === (itemLabel === '状态' ? 4 : 2));
    await page.getByRole('button', { name: '清空选择', exact: true }).click();
    await trigger.click();
    await waitQuery(page, state, current => current.statistics.at(-1)[queryKey] === '[]');
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByText('总计 29 台', { exact: true }).waitFor();
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1440, 1280, 768, 375]) {
      const { page, state } = await setup(browser, width);
      if (width >= 1280) {
        await page
          .getByRole('columnheader', { name: '销售日期 / 入库日期', exact: true })
          .waitFor();
        const row = page
          .getByRole('row')
          .filter({ has: page.getByRole('button', { name: 'A123456780', exact: true }) });
        const date = row.locator('td[data-label="销售日期 / 入库日期"]');
        assert.equal((await date.innerText()).replace(/\s+/g, ' '), '2026-10-09 入库：2026-10-01');
        const boxes = await page.locator('.ledger-sales-filters > *').evaluateAll(nodes =>
          nodes.map(n => ({
            y: n.getBoundingClientRect().top,
            bottom: n.querySelector('input, select, button').getBoundingClientRect().bottom,
            width: n.getBoundingClientRect().width,
          }))
        );
        assert.equal(boxes.length, 7);
        assert.ok(
          boxes.every(
            box =>
              Math.abs(box.y - boxes[0].y) < 10 &&
              Math.abs(box.bottom - boxes[0].bottom) < 2 &&
              box.width >= 75
          ),
          JSON.stringify(boxes)
        );
        const settings = await page
          .getByRole('button', { name: '基础设置', exact: true })
          .boundingBox();
        const analytics = await page
          .getByRole('button', { name: '统计分析', exact: true })
          .boundingBox();
        assert.ok(analytics.x > settings.x && Math.abs(analytics.y - settings.y) < 2);
      }
      const badgeColors = [];
      for (const label of labels) {
        const badge = page
          .locator('span.badge:visible')
          .filter({ hasText: new RegExp(`^${label}$`) })
          .first();
        assert.equal(await badge.isVisible(), true);
        badgeColors.push(await badge.evaluate(n => getComputedStyle(n).backgroundColor));
      }
      assert.equal(new Set(badgeColors).size, 5, badgeColors.join(','));
      const profits = await page
        .locator('div')
        .filter({ hasText: /^毛利 / })
        .evaluateAll(nodes =>
          nodes
            .filter(
              n =>
                n.getBoundingClientRect().height > 0 &&
                n.textContent.startsWith('毛利 ') &&
                n.children.length === 1
            )
            .map(n => ({
              text: n.textContent,
              color: getComputedStyle(n.querySelector('span')).color,
              labelColor: getComputedStyle(n).color,
            }))
        );
      const positive = profits.find(p => p.text.includes('100.00'));
      const negative = profits.find(p => p.text.includes('-200.00'));
      const zero = profits.find(p => /毛利.*[¥￥]0\.00/.test(p.text));
      const missing = profits.find(p => p.text.includes('待补官网售价'));
      assert.ok(positive && negative && zero && missing, JSON.stringify(profits));
      assert.equal(positive.color, 'rgb(21, 128, 61)');
      assert.equal(negative.color, 'rgb(185, 28, 28)');
      assert.equal(zero.color, zero.labelColor);
      assert.equal(missing.color, missing.labelColor);
      assert.notEqual(positive.color, positive.labelColor);
      assert.notEqual(negative.color, negative.labelColor);
      await page.screenshot({ path: `${output}/sold-${width}.png`, fullPage: true });
      const dateButton = page.getByRole('button', { name: /^销售日期：/ });
      await dateButton.click();
      const dateDialog = page.getByRole('dialog', { name: '销售日期选择' });
      await dateDialog.getByLabel('销售开始日期').fill('2026-10-01');
      await dateDialog.getByLabel('销售结束日期').fill('2026-10-09');
      await dateDialog.getByRole('button', { name: '应用', exact: true }).click();
      await waitQuery(page, state, s =>
        s.ledger.some(q => q.soldFrom === '2026-10-01' && q.soldTo === '2026-10-09')
      );
      await dateButton.click();
      await dateDialog.getByLabel('销售开始日期').fill('2026-10-10');
      assert.equal(
        await dateDialog.getByRole('button', { name: '应用', exact: true }).isDisabled(),
        true
      );
      await dateDialog.getByRole('button', { name: '取消', exact: true }).click();
      await dateButton.click();
      assert.equal(await dateDialog.getByLabel('销售开始日期').inputValue(), '2026-10-01');
      await page.screenshot({ path: `${output}/date-${width}.png` });
      await page.keyboard.press('Escape');
      assert.equal(await dateButton.evaluate(n => n === document.activeElement), true);
      await dateButton.click();
      await dateDialog.getByRole('button', { name: '清空', exact: true }).click();
      await waitQuery(page, state, s => !s.ledger.at(-1).soldFrom && !s.ledger.at(-1).soldTo);
      await dateButton.click();
      await dateDialog.getByLabel('销售开始日期').fill('2026-10-02');
      await dateDialog.getByRole('button', { name: '应用', exact: true }).click();
      await waitQuery(page, state, s => s.ledger.at(-1).soldFrom === '2026-10-02' && !s.ledger.at(-1).soldTo);
      assert.equal(state.ledger.at(-1).page, '1');
      await page.getByRole('button', { name: '重置筛选', exact: true }).click();
      await page.getByRole('button', { name: '统计分析', exact: true }).click();
      await page.getByText('总计 29 台', { exact: true }).waitFor();
      for (const title of ['机型数量分布', '设备状态分布', '仓库数量分布'])
        assert.equal(await page.getByRole('list', { name: title }).count(), 1);
      assert.equal(
        await page.getByRole('list', { name: '机型数量分布' }).getByRole('listitem').count(),
        2
      );
      assert.match(
        await page.getByRole('list', { name: '仓库数量分布' }).innerText(),
        /未分配仓库/
      );
      assert.equal(state.statistics.length, 1);
      await verifyStatisticsSearch(page, state, width);
      await page.screenshot({ path: `${output}/statistics-${width}.png` });
      if (width === 375) {
        const modal = page.getByRole('dialog', { name: '统计分析', exact: true });
        await modal
          .getByRole('columnheader', { name: '颜色', exact: true })
          .scrollIntoViewIfNeeded();
        assert.equal(
          await modal.getByRole('columnheader', { name: '颜色', exact: true }).isVisible(),
          true
        );
        await page.screenshot({ path: `${output}/statistics-table-${width}.png` });
        await page
          .getByRole('button', { name: '统计设备状态', exact: true })
          .scrollIntoViewIfNeeded();
      }
      await page.getByRole('button', { name: '统计设备状态', exact: true }).click();
      await page.getByRole('option', { name: '未入库', exact: true }).click();
      await page.getByRole('button', { name: '统计设备状态', exact: true }).click();
      await page.getByRole('button', { name: '统计仓库', exact: true }).click();
      await page.getByRole('option', { name: '未分配仓库', exact: true }).click();
      await page.getByRole('button', { name: '统计仓库', exact: true }).click();
      await page.getByText('总计 3 台', { exact: true }).waitFor();
      await waitQuery(page, state, s =>
        s.statistics.some(q => q.states === '["registered"]' && q.warehouseIds === '["unassigned"]')
      );
      for (const title of ['机型数量分布', '设备状态分布', '仓库数量分布']) {
        const list = page.getByRole('list', { name: title });
        assert.equal(await list.getByRole('listitem').count(), 1);
        assert.match(await list.innerText(), /3 台.*100\.0%/s);
      }
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      );
      await page.getByRole('button', { name: '关闭统计分析', exact: true }).click();
      for (const mode of ['slow', 'error', 'empty']) {
        state.mode = mode;
        await page.getByRole('button', { name: '统计分析', exact: true }).click();
        if (mode === 'slow') {
          await page.getByText('正在加载…', { exact: true }).waitFor();
          await page.getByText('总计 29 台', { exact: true }).waitFor();
        }
        if (mode === 'error') {
          await page.getByRole('alert').filter({ hasText: '合成统计失败' }).waitFor();
          state.mode = 'normal';
          await page.getByRole('button', { name: '重新加载', exact: true }).click();
          await page.getByText('总计 29 台', { exact: true }).waitFor();
        }
        if (mode === 'empty') {
          await page.getByText('总计 0 台', { exact: true }).waitFor();
          await page.getByText('当前筛选暂无设备，请调整状态或仓库。', { exact: true }).waitFor();
          assert.equal(await page.getByRole('list', { name: '机型数量分布' }).count(), 0);
        }
        await page.getByRole('button', { name: '关闭统计分析', exact: true }).click();
      }
      assert.deepEqual(state.errors, []);
      assert.deepEqual(state.writes, []);
      await page.close();
    }
    const narrow = await setup(browser, 320);
    await narrow.page.getByRole('button', { name: '统计分析', exact: true }).click();
    await narrow.page.getByText('总计 29 台', { exact: true }).waitFor();
    await verifyStatisticsSearch(narrow.page, narrow.state, 320);
    assert.deepEqual(narrow.state.errors, []);
    assert.deepEqual(narrow.state.writes, []);
    await narrow.page.close();
    const { page, state } = await setup(browser, 1280, true);
    assert.equal(await page.getByRole('button', { name: '基础设置', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('按货款状况筛选').count(), 0);
    assert.equal(await page.getByLabel('按销售人筛选').count(), 0);
    assert.equal(await page.getByRole('button', { name: /^销售日期：/ }).count(), 0);
    assert.equal(await page.getByText(/^毛利 /).count(), 0);
    await page.getByRole('button', { name: '统计分析', exact: true }).click();
    await page.getByText('总计 29 台', { exact: true }).waitFor();
    assert.deepEqual(state.errors, []);
    await page.close();
    process.stdout.write(
      'PASS: 1440/1280/768/375 日期、五态标签、毛利、七项同排筛选、全量统计图表、权限与加载/失败/空状态\n'
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
