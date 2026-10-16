/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成 API 契约字段 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const origin = process.env.TAG_TEST_ORIGIN || 'http://127.0.0.1:5173';
const output = process.env.TAG_TEST_OUTPUT || '/tmp/apple-recipient-tag-acceptance';

/** 真实 Chrome 合成 API 验证订单与付款 TAG 来源优先、身份兜底与缺失状态及响应式布局。 */
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [375, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        serviceWorkers: 'block',
      });
      const errors = [];
      let currentTag = '档案TAG甲';
      const orders = () =>
        ['present', 'present', 'missing'].map((state, index) => ({
          id: index + 1,
          order_number: `W990000000${index + 1}`,
          products: [],
          ingestion_source: 'aos',
          source_recipient_tag: index === 0 ? 'AOS历史TAG' : null,
          recipient_tag: index === 0 ? 'AOS历史TAG' : index === 1 ? currentTag : null,
          recipient_tag_source: index === 0 ? 'aos' : index === 1 ? 'recipient' : null,
          recipient_tag_state: state,
          recipient_ref: null,
          recipient_name: `合成取机人${index + 1}`,
          recipient: index === 1 ? { id: 99, name: '历史错关联姓名' } : null,
          order_date: '2026-10-14T01:00:00Z',
          email_order_status: 'processing',
        }));
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-recipient-tag'));
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
              id: 1,
              role: 'operator',
              username: 'TAG验收',
              availableHome: '/orders',
              orderAccess: { mode: 'all', tags: [] },
              permissions: ['orders.read', 'payment_dispatch.read', 'payment_tasks.read_own'],
            };
          else if (url.pathname === '/api/orders/filter-options')
            data = {
              recipientTags: [currentTag],
              productOptions: [],
              stores: [],
              payers: [],
              officialOrderStatuses: [],
            };
          else if (url.pathname === '/api/orders') data = { orders: orders(), total: 3 };
          else if (/^\/api\/orders\/\d+$/.test(url.pathname))
            data = orders().find(order => order.id === Number(url.pathname.split('/').pop()));
          else if (/^\/api\/orders\/\d+\/link$/.test(url.pathname)) data = { orderUrl: null };
          else if (/^\/api\/orders\/\d+\/devices$/.test(url.pathname)) data = { items: [] };
          else if (url.pathname === '/api/payment-dispatch/overview')
            data = { settings: { enabled: true, mode: 'auto', version: 0 }, staff: [] };
          else if (url.pathname === '/api/payment-dispatch/pending-overview') data = { count: 0 };
          else if (['/api/payment-tasks', '/api/payment-dispatch/tasks'].includes(url.pathname))
            data = {
              items: orders().map(order => ({
                id: order.id,
                orderId: order.id,
                orderNumber: order.order_number,
                products: [],
                recipientTag: order.recipient_tag,
                recipientTagState: order.recipient_tag_state,
                recipientTagSource: order.recipient_tag_source,
                sourceRecipientTag: order.source_recipient_tag,
                processingStatus: 'pending',
                assignee: { username: '合成账号' },
              })),
              pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
              recipientTagOptions: [currentTag],
              productOptions: [],
              officialOrderStatuses: [],
              serverTime: new Date().toISOString(),
            };
          else throw new Error(`未预期接口 ${url.pathname}`);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      for (const pathname of ['/orders', '/payment-tasks', '/payment-dispatch']) {
        await page.goto(`${origin}${pathname}`);
        for (const label of [currentTag, 'AOS历史TAG', 'TAG 缺失'])
          await page.getByText(label, { exact: true }).filter({ visible: true }).first().waitFor();
        assert.ok((await page.getByText('AOS历史TAG', { exact: true }).count()) > 0);
        assert.equal(await page.getByText('与档案 TAG 不同', { exact: false }).count(), 0);
        await page.screenshot({
          path: `${output}/${pathname.slice(1)}-${width}.png`,
          fullPage: true,
        });
        const tagHeader = page.getByRole('columnheader', {
          name: pathname === '/orders' ? 'TAG' : '订单TAG',
          exact: true,
        });
        if (await tagHeader.isVisible()) {
          await tagHeader.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${output}/${pathname.slice(1)}-tag-column-${width}.png`,
            fullPage: true,
          });
        }
      }
      await page.goto(`${origin}/orders`);
      await page
        .getByRole('button', { name: '查看', exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      currentTag = '详情读取最新TAG';
      await page
        .getByRole('button', { name: '查看', exact: true })
        .filter({ visible: true })
        .first()
        .click();
      const modal = page.locator('.order-detail-modal');
      await modal.getByText('AOS历史TAG', { exact: true }).first().waitFor();
      assert.equal(await modal.getByText(currentTag, { exact: true }).count(), 0);
      await page.screenshot({
        path: `${output}/order-modal-current-tag-${width}.png`,
        fullPage: true,
      });
      await page.getByRole('button', { name: '关闭订单详情', exact: true }).click();
      currentTag = '档案TAG甲';
      for (const id of [1, 2, 3]) {
        await page.goto(`${origin}/orders/${id}`);
        await page.getByText('AOS 原始 TAG', { exact: true }).first().waitFor();
        await page
          .getByText(id === 1 ? 'AOS历史TAG' : id === 2 ? currentTag : 'TAG 缺失', {
            exact: false,
          })
          .first()
          .waitFor();
        if (id === 2) {
          await page.getByText('合成取机人2', { exact: false }).first().waitFor();
          assert.equal(await page.getByText('历史错关联姓名', { exact: false }).count(), 0);
        }
      }
      await page.screenshot({
        path: `${output}/order-detail-missing-${width}.png`,
        fullPage: true,
      });
      currentTag = '档案TAG乙';
      await page.goto(`${origin}/orders`);
      await page.getByText(currentTag, { exact: true }).filter({ visible: true }).first().waitFor();
      assert.equal(await page.getByText('档案TAG甲', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
    for (const mode of ['tags', 'all']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const writes = [];
      const importWrites = [];
      const importPlan = reviewed => ({
        sessionToken: 'synthetic-import-session',
        summary: { total: 2, records: 2, invalid: 0, conflicts: 0, blocked: 0 },
        records: [
          {
            id: 'restricted',
            kind: 'recipient',
            label: '受限身份档案',
            action: reviewed ? 'skip' : 'update',
            sources: ['合成来源第1行'],
            fields: {},
            problems: [],
            requiresAllOrderScope: !reviewed,
          },
          {
            id: 'safe',
            kind: 'recipient',
            label: '安全联系方式更新',
            action: 'update',
            sources: ['合成来源第2行'],
            fields: { notes: '合成备注' },
            problems: [],
            requiresAllOrderScope: false,
          },
        ],
        errors: [],
        conflicts: [],
        warnings: [],
      });
      const errors = [];
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-tag-scope'));
      await context.route('**/*', async route => {
        try {
          const request = route.request();
          const url = new URL(request.url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === origin) await route.continue();
            else await route.abort();
            return;
          }
          let data;
          if (url.pathname === '/api/auth/me')
            data = {
              id: 1,
              role: 'operator',
              username: '范围验收',
              availableHome: '/recipients',
              orderAccess: { mode, tags: ['档案TAG甲'] },
              permissions: [
                'recipients.read',
                'recipients.edit',
                'recipients.delete',
                'recipients.import',
                'orders.read',
                'orders.edit',
                'apple_ids.read',
              ],
            };
          else if (url.pathname === '/api/recipients/filter-options')
            data = { tags: ['档案TAG甲'], channels: [] };
          else if (url.pathname === '/api/recipients')
            data = {
              recipients: [
                {
                  id: 1,
                  name: '合成测试',
                  first_name: '测试',
                  last_name: '合成',
                  id_card_number: '110101199001010001',
                  tag: '档案TAG甲',
                  status: '未使用',
                },
              ],
              total: 1,
            };
          else if (url.pathname === '/api/recipients/1') {
            writes.push(request.postDataJSON());
            data = {};
          } else if (url.pathname === '/api/import/preview') {
            data = importPlan(false);
          } else if (url.pathname === '/api/import/review') {
            assert.equal(request.postDataJSON().decisions['restricted:skip'], true);
            data = importPlan(true);
          } else if (url.pathname === '/api/import/execute') {
            importWrites.push(request.postDataJSON());
            data = { imported: 0, updated: 1, skipped: 1, errors: [] };
          } else throw new Error(`未预期接口 ${url.pathname}`);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      await page.goto(`${origin}/recipients`);
      await page.getByRole('button', { name: '编辑取机人 1' }).click();
      const tagInput = page.getByRole('textbox', { name: 'TAG', exact: true });
      assert.equal(await tagInput.isDisabled(), mode === 'tags');
      for (const name of ['姓 *', '名 *', '身份证号 *'])
        assert.equal(
          await page.getByRole('textbox', { name, exact: true }).isDisabled(),
          mode === 'tags'
        );
      assert.equal(
        await page.getByRole('button', { name: '关联历史订单', exact: true }).count(),
        mode === 'all' ? 1 : 0
      );
      if (mode === 'all') await tagInput.fill('档案TAG乙');
      await page.getByRole('textbox', { name: '备注', exact: true }).fill('更新普通资料');
      await page.getByRole('textbox', { name: '下单手机号', exact: true }).fill('13800001234');
      await page.getByRole('textbox', { name: '街道地址', exact: true }).fill('合成安全地址');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(writes.length, 1);
      assert.equal(Object.hasOwn(writes[0], 'tag'), mode === 'all');
      for (const key of ['lastName', 'firstName', 'idCardNumber'])
        assert.equal(Object.hasOwn(writes[0], key), mode === 'all');
      assert.equal(writes[0].phone, '13800001234');
      assert.equal(writes[0].streetAddress, '合成安全地址');
      assert.equal(writes[0].notes, '更新普通资料');
      if (mode === 'all') assert.equal(writes[0].tag, '档案TAG乙');
      if (mode === 'tags') {
        await page.getByRole('button', { name: '批量导入', exact: true }).click();
        await page.getByLabel('选择导入文件').setInputFiles({
          name: '合成权限验收.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: Buffer.from('synthetic-preview-only'),
        });
        await page.getByRole('button', { name: '生成预览', exact: true }).click();
        const execute = page.getByRole('button', { name: '确认导入有效档案', exact: true });
        await execute.waitFor();
        assert.equal(await execute.isDisabled(), true);
        await page
          .getByText('新增或修改身份／TAG，需要全部订单数据范围', { exact: true })
          .waitFor();
        await page.screenshot({ path: `${output}/import-restricted-1440.png`, fullPage: true });
        await page.getByRole('checkbox', { name: '跳过 受限身份档案', exact: true }).check();
        assert.equal(await execute.isDisabled(), true);
        assert.equal(importWrites.length, 0);
        await page.getByRole('button', { name: '更新预览', exact: true }).click();
        await page
          .getByText('新增或修改身份／TAG，需要全部订单数据范围', { exact: true })
          .waitFor({ state: 'hidden' });
        assert.equal(await execute.isDisabled(), false);
        await page.screenshot({ path: `${output}/import-safe-reviewed-1440.png`, fullPage: true });
        await execute.click();
        await page.getByText('导入完成：新增 0，更新 1，重复或跳过 1', { exact: false }).waitFor();
        assert.equal(importWrites.length, 1);
        assert.deepEqual(importWrites[0].decisions, { 'restricted:skip': true });
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    process.stdout.write(
      `PASS: 375/1440px订单、本人任务、付款调度来源优先/唯一身份兜底/缺失、详情来源留存、重新查询实时变化、有限范围身份字段禁用且安全字段提交不带身份/TAG、导入受限行禁执行及跳过重预览解除。截图 ${output}\n`
    );
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
