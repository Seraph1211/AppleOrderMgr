/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const origin = process.env.PAYMENT_FILTER_ORIGIN || 'http://127.0.0.1:5182';
const output = process.env.PAYMENT_FILTER_OUTPUT || '/tmp/apple-payment-filters-h5-20261011';

/** 完全合成API下独立验收付款筛选、菜单、2×2操作与H5表格。 */
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [320, 375, 390, 768, 1440]) {
      for (const dispatch of [true, false]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          isMobile: width < 768,
          hasTouch: width < 768,
        });
        const requests = [];
        const errors = [];
        const tasks = Array.from({ length: 25 }, (_, index) => ({
          id: index + 1,
          orderId: 9101 + index,
          orderNumber: `W${7700000000 + index}`,
          products: [
            {
              name: index % 2 ? 'iPhone 18 Pro 256GB 蓝色' : 'iPhone 18 Pro Max 512GB 银色',
              quantity: 1,
            },
          ],
          paymentMethod: index % 2 ? 'ALIPAY' : 'WECHAT',
          processingStatus: 'pending',
          processingNotes: '合成备注',
          version: 0,
          recipientTag: index % 2 ? '合成TAG乙' : '合成TAG甲',
          assignee: { username: 'synthetic', nickname: '验收处理人' },
          orderDate: '2026-10-10T01:02:00Z',
          officialStatusObservedAt: '2026-10-11T02:03:00Z',
          officialRawStatus: [
            'PROCESSING | PAYMENT_PENDING',
            'READY_FOR_PICKUP',
            'MYSTERY_STATE',
            null,
          ][index % 4],
        }));
        await context.addInitScript(() =>
          localStorage.setItem('token', 'synthetic-payment-filter')
        );
        await context.route('**/*', async route => {
          try {
            const url = new URL(route.request().url());
            if (!url.pathname.startsWith('/api/')) {
              if (url.origin === origin) await route.continue();
              else await route.abort();
              return;
            }
            let data;
            if (url.pathname === '/api/auth/me')
              data = {
                id: 2,
                role: 'operator',
                username: 'synthetic',
                availableHome: dispatch ? '/payment-dispatch' : '/payment-tasks',
                permissions: [
                  'payment_dispatch.read',
                  'payment_dispatch.assign',
                  'payment_dispatch.correct',
                  'payment_tasks.read_own',
                  'payment_tasks.handle_own',
                  'payment_tasks.link.read_own',
                ],
              };
            else if (url.pathname === '/api/payment-dispatch/overview')
              data = { settings: { enabled: true, mode: 'auto', version: 0 }, staff: [] };
            else if (url.pathname === '/api/payment-dispatch/pending-overview')
              data = { count: 25 };
            else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(url.pathname)) {
              const query = Object.fromEntries(url.searchParams);
              requests.push(query);
              let matching = tasks;
              const states = query.officialOrderStatuses
                ? JSON.parse(query.officialOrderStatuses)
                : [];
              if (states.length)
                matching = matching.filter(task =>
                  states.some(state =>
                    state === '__not_observed__'
                      ? !task.officialRawStatus
                      : task.officialRawStatus?.split(' | ').includes(state)
                  )
                );
              const tags = query.recipientTags ? JSON.parse(query.recipientTags) : [];
              if (tags.length) matching = matching.filter(task => tags.includes(task.recipientTag));
              const products = query.productKeys ? JSON.parse(query.productKeys) : [];
              if (products.length)
                matching = matching.filter(task =>
                  products.includes(task.id % 2 ? 'silver' : 'blue')
                );
              if (query.orderNumber)
                matching = matching.filter(task => task.orderNumber.includes(query.orderNumber));
              const page = Number(query.page || 1);
              const limit = Number(query.limit || 20);
              data = {
                items: matching.slice((page - 1) * limit, page * limit),
                pagination: {
                  page,
                  limit,
                  total: matching.length,
                  totalPages: Math.ceil(matching.length / limit),
                },
                officialOrderStatuses: [
                  'PROCESSING',
                  'PAYMENT_PENDING',
                  'READY_FOR_PICKUP',
                  'MYSTERY_STATE',
                  '__not_observed__',
                ],
                recipientTagOptions: ['合成TAG甲', '合成TAG乙'],
                productOptions: [
                  {
                    value: 'silver',
                    label: 'iPhone 18 Pro Max 512GB 银色 · MG123CH/A',
                    aliases: ['MG123CH/A'],
                    count: 13,
                  },
                  {
                    value: 'blue',
                    label: 'iPhone 18 Pro 256GB 蓝色 · MG124CH/A',
                    aliases: ['MG124CH/A'],
                    count: 12,
                  },
                ],
                serverTime: new Date().toISOString(),
              };
            } else throw new Error(`未预期接口 ${url.pathname}`);
            await route.fulfill({ json: { success: true, data } });
          } catch (error) {
            errors.push(error.message);
            await route.abort();
          }
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        const tag = `${dispatch ? '调度' : '本人任务'}-${width}`;
        await page.goto(`${origin}/${dispatch ? 'payment-dispatch' : 'payment-tasks'}`);
        const table = page.locator('[data-payment-orders-table]');
        await table.getByText('订单 ID：9101', { exact: true }).waitFor();
        const checkQuery = async predicate => {
          for (let attempt = 0; attempt < 100 && !predicate(requests.at(-1)); attempt++)
            await new Promise(resolve => setTimeout(resolve, 25));
          assert.ok(predicate(requests.at(-1)), JSON.stringify(requests.at(-1)));
        };
        const checkRows = async count => {
          for (
            let attempt = 0;
            attempt < 100 && (await table.locator('tbody [data-label="订单"]').count()) !== count;
            attempt++
          )
            await new Promise(resolve => setTimeout(resolve, 25));
          assert.equal(await table.locator('tbody [data-label="订单"]').count(), count);
        };
        const openFilters = async () => {
          if (
            !dispatch &&
            width < 768 &&
            !(await page.getByRole('button', { name: '官网订单状态筛选', exact: true }).isVisible())
          )
            await page.getByRole('button', { name: '筛选任务', exact: true }).click();
        };
        const closePicker = async () => {
          if (width < 768) await page.getByRole('button', { name: /^完成/ }).click();
          else await page.keyboard.press('Escape');
        };
        const checkNoOverflow = async () =>
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true
          );
        if (width < 1024) await page.getByRole('button', { name: '打开导航', exact: true }).click();
        const links = await page
          .getByRole('navigation', { name: '主导航' })
          .locator('#navigation-payments a')
          .allTextContents();
        assert.deepEqual(
          links.map(text => text.trim()),
          ['付款调度', '付款任务']
        );
        if (width < 1024) await page.getByRole('button', { name: '关闭导航', exact: true }).click();
        await openFilters();
        assert.equal(
          await page.getByRole('button', { name: '邮件订单状态筛选', exact: true }).count(),
          0
        );
        await page.getByRole('button', { name: /^下单日期：/ }).click();
        const date = page.getByRole('dialog', { name: '下单日期选择', exact: true });
        await date.waitFor();
        const clearMetrics = await date
          .getByRole('button', { name: '清空', exact: true })
          .evaluate(button => {
            const box = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return { width: box.width, height: box.height, whiteSpace: style.whiteSpace };
          });
        if (width < 768)
          assert.ok(
            clearMetrics.width >= 44 && clearMetrics.height >= 44,
            '日期清空触控尺寸至少44px'
          );
        assert.equal(clearMetrics.whiteSpace, 'nowrap', '日期清空文字保持单行');
        await page.getByLabel('下单开始日期', { exact: true }).fill('2026-10-09');
        await date.getByRole('button', { name: '2026-10-09', exact: true }).click();
        await date.getByRole('button', { name: '2026-10-11', exact: true }).click();
        await date.getByRole('button', { name: '应用', exact: true }).click();
        await checkQuery(
          query =>
            query.dateFrom === '2026-10-09' && query.dateTo === '2026-10-11' && query.page === '1'
        );
        await openFilters();
        await page.getByRole('button', { name: /^下单日期：/ }).click();
        await date.getByRole('button', { name: '清空', exact: true }).click();
        await checkQuery(query => !query.dateFrom && !query.dateTo);
        await openFilters();
        await page.getByRole('button', { name: '官网订单状态筛选', exact: true }).click();
        await page.getByRole('option', { name: '待付款', exact: true }).click();
        await page.getByRole('option', { name: '可取货', exact: true }).click();
        await closePicker();
        await checkQuery(query => JSON.parse(query.officialOrderStatuses).length === 2);
        await checkRows(13);
        await openFilters();
        await page.getByRole('button', { name: 'TAG 筛选', exact: true }).click();
        await page.getByPlaceholder('搜索 TAG', { exact: true }).fill('甲');
        await page.getByRole('button', { name: 'TAG 筛选全选搜索结果', exact: true }).click();
        await closePicker();
        await checkQuery(
          query =>
            query.recipientTags === '["合成TAG甲"]' &&
            JSON.parse(query.officialOrderStatuses).length === 2 &&
            query.page === '1'
        );
        await checkRows(7);
        await openFilters();
        await page.getByRole('button', { name: 'TAG 筛选', exact: true }).click();
        await page.getByRole('button', { name: 'TAG 筛选全选', exact: true }).click();
        await closePicker();
        await checkQuery(query => JSON.parse(query.recipientTags).length === 2);
        await checkRows(13);
        await openFilters();
        await page.getByRole('button', { name: 'TAG 筛选', exact: true }).click();
        await page.getByRole('button', { name: '清空选择', exact: true }).click();
        await closePicker();
        await checkQuery(
          query => !query.recipientTags && JSON.parse(query.officialOrderStatuses).length === 2
        );
        await checkRows(13);
        await openFilters();
        await page.getByRole('button', { name: '官网订单状态筛选', exact: true }).click();
        await page.getByPlaceholder('搜索 官网状态', { exact: true }).fill('MYSTERY');
        await page.getByRole('option', { name: 'MYSTERY_STATE', exact: true }).waitFor();
        await page
          .getByRole('button', { name: '官网订单状态筛选全选搜索结果', exact: true })
          .click();
        await page.getByPlaceholder('搜索 官网状态', { exact: true }).fill('');
        await page.getByRole('button', { name: '官网订单状态筛选全选', exact: true }).click();
        await closePicker();
        await checkQuery(query => JSON.parse(query.officialOrderStatuses).length === 5);
        await openFilters();
        await page.getByRole('button', { name: '官网订单状态筛选', exact: true }).click();
        await page.getByRole('button', { name: '清空选择', exact: true }).click();
        await closePicker();
        await checkQuery(query => !query.officialOrderStatuses);
        await openFilters();
        await page.getByRole('button', { name: '商品信息筛选', exact: true }).click();
        const productOptions = await page
          .getByRole('listbox')
          .getByRole('option')
          .allTextContents();
        assert.equal(productOptions.length, 2);
        assert.ok(
          productOptions.every(text => !text.includes('MG123CH/A') && !text.includes('MG124CH/A'))
        );
        await page.getByPlaceholder('搜索 商品', { exact: true }).fill('银色');
        await page.getByRole('button', { name: '商品信息筛选全选搜索结果', exact: true }).click();
        await closePicker();
        await checkQuery(query => query.productKeys === '["silver"]');
        await openFilters();
        await page.getByRole('button', { name: '重置', exact: true }).click();
        await checkQuery(
          query => !query.productKeys && !query.officialOrderStatuses && !query.dateFrom
        );
        await openFilters();
        await page.getByPlaceholder('订单号', { exact: true }).fill('7700000000');
        await page.getByRole('button', { name: '筛选', exact: true }).click();
        await checkQuery(query => query.orderNumber === '7700000000');
        await checkRows(1);
        await openFilters();
        await page.getByRole('button', { name: '重置', exact: true }).click();
        await checkQuery(query => !query.orderNumber);
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        await checkQuery(query => query.page === '2');
        await checkRows(5);
        await openFilters();
        await page.getByRole('button', { name: '官网订单状态筛选', exact: true }).click();
        await page.getByRole('option', { name: 'MYSTERY_STATE', exact: true }).click();
        await closePicker();
        await checkQuery(
          query => query.page === '1' && query.officialOrderStatuses === '["MYSTERY_STATE"]'
        );
        await openFilters();
        await page.getByRole('button', { name: '重置', exact: true }).click();
        await checkQuery(query => !query.officialOrderStatuses);
        await checkNoOverflow();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${output}/${tag}-默认顶部.png` });
        await table.scrollIntoViewIfNeeded();
        await table.evaluate(element => {
          element.scrollLeft = 0;
        });
        await page.screenshot({ path: `${output}/${tag}-表格左侧.png` });
        assert.equal(
          await table.locator('table').evaluate(element => getComputedStyle(element).display),
          'table'
        );
        assert.ok(await table.evaluate(element => element.scrollWidth > element.clientWidth));
        await table.evaluate(element => {
          element.scrollLeft = element.scrollWidth;
        });
        const actions = table.locator('tbody tr').first().locator('.payment-order-actions');
        const buttons = actions.getByRole('button');
        assert.equal(await buttons.count(), 4);
        const boxes = await buttons.evaluateAll(elements =>
          elements.map(element => {
            const box = element.getBoundingClientRect();
            return { x: Math.round(box.x), y: Math.round(box.y) };
          })
        );
        assert.equal(new Set(boxes.map(box => box.x)).size, 2);
        assert.equal(new Set(boxes.map(box => box.y)).size, 2);
        await buttons.last().click();
        await page.getByRole('dialog', { name: '修改备注' }).waitFor();
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await page.screenshot({ path: `${output}/${tag}-四操作.png` });
        await page.evaluate(() => window.scrollTo(0, 0));
        await openFilters();
        await page.getByRole('button', { name: /^下单日期：/ }).click();
        await page.screenshot({ path: `${output}/${tag}-日期.png` });
        await date.getByRole('button', { name: '取消', exact: true }).click();
        await checkNoOverflow();
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
    process.stdout.write(
      'PASS: 两页320/375/390/768/1440、菜单顺序、2×2操作、日期选择清除、官网多选全选搜索、商品去SKU、TAG全选清空与官网组合、重置分页、H5横滚表格\n'
    );
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
