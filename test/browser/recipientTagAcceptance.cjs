/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成 API 契约字段 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const origin = process.env.TAG_TEST_ORIGIN || 'http://127.0.0.1:5173';
const output = process.env.TAG_TEST_OUTPUT || '/tmp/apple-recipient-tag-acceptance';

/** 真实 Chrome 合成 API 验证订单与付款 TAG 无来源回退、详情来源留存及响应式布局。 */
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
        ['present', 'unlinked', 'missing'].map((state, index) => ({
          id: index + 1,
          order_number: `W990000000${index + 1}`,
          products: [],
          ingestion_source: index === 1 ? 'email' : 'aos',
          source_recipient_tag: 'AOS历史TAG',
          recipient_tag: index === 0 ? currentTag : null,
          recipient_tag_state: state,
          recipient_ref: index === 1 ? null : index + 1,
          recipient_name: `合成取机人${index + 1}`,
          recipient: index === 1 ? null : { name: `合成取机人${index + 1}` },
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
                sourceRecipientTag: 'AOS历史TAG',
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
        for (const label of [currentTag, '未关联取机人', '未设置 TAG'])
          await page.getByText(label, { exact: true }).filter({ visible: true }).first().waitFor();
        assert.equal(await page.getByText('AOS历史TAG', { exact: true }).count(), 0);
        assert.equal(await page.getByText('与档案 TAG 不同', { exact: false }).count(), 0);
        await page.screenshot({
          path: `${output}/${pathname.slice(1)}-${width}.png`,
          fullPage: true,
        });
        const tagHeader = page.getByRole('columnheader', {
          name: pathname === '/orders' ? 'TAG' : '取机人TAG',
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
      await modal.getByText(currentTag, { exact: true }).waitFor();
      await modal.getByText('AOS历史TAG', { exact: true }).waitFor();
      await page.screenshot({
        path: `${output}/order-modal-current-tag-${width}.png`,
        fullPage: true,
      });
      await page.getByRole('button', { name: '关闭订单详情', exact: true }).click();
      currentTag = '档案TAG甲';
      for (const id of [1, 2, 3]) {
        await page.goto(`${origin}/orders/${id}`);
        await page.getByText('来源 TAG（历史记录）', { exact: true }).waitFor();
        await page.getByText('AOS历史TAG', { exact: true }).waitFor();
        await page
          .getByText(id === 1 ? currentTag : id === 2 ? '未关联取机人' : '未设置 TAG', {
            exact: true,
          })
          .waitFor();
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
      assert.equal(
        await page.getByRole('button', { name: '关联历史订单', exact: true }).count(),
        mode === 'all' ? 1 : 0
      );
      if (mode === 'all') await tagInput.fill('档案TAG乙');
      await page.getByRole('textbox', { name: '备注', exact: true }).fill('更新普通资料');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(writes.length, 1);
      assert.equal(Object.hasOwn(writes[0], 'tag'), mode === 'all');
      if (mode === 'all') assert.equal(writes[0].tag, '档案TAG乙');
      assert.deepEqual(errors, []);
      await context.close();
    }
    process.stdout.write(
      `PASS: 375/1440px订单、本人任务、付款调度三状态/无回退、详情来源留存、重新查询实时变化、有限范围档案TAG禁用及普通资料保存不带TAG。截图 ${output}\n`
    );
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
