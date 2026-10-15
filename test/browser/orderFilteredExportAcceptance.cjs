/* eslint-env node, browser */
/* eslint-disable camelcase, no-magic-numbers -- 合成 API 字段、屏宽与测试样本数量 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const BASE_URL = process.env.EXPORT_BASE_URL || 'http://127.0.0.1:5173';
const OUTPUT = process.env.EXPORT_OUTPUT || '/tmp/order-filtered-export';
const PRODUCT_KEY = `name:${'a'.repeat(64)}`;
const FILTER_OPTIONS = {
  productOptions: [{ value: PRODUCT_KEY, label: '合成商品', count: 146 }],
  recipientTags: ['合成 TAG'],
  payers: ['合成付款人'],
  stores: ['Apple 合成门店'],
  officialOrderStatuses: ['PICKED_UP'],
};
const ORDERS = Array.from({ length: 146 }, (_, index) => ({
  id: index + 1,
  order_number: `W${String(index + 1).padStart(10, '0')}`,
  recipient_name: '合成取机人',
  recipient_tag: '合成 TAG',
  payer_name: '合成付款人',
  products: [],
  email_order_status: 'processing',
}));

/** 合成 API 验证实际按钮、请求和下载文件；禁止生产请求及业务写入。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  fs.mkdirSync(OUTPUT, { recursive: true });
  try {
    for (const width of [1440, 375]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        hasTouch: width === 375,
        serviceWorkers: 'block',
      });
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-export');
        localStorage.setItem('orderExportFields:v1', '["systemOrderId","orderNumber"]');
      });
      const exports = [];
      const queries = [];
      const errors = [];
      let failNextExport = false;
      let allowExport = true;
      let admin = true;
      await context.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === BASE_URL) await route.continue();
            else await route.abort();
            return;
          }
          assert.equal(route.request().method(), 'GET', '不允许业务写入');
          let data;
          if (url.pathname === '/api/auth/me') {
            data = {
              id: 1,
              role: admin ? 'admin' : 'operator',
              username: '合成导出验收',
              permissions: [
                'orders.read',
                ...(admin ? ['orders.edit'] : []),
                ...(allowExport ? ['orders.export'] : []),
              ],
              availableHome: '/orders',
            };
          } else if (url.pathname === '/api/orders/filter-options') data = FILTER_OPTIONS;
          else if (url.pathname === '/api/orders') {
            queries.push(Object.fromEntries(url.searchParams));
            const currentPage = Number(url.searchParams.get('page') || 1);
            const limit = Number(url.searchParams.get('limit') || 20);
            const rows = url.searchParams.get('keyword') === '空结果' ? [] : ORDERS;
            data = {
              total: rows.length,
              orders: rows.slice((currentPage - 1) * limit, currentPage * limit),
            };
          } else if (url.pathname === '/api/orders/export') {
            exports.push(Object.fromEntries(url.searchParams));
            if (failNextExport) {
              failNextExport = false;
              await route.fulfill({
                status: 500,
                json: { success: false, error: { message: '合成导出失败' } },
              });
              return;
            }
            const ids = url.searchParams.has('orderIds')
              ? JSON.parse(url.searchParams.get('orderIds'))
              : ORDERS.map(order => order.id);
            const book = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(
              book,
              XLSX.utils.json_to_sheet(
                ids.map(id => ({ 订单ID: id, 订单号: ORDERS[id - 1].order_number }))
              ),
              '订单'
            );
            await route.fulfill({
              contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              body: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
            });
            return;
          } else throw new Error(`意外 API ${url.pathname}`);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${BASE_URL}/orders`);
      const exportButton = page.getByRole('button', { name: '导出选中订单', exact: true });
      await page.getByRole('button', { name: '全选筛选结果（146）', exact: true }).waitFor();
      assert(await exportButton.isDisabled(), '空选择应禁用');
      if (width < 768) await page.getByRole('button', { name: /筛选条件.*展开/ }).click();
      for (const [label, option] of [
        ['付款人筛选', '合成付款人'],
        ['取机人 TAG 筛选', '合成 TAG'],
        ['取货门店筛选', 'Apple 合成门店'],
        ['商品信息筛选', '合成商品（146）'],
        ['邮件订单状态筛选', '处理中'],
        ['官网订单状态筛选', '已取货'],
      ]) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.getByRole('option', { name: option, exact: true }).click();
        if (width < 768) await page.getByRole('button', { name: /^完成/ }).click();
        else await page.locator('input[placeholder^="搜索 "]').press('Escape');
      }
      await page.getByRole('button', { name: /^下单日期：/ }).click();
      await page.getByLabel('下单开始日期', { exact: true }).fill('2026-09-01');
      await page.getByLabel('下单结束日期', { exact: true }).fill('2026-10-15');
      await page.getByRole('dialog').getByRole('button', { name: '应用', exact: true }).click();
      await page.getByPlaceholder(/搜索订单 ID/).fill('合成取机人');
      await page.getByRole('button', { name: '全选筛选结果（146）', exact: true }).click();
      await exportButton.click();
      await page.getByText(/将导出全部筛选结果（当前 146 个订单）/).waitFor();
      await page.screenshot({ path: path.join(OUTPUT, `筛选全选导出-${width}.png`) });
      const downloadAndRead = async (name, expectedIds) => {
        try {
          const pending = page.waitForEvent('download');
          await page.getByRole('button', { name: '导出 Excel', exact: true }).click();
          const download = await pending;
          const destination = path.join(OUTPUT, `${name}-${width}.xlsx`);
          await download.saveAs(destination);
          const workbook = XLSX.readFile(destination);
          const rows = XLSX.utils.sheet_to_json(workbook.Sheets['订单']);
          assert.deepEqual(
            rows.map(row => row['订单ID']),
            expectedIds
          );
          await page.getByRole('dialog').waitFor({ state: 'hidden' });
        } catch (error) {
          throw new Error(`${name}: ${error.message}`, { cause: error });
        }
      };
      await downloadAndRead(
        '全部146单',
        ORDERS.map(order => order.id)
      );
      const filterQuery = exports.at(-1);
      for (const key of [
        'payerNames',
        'recipientTags',
        'pickupStores',
        'productKeys',
        'displayOrderStatuses',
        'officialOrderStatuses',
      ]) {
        assert.deepEqual(JSON.parse(filterQuery[key]), JSON.parse(queries.at(-1)[key]));
      }
      assert.equal(filterQuery.keyword, '合成取机人');
      assert.equal(filterQuery.dateFrom, '2026-09-01');
      assert.equal(filterQuery.dateTo, '2026-10-15');
      assert.equal(filterQuery.dateFrom, queries.at(-1).dateFrom);
      assert.equal(filterQuery.dateTo, queries.at(-1).dateTo);
      assert.equal(filterQuery.orderIds, undefined);
      assert.equal(filterQuery.page, undefined);
      assert.equal(filterQuery.limit, undefined);
      assert.deepEqual(JSON.parse(filterQuery.fields), ['systemOrderId', 'orderNumber']);
      // 翻页会清空当前页 selectedIds，但筛选全选仍应可导出完整结果。
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.getByText('订单 ID：21', { exact: true }).filter({ visible: true }).waitFor();
      await exportButton.click();
      await downloadAndRead(
        '翻页后全部146单',
        ORDERS.map(order => order.id)
      );
      assert.equal(exports.at(-1).orderIds, undefined);
      // 保持原有语义：全选筛选后取消单行会退出到当前页明确选择，不再导出全筛选。
      await page.getByRole('button', { name: '全选筛选结果（146）', exact: true }).click();
      await page.getByRole('checkbox', { name: '选择订单 W0000000021', exact: true }).uncheck();
      await exportButton.click();
      await page.getByText('将导出当前页已选择的 19 个订单').waitFor();
      await downloadAndRead(
        '当前页排除一单',
        Array.from({ length: 19 }, (_, index) => index + 22)
      );
      assert.equal(exports.at(-1).payerNames, undefined);
      await page.getByRole('button', { name: '取消选择', exact: true }).click();
      assert(await exportButton.isDisabled());
      await page.getByRole('button', { name: '全选本页', exact: true }).click();
      await exportButton.click();
      await page.getByRole('button', { name: '清空', exact: true }).click();
      assert(await page.getByRole('button', { name: '导出 Excel', exact: true }).isDisabled());
      await page.getByRole('checkbox', { name: '系统订单 ID', exact: true }).check();
      failNextExport = true;
      await page.getByRole('button', { name: '导出 Excel', exact: true }).click();
      await page.getByRole('dialog').getByRole('alert').waitFor();
      assert.match(
        await page.getByRole('dialog').getByRole('alert').innerText(),
        /服务器错误|合成导出失败/
      );
      assert(await page.getByRole('button', { name: '导出 Excel', exact: true }).isEnabled());
      await downloadAndRead(
        '失败后重试本页20单',
        Array.from({ length: 20 }, (_, index) => index + 21)
      );
      await page.getByRole('button', { name: '全选筛选结果（146）', exact: true }).click();
      await Promise.all([
        page.waitForResponse(
          response =>
            new URL(response.url()).pathname === '/api/orders' &&
            new URL(response.url()).searchParams.get('keyword') === '空结果'
        ),
        page.getByPlaceholder(/搜索订单 ID/).fill('空结果'),
      ]);
      await page.getByText('已选择 0 项（当前页）').waitFor();
      assert(await exportButton.isDisabled(), '筛选变化及空结果必须清空选择');
      // 导出权限不隐式授予官网编辑权限；仅导出账号仍可手选。
      admin = false;
      await page.reload();
      await page.getByRole('checkbox', { name: '选择订单 W0000000001', exact: true }).check();
      await exportButton.click();
      await downloadAndRead('仅导出权限手选一单', [1]);
      assert.equal(
        await page.getByRole('button', { name: '全选筛选结果（146）', exact: true }).count(),
        0
      );
      allowExport = false;
      await page.reload();
      await page.getByText('订单 ID：1', { exact: true }).filter({ visible: true }).waitFor();
      assert.equal(await exportButton.count(), 0);
      assert.equal(await page.getByRole('checkbox', { name: /选择订单/ }).count(), 0);
      assert.deepEqual(errors, []);
      process.stdout.write(
        `${width}px：筛选146单/翻页/取消单行/本页/空选择/失败重试/权限/下载读回通过\n`
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
