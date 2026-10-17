/* eslint-env node, browser */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { chooseSelect } = require('./responsiveSelectSupport.cjs');
const input = require('../../src/utils/proxyOrderInput');
const origin = process.env.PROXY_MULTI_CITY_ORIGIN || 'http://127.0.0.1:5373';
const output = process.env.PROXY_MULTI_CITY_OUTPUT || '.tmp/proxy-multi-city/attempt-001/browser';
const expectedCodes = ['R484', 'R577', 'R639', 'R761', 'R793'];
const sorted = values => [...values].sort();
const source =
  '姓名：合成测试\n身份证后四位：000X\n手机号：13800000001\n邮箱：synthetic-multicity@example.com\n机型：Duo 白色512\n支付方式：微信\n取机城市：广州、深圳全店\n订单来源：闲鱼';

/** 真实本地React/Chrome交互，所有API合成拦截且禁止外部网络。 */
async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const metrics = [];
  try {
    for (const width of [375, 390, 430, 1366, 1920]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const calls = [],
        errors = [];
      const parsed = input.parseProxyText(source);
      assert.equal(parsed.canSave, true, JSON.stringify(parsed.errors));
      const base = {
        ...parsed.draft,
        status: 'pending',
        version: 1,
        assignments: [],
        createdAt: '2026-10-17T02:00:00Z',
        updatedAt: '2026-10-17T02:00:00Z',
      };
      let orders = [
        { ...base, id: 1 },
        { ...base, id: 2, firstName: '固化', storeCodes: ['R577', 'R484'] },
        {
          ...base,
          id: 3,
          firstName: '旧单',
          storeCities: undefined,
          storeCity: '广州',
          storeCodes: ['R577'],
          storeMode: 'selected',
        },
      ];
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-multicity'));
      await context.route('**/*', async route => {
        try {
          const request = route.request(),
            url = new URL(request.url()),
            path = url.pathname;
          if (!path.startsWith('/api/')) {
            if (url.origin === origin) await route.continue();
            else await route.abort();
            return;
          }
          const method = request.method(),
            body = request.postDataJSON();
          calls.push({ path, method, body });
          let data;
          if (path === '/api/auth/me')
            data = {
              id: 1,
              username: 'synthetic',
              role: 'operator',
              permissions: ['proxy_orders.read'],
              availableHome: '/proxy-orders',
            };
          else if (path.endsWith('/stores')) data = input.STORES;
          else if (path.endsWith('/catalog'))
            data = {
              productCandidates: input.PRODUCT_CANDIDATES,
              paymentMethods: input.PAYMENT_METHODS,
            };
          else if (path.endsWith('/parse')) data = input.parseProxyText(body.text);
          else if (path.endsWith('/address')) data = input.generateProxyAddress(body.storeCode);
          else if (path === '/api/proxy-orders' && method === 'GET')
            data = {
              rows: orders,
              count: orders.length,
            };
          else if (path === '/api/proxy-orders' && method === 'POST') {
            const id = 4;
            orders.push({ ...body, id, version: 1, status: 'pending', assignments: [] });
            data = { id, version: 1, assigned: 0, assignmentStatus: 'awaiting_account' };
          } else if (/^\/api\/proxy-orders\/\d+$/.test(path)) {
            const id = Number(path.split('/').pop());
            if (method === 'PUT') {
              orders = orders.map(row =>
                row.id === id ? { ...row, ...body, version: row.version + 1 } : row
              );
              data = { id, version: orders.find(row => row.id === id).version };
            } else
              data = {
                ...orders.find(row => row.id === id),
                events: [],
                links: [],
                officialOrders: [],
              };
          } else throw new Error(`未声明的合成API ${method} ${path}`);
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data }),
          });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/proxy-orders');
      const setChecked = async (control, checked) => {
        try {
          if ((await control.isChecked()) === checked) return;
          const element = await control.elementHandle();
          await control.click();
          await page.waitForFunction(
            ([node, desired]) => node.checked === desired,
            [element, checked]
          );
        } catch (error) {
          throw new Error(`复选框交互失败: ${error.message}`, { cause: error });
        }
      };
      const entry = id =>
        page
          .locator(width < 768 ? 'article[data-proxy-order-id]' : 'tbody tr')
          .filter({ has: page.getByRole('checkbox', { name: `选择 ${id}`, exact: true }) });
      const edit = async id => {
        try {
          await entry(id).getByRole('button', { name: /详情/ }).click();
          await page
            .getByRole('dialog')
            .getByRole('button', { name: '编辑资料', exact: true })
            .click();
          return page.getByRole('dialog');
        } catch (error) {
          throw new Error(`独立合成验收步骤失败: ${error.message}`, { cause: error });
        }
      };
      const save = async dialog => {
        try {
          const loaded = page.waitForResponse(
            response =>
              new URL(response.url()).pathname === '/api/proxy-orders' &&
              response.request().method() === 'GET'
          );
          await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
          await loaded;
          await entry(1).waitFor();
        } catch (error) {
          throw new Error(`独立合成验收步骤失败: ${error.message}`, { cause: error });
        }
      };
      await entry(1).waitFor();
      assert.ok((await entry(1).innerText()).includes('广州'));
      assert.ok((await entry(1).innerText()).includes('深圳'));
      assert.equal(
        await page.locator('body').evaluate(node => node.scrollWidth <= innerWidth),
        true
      );
      await page.screenshot({ path: `${output}/${width}-list.png` });
      let dialog = await edit(1);
      assert.equal(
        await dialog.getByRole('checkbox', { name: '广州', exact: true }).isChecked(),
        true
      );
      assert.equal(
        await dialog.getByRole('checkbox', { name: '深圳', exact: true }).isChecked(),
        true
      );
      for (const name of ['天环广场', '珠江新城', '益田假日广场', '万象城', '前海壹方城'])
        assert.ok((await dialog.innerText()).includes(name));
      await dialog.getByLabel('备注', { exact: true }).fill('多城市不丢失');
      await page.screenshot({ path: `${output}/${width}-edit-full.png` });
      await save(dialog);
      assert.deepEqual(
        sorted(calls.filter(call => call.method === 'PUT').at(-1).body.storeCodes),
        expectedCodes
      );
      dialog = await edit(2);
      await dialog.getByLabel('备注', { exact: true }).fill('固定两店不扩张');
      await save(dialog);
      assert.deepEqual(sorted(orders.find(row => row.id === 2).storeCodes), ['R484', 'R577']);
      dialog = await edit(3);
      assert.equal(
        await dialog.getByRole('checkbox', { name: '广州', exact: true }).isChecked(),
        true
      );
      assert.equal(
        await dialog.getByRole('checkbox', { name: '深圳', exact: true }).isChecked(),
        false
      );
      await save(dialog);
      assert.deepEqual(orders.find(row => row.id === 3).storeCodes, ['R577']);
      dialog = await edit(1);
      await setChecked(dialog.getByRole('checkbox', { name: '广州', exact: true }), false);
      await page.waitForFunction(
        () => !document.querySelector('.proxy-store-scope-summary')?.textContent.includes('广州')
      );
      await save(dialog);
      assert.deepEqual(sorted(orders.find(row => row.id === 1).storeCodes), [
        'R484',
        'R761',
        'R793',
      ]);
      dialog = await edit(1);
      await setChecked(dialog.getByRole('checkbox', { name: '广州', exact: true }), true);
      await chooseSelect(dialog.getByLabel('选择方式', { exact: true }), 'selected');
      const shops = dialog.getByRole('group', { name: '指定门店（可跨城市多选）' });
      await shops.getByRole('checkbox').first().waitFor();
      for (const checkbox of await shops.getByRole('checkbox').all()) {
        const label = await checkbox.evaluate(node => node.parentElement.textContent);
        await setChecked(checkbox, label.includes('天环广场') || label.includes('益田假日广场'));
      }
      if (width < 768) {
        const controls = await dialog
          .locator('.proxy-city-option, .proxy-store-option')
          .evaluateAll(nodes =>
            nodes
              .filter(node => node.getClientRects().length)
              .map(node => ({
                width: node.getBoundingClientRect().width,
                height: node.getBoundingClientRect().height,
              }))
          );
        assert.ok(controls.length >= 5);
        assert.ok(controls.every(control => control.width >= 44 && control.height >= 44));
      }
      await dialog.getByRole('checkbox', { name: '广州', exact: true }).focus();
      assert.equal(
        await dialog
          .getByRole('checkbox', { name: '广州', exact: true })
          .evaluate(node => node === document.activeElement),
        true
      );
      await page.screenshot({ path: `${output}/${width}-selected.png` });
      await save(dialog);
      assert.deepEqual(sorted(orders.find(row => row.id === 1).storeCodes), ['R484', 'R577']);
      await page.getByRole('button', { name: '登记代抢', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('客户抢购信息').fill(source);
      await dialog.getByRole('button', { name: '识别并预览', exact: true }).click();
      await dialog.getByRole('checkbox', { name: '广州', exact: true }).waitFor();
      assert.equal(
        await dialog.getByRole('checkbox', { name: '深圳', exact: true }).isChecked(),
        true
      );
      await save(dialog);
      assert.deepEqual(sorted(orders.find(row => row.id === 4).storeCodes), expectedCodes);
      assert.deepEqual(errors, []);
      metrics.push({ width, passed: true, externalRequestsAllowed: false, realBusinessWrites: 0 });
      process.stdout.write(
        `PASS ${width}px 多城市展示/编辑/固化子集/旧DTO/改变城市/跨城市指定店/解析登记\n`
      );
      await context.close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(`${output}/metrics.json`, JSON.stringify(metrics, null, 2));
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
