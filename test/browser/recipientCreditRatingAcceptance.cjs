/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成 API 字段 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const origin = 'http://127.0.0.1:5173';
const output = '/tmp/recipient-credit-rating-acceptance';

/** 以合成接口验证信用评级与旧渠道列配置，全部请求隔离于业务 API。 */
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1440, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 960 } });
      let rating = null;
      const writes = [];
      const errors = [];
      const recipient = () => ({
        id: 1, name: '合成测试', last_name: '合成', first_name: '测试',
        id_card_number: '110101199001010001', tag: '测试TAG', channel: '历史渠道',
        credit_rating: rating, status: '未使用', created_at: '2026-10-16T00:00:00Z',
      });
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-credit-rating');
        localStorage.setItem('columnConfig:recipients', JSON.stringify({ columns: [
          { key: 'name', visible: true }, { key: 'channel', visible: true },
          { key: 'actions', visible: true },
        ] }));
      });
      await context.route('**/*', async route => {
        try {
          const req = route.request();
          const url = new URL(req.url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === origin) await route.continue();
            else await route.abort();
            return;
          }
          let data;
          if (url.pathname === '/api/auth/me') data = {
            id: 1, role: 'operator', username: '合成验收', availableHome: '/recipients',
            orderAccess: { mode: 'all' },
            permissions: ['recipients.read', 'recipients.create', 'recipients.edit'],
          };
          else if (url.pathname === '/api/recipients/filter-options')
            data = { tags: ['测试TAG'], channels: ['历史渠道'] };
          else if (['POST', 'PUT'].includes(req.method()) && /^\/api\/recipients(\/1)?$/.test(url.pathname)) {
            const payload = req.postDataJSON();
            assert.equal(Object.hasOwn(payload, 'channel'), false);
            writes.push(payload);
            rating = payload.creditRating || null;
            data = recipient();
          } else if (url.pathname === '/api/recipients') {
            assert.equal(url.searchParams.has('channels'), false);
            data = { recipients: [recipient()], total: 1 };
          } else if (url.pathname === '/api/recipients/1') data = recipient();
          else throw new Error(`未预期接口：${url.pathname}`);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/recipients`);
      const header = page.getByRole('columnheader', { name: '信用评级', exact: true });
      await header.waitFor();
      assert.equal(await page.getByText('渠道', { exact: true }).count(), 0);
      assert.equal(await page.getByLabel('渠道筛选').count(), 0);
      await page.getByRole('button', { name: '列设置', exact: true }).click();
      assert.equal(await page.getByText('渠道', { exact: true }).count(), 0);
      await page.getByRole('button', { name: '保存', exact: false }).click();
      const choose = async value => {
        if (width < 768) {
          await page.getByRole('button', { name: '信用评级', exact: true }).click();
          await page.getByRole('option', { name: value || '未评级', exact: true }).click();
        } else await page.getByLabel('信用评级', { exact: true }).selectOption(value);
      };
      for (const value of ['A', 'B', 'C', '']) {
        await page.getByLabel('编辑取机人 1').click();
        const dialog = page.getByRole('dialog', { name: '编辑取机人' });
        await dialog.waitFor();
        assert.equal(await dialog.getByLabel('渠道', { exact: true }).count(), 0);
        await choose(value);
        await dialog.getByRole('button', { name: '保存', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(writes.at(-1).creditRating, value);
        await page.getByRole('cell', { name: value || '—', exact: true }).waitFor();
        await page.getByRole('button', { name: '合成测试', exact: true }).click();
        const details = page.getByRole('dialog', { name: '档案详情' });
        await details.getByText(`信用评级：${value || '未评级'}`, { exact: false }).waitFor();
        assert.equal(await details.getByText('历史渠道', { exact: false }).count(), 0);
        await details.getByRole('button', { name: '关闭', exact: true }).last().click();
      }
      await page.getByRole('button', { name: '添加取机人', exact: true }).click();
      const add = page.getByRole('dialog', { name: '添加取机人' });
      await add.getByLabel('姓 *', { exact: true }).fill('合成');
      await add.getByLabel('名 *', { exact: true }).fill('新增');
      await add.getByLabel('身份证号 *', { exact: true }).fill('110101199001010002');
      await choose('B');
      await page.screenshot({ path: `${output}/form-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await add.getByRole('button', { name: '保存', exact: true }).click();
      await add.waitFor({ state: 'hidden' });
      assert.equal(writes.at(-1).creditRating, 'B');
      await page.getByRole('cell', { name: 'B', exact: true }).waitFor();
      await header.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/list-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
      process.stdout.write(`${width}px：旧列配置、渠道隐藏、A/B/C/清空、新增、详情和布局通过\n`);
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
