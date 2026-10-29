/* eslint-env node, browser */
/* eslint-disable camelcase, no-magic-numbers -- 合成 API 契约、屏宽及验收数据 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');

const BASE_URL = process.env.ORDERS_UI_BASE_URL || 'http://127.0.0.1:5173';
const OUTPUT = process.env.ORDERS_UI_OUTPUT || '.taste-skill/acceptance';
const ORDERS = [
  {
    id: 101,
    order_number: 'W1027000001',
    products: [{ name: 'iPhone 18 Pro 银色 256G', quantity: 2 }],
    official_order_status: 'PROCESSING',
    display_order_status: 'ready_for_pickup',
    recipient_name: '张某',
    recipient_tag: '深圳 演示组',
    order_date: '2026-10-27T06:20:00Z',
    email_pickup_info: {
      storeName: 'Apple 深圳益田假日广场',
      pickupDate: '2026-10-29',
      startTime: '10:00',
      endTime: '10:30',
      appointmentMode: 'fixed',
    },
  },
  {
    id: 102,
    order_number: 'W1027000002',
    products: [],
    recipient_name: '李某',
    display_order_status: 'confirmed',
  },
];

/** 对真实 React 页面注入合成 API；验证重构的范围、默认列、故障状态与手机边界。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  fs.mkdirSync(OUTPUT, { recursive: true });
  const errors = [];
  const submitted = [];
  const queries = [];
  const densityEvidence = [];
  let failList = false;
  let densityMode = false;
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-orders-workspace'));
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === BASE_URL) await route.continue();
          else await route.abort();
          return;
        }
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: '界面验收',
            role: 'admin',
            permissions: ['orders.read', 'orders.edit', 'orders.export', 'order_mail.manage'],
            availableHome: '/orders',
          };
        else if (url.pathname === '/api/orders/filter-options')
          data = {
            productOptions: [],
            recipientTags: [],
            stores: [],
            payers: [],
            officialOrderStatuses: ['PROCESSING', 'READY_FOR_PICKUP'],
          };
        else if (url.pathname === '/api/orders') {
          queries.push(Object.fromEntries(url.searchParams));
          if (failList)
            return await route.fulfill({
              status: 503,
              json: { success: false, error: { message: '合成网络故障' } },
            });
          let rows = ORDERS;
          if (url.searchParams.get('keyword') === '没有这个订单') rows = [];
          else if (densityMode) {
            rows = Array.from({ length: 20 }, (_, index) => ({
              ...ORDERS[0],
              id: 101 + index,
              order_number: `W${1027000001 + index}`,
            }));
          }
          data = { total: rows.length, orders: rows };
        } else if (
          url.pathname === '/api/orders/official-refresh/batches' &&
          route.request().method() === 'POST'
        ) {
          submitted.push(route.request().postDataJSON());
          data = { total: 2, queued: 2, skipped: 0 };
        } else if (url.pathname.endsWith('/devices')) data = { items: [] };
        else if (/\/orders\/\d+$/.test(url.pathname)) data = { apple_password: null };
        else if (url.pathname.endsWith('/link')) data = { orderUrl: null };
        else data = { isRunning: false, items: [] };
        assert(
          route.request().method() === 'GET' ||
            url.pathname === '/api/orders/official-refresh/batches',
          '禁止其他业务写入'
        );
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE_URL}/orders`);
      await page.getByRole('checkbox', { name: '选择订单 W1027000001', exact: true }).waitFor();
      assert.equal(await page.locator('.orders-workspace').count(), 1);
      assert.equal(await page.locator('.orders-results img').count(), 0, '商品信息不显示图片');
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${width}px 页面越界`
      );
      assert.equal(await page.locator('.orders-overview').count(), 0, '顶部四项统计已移除');
      if (width < 768) {
        const firstRow = await page.locator('.orders-mobile-row').first().boundingBox();
        assert(firstRow.y < 900 * 0.6, '手机首条订单应在首屏前60%开始');
      } else {
        const headers = await page.getByRole('columnheader').allTextContents();
        assert(
          headers.findIndex(value => value.trim() === '商品') <
            headers.findIndex(value => value.includes('官网订单状态'))
        );
        assert(!headers.some(value => value.trim() === 'Serial No.'), '补充字段通过列设置访问');
      }
      await page.screenshot({ path: `${OUTPUT}/orders-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/orders`);
    await page.getByRole('checkbox', { name: '选择订单 W1027000001', exact: true }).check();
    await page.getByText('已选择 1 项（当前页）', { exact: true }).waitFor();
    await page.getByRole('button', { name: '全选筛选结果（2）', exact: true }).click();
    assert(await page.getByRole('button', { name: '批量刷新邮件状态', exact: true }).isDisabled());
    await page.getByRole('button', { name: '更新选中官网状态', exact: true }).click();
    await page.getByText(/新增 2 单/).waitFor();
    assert.equal(submitted[0].selection, 'filtered');
    assert(submitted[0].requestKey);
    await page.getByRole('button', { name: /^下单日期：/ }).click();
    await page.getByLabel('下单开始日期', { exact: true }).fill('2026-10-01');
    await page.getByLabel('下单结束日期', { exact: true }).fill('2026-10-29');
    await page.getByRole('dialog').getByRole('button', { name: '应用', exact: true }).click();
    await page.getByText('已启用 1 组', { exact: true }).waitFor();
    await page.getByRole('button', { name: '官网订单状态筛选', exact: true }).click();
    await page.getByRole('option', { name: '处理中', exact: true }).click();
    await page.getByRole('button', { name: '完成', exact: true }).click();
    assert.equal(
      await page
        .getByRole('button', { name: '官网订单状态筛选', exact: true })
        .getAttribute('aria-expanded'),
      'false'
    );
    assert(
      await page
        .getByRole('button', { name: '官网订单状态筛选', exact: true })
        .evaluate(el => el === document.activeElement),
      '完成返回触发器焦点'
    );
    await page.getByRole('button', { name: '移除官网订单状态筛选', exact: true }).waitFor();
    await page.getByRole('button', { name: '移除下单日期筛选', exact: true }).click();
    await page
      .getByRole('button', { name: '移除下单日期筛选', exact: true })
      .waitFor({ state: 'detached' });
    assert(
      await page.getByRole('button', { name: '移除官网订单状态筛选', exact: true }).isVisible(),
      '移除日期保留状态条件'
    );
    await page.getByRole('button', { name: '移除官网订单状态筛选', exact: true }).click();
    await page
      .getByRole('button', { name: '移除官网订单状态筛选', exact: true })
      .waitFor({ state: 'detached' });
    assert(
      !queries.at(-1).dateFrom && !queries.at(-1).dateTo && !queries.at(-1).officialOrderStatuses,
      '组移除同步清除请求参数'
    );
    assert.equal(await page.locator('.orders-active-filters').count(), 0);
    await page.getByLabel('搜索订单', { exact: true }).fill('没有这个订单');
    await page.getByText('未找到订单', { exact: true }).waitFor();
    await page
      .locator('.orders-results')
      .getByRole('button', { name: '清空筛选', exact: true })
      .click();
    await page.getByRole('checkbox', { name: '选择订单 W1027000001', exact: true }).waitFor();
    // 输入不叠加外环；按钮使用单层键盘提示，覆盖全部六项多选与日期。
    const focusEvidence = [];
    const checkInputFocus = async (input, label) => {
      await input.click();
      const style = await input.evaluate(element => {
        const css = getComputedStyle(element);
        return { shadow: css.boxShadow, outline: css.outlineStyle, border: css.borderTopWidth };
      });
      focusEvidence.push({ label, ...style });
      assert.equal(style.shadow, 'none', `${label} 不应有焦点阴影`);
      assert.equal(style.outline, 'none', `${label} 不应有叠加外环`);
      assert.equal(style.border, '1px', `${label} 保留单层细边框`);
    };
    await checkInputFocus(page.getByLabel('搜索订单', { exact: true }), '主搜索');
    await page.getByLabel('搜索订单', { exact: true }).press('Tab');
    const buttonFocus = await page
      .getByRole('button', { name: '列设置', exact: true })
      .evaluate(element => ({
        focused: element === document.activeElement,
        width: getComputedStyle(element).outlineWidth,
        shadow: getComputedStyle(element).boxShadow,
      }));
    assert(
      buttonFocus.focused && buttonFocus.width === '1px' && buttonFocus.shadow === 'none',
      '键盘焦点保留单层1px轮廓'
    );
    for (const label of [
      '官网订单状态筛选',
      '邮件订单状态筛选',
      '商品信息筛选',
      '订单 TAG 筛选',
      '取货门店筛选',
      '付款人筛选',
    ]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const input = page.locator('.tag-select-panel input').filter({ visible: true });
      await checkInputFocus(input, label);
      if (label === '官网订单状态筛选') await page.screenshot({ path: `${OUTPUT}/筛选焦点.png` });
      await input.press('Escape');
    }
    await page.getByRole('button', { name: /^下单日期：/ }).click();
    await checkInputFocus(page.getByLabel('下单开始日期', { exact: true }), '日期输入');
    await page.getByRole('button', { name: '关闭日期选择', exact: true }).click();
    fs.writeFileSync(
      `${OUTPUT}/focus-metrics.json`,
      JSON.stringify({ inputs: focusEvidence, buttonFocus }, null, 2)
    );
    failList = true;
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.getByText('订单加载失败', { exact: true }).waitFor();
    assert.equal(
      await page.getByText('未找到订单', { exact: true }).count(),
      0,
      '故障不能伪装成空结果'
    );
    failList = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByRole('checkbox', { name: '选择订单 W1027000001', exact: true }).waitFor();
    await page.getByTestId('center-toast').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '查看', exact: true }).first().click();
    await page.getByRole('heading', { name: '订单详情', exact: true }).waitFor();
    await page.getByText('暂无序列号', { exact: true }).waitFor();
    await page.screenshot({ path: `${OUTPUT}/detail-desktop.png` });
    await page.getByRole('button', { name: '关闭订单详情', exact: true }).click();
    await page.getByRole('button', { name: '列设置', exact: true }).click();
    await page.screenshot({ path: `${OUTPUT}/columns-desktop.png` });
    densityMode = true;
    for (const [width, height] of [
      [1904, 948],
      [1440, 900],
      [1280, 800],
      [1280, 600],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${BASE_URL}/orders`);
      await page.getByRole('checkbox', { name: '选择订单 W1027000001', exact: true }).waitFor();
      const metrics = await page.evaluate(() => {
        const scroll = document.querySelector('.orders-table-scroll');
        const row = scroll.querySelector('tbody tr').getBoundingClientRect();
        const pagination = document.querySelector('.orders-pagination').getBoundingClientRect();
        return {
          pageHeight: document.documentElement.scrollHeight,
          viewportHeight: innerHeight,
          tableHeight: scroll.clientHeight,
          scrollHeight: scroll.scrollHeight,
          horizontal: scroll.scrollWidth - scroll.clientWidth,
          firstRowTop: row.top,
          rowHeight: row.height,
          paginationBottom: pagination.bottom,
          fontSize: getComputedStyle(scroll.querySelector('tbody [data-column="products"]'))
            .fontSize,
          actions: [
            ...scroll.querySelectorAll('tbody tr:first-child .orders-row-actions button'),
          ].map(button => ({
            text: button.innerText.trim(),
            icon: Boolean(button.querySelector('svg')),
            top: Math.round(button.getBoundingClientRect().top),
          })),
        };
      });
      assert.equal(metrics.fontSize, '12px', '表格数据为12px');
      assert(
        metrics.actions.every(action => action.text && action.icon),
        '每个操作均为图标加可见文字'
      );
      assert.equal(
        new Set(metrics.actions.map(action => action.top)).size,
        width >= 1600 ? 1 : 2,
        '宽屏一行，中等宽度2×2'
      );
      densityEvidence.push({ width, height, ...metrics });
      fs.writeFileSync(`${OUTPUT}/density-metrics.json`, JSON.stringify(densityEvidence, null, 2));
      assert(metrics.rowHeight <= 72, `${width}px 常规订单行过高: ${metrics.rowHeight}`);
      assert(
        metrics.firstRowTop < (width >= 1440 ? 330 : 380),
        `${width}px 首行位置过低: ${metrics.firstRowTop}`
      );
      if (height >= 680) {
        assert(metrics.pageHeight <= metrics.viewportHeight + 1, '桌面工作台不应再有外层纵向滚动');
        assert(metrics.paginationBottom <= height, '分页必须在视口内');
        assert(
          metrics.tableHeight > 300 && metrics.scrollHeight > metrics.tableHeight,
          '列表应独立滚动且保留阅读高度'
        );
      } else {
        assert(metrics.pageHeight > height, '矮窗口应恢复页面滚动，不能裁掉内容');
      }
      if (width >= 1440)
        assert(metrics.horizontal <= 1, `${width}px 默认列应完整放入: ${metrics.horizontal}`);
      await page.screenshot({ path: `${OUTPUT}/density-${width}-${height}.png` });
      if (metrics.horizontal > 1) {
        const region = page.getByRole('region', { name: '订单列表，可横向滚动', exact: true });
        const identityBefore = await page
          .locator('tbody [data-column="orderNumber"]')
          .first()
          .boundingBox();
        const next = page.getByRole('button', { name: '向右查看字段', exact: true });
        await next.click();
        await page.waitForFunction(() => {
          const el = document.querySelector('.orders-table-scroll');
          return el.scrollLeft >= el.scrollWidth - el.clientWidth - 1;
        });
        assert(await next.isDisabled(), '到右端必须禁用右翻');
        const identityAfter = await page
          .locator('tbody [data-column="orderNumber"]')
          .first()
          .boundingBox();
        assert(Math.abs(identityAfter.x - identityBefore.x) < 1, '横向翻阅时订单身份列保持可见');
        await page.getByRole('button', { name: '向左查看字段', exact: true }).click();
        await page.waitForFunction(
          () => document.querySelector('.orders-table-scroll').scrollLeft <= 1
        );
        if (height >= 680) {
          await region.focus();
          await region.press('PageDown');
          await page.waitForFunction(
            () => document.querySelector('.orders-table-scroll').scrollTop > 0
          );
          assert.equal(await page.evaluate(() => scrollY), 0, '翻页键只滚动列表');
        }
      }
    }
    assert.deepEqual(errors, []);
    process.stdout.write(
      'PASS: 四种屏宽、纯文字商品、默认列、精确选择范围、统计移除、条件组独立移除、完成与焦点、空态、错误重试、详情与列设置、桌面密度与单滚动层、横向翻阅与身份固定\n'
    );
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
