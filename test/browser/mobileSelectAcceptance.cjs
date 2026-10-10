/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成接口沿用既有字段名 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium, webkit } = require('playwright-core');
const engine = process.env.SELECT_ENGINE || 'chromium';
const base = process.env.SELECT_BASE_URL || 'http://127.0.0.1:5333';
const output = process.env.SELECT_OUTPUT_DIR || '.tmp/mobile-select-20261010/ui';
const products = [256, 512, 1024, 2048].flatMap(storageGb =>
  ['黑色', '银色', '勃艮第酒红色', '冰川蓝色'].map((colorName, index) => ({
    id: `p-${storageGb}-${index}`,
    modelName: 'iPhone 18 Pro Max',
    storageGb,
    colorName,
    entryEligible: true,
  }))
);
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await (engine === 'webkit'
    ? webkit.launch({ headless: true })
    : chromium.launch({ channel: 'chrome', headless: true }));
  try {
    for (const width of [375, 390, 767, 768, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        hasTouch: width < 768,
      });
      await context.addInitScript(() => {
        localStorage.setItem('token', 'synthetic-select');
        window.nativeSelectFocuses = 0;
        document.addEventListener('focusin', event => {
          if (event.target.tagName === 'SELECT') window.nativeSelectFocuses += 1;
        });
      });
      const errors = [],
        requests = [];
      await context.route('**/api/**', async route => {
        try {
          const url = new URL(route.request().url());
          assert.equal(route.request().method(), 'GET', '本验收不得提交业务');
          requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
          let data;
          if (url.pathname.endsWith('/auth/me'))
            data = {
              id: 1,
              role: 'admin',
              permissions: [
                'stock.read',
                'stock.receive',
                'stock.source.link',
                'stock.sales.read',
                'stock.settings',
                'orders.read',
                'apple_ids.read',
                'inventory.read',
              ],
              username: '合成下拉验收',
              availableHome: '/stock',
            };
          else if (url.pathname.endsWith('/stock/ledger/catalog'))
            data = {
              products,
              warehouses: [
                { id: 'w1', name: '长沙 明威' },
                { id: 'w2', name: '重庆 - 仓库名称较长的合成测试选项' },
              ],
              statisticWarehouses: [
                { id: 'w1', name: '长沙 明威' },
                { id: 'w2', name: '重庆 - 仓库名称较长的合成测试选项' },
              ],
              salespeople: [],
              handlers: [],
              filterOptions: {
                modelNames: ['iPhone 18 Pro Max'],
                storageGbs: [256, 512, 1024, 2048],
                colorNames: ['黑色', '银色'],
              },
            };
          else if (url.pathname.endsWith('/stock/ledger/statistics'))
            data = { items: [], models: [], states: [], warehouses: [], total: 0 };
          else if (url.pathname.endsWith('/stock/ledger'))
            data = {
              items: [],
              total: 0,
              counts: { pending: 0, inStock: 0, sold: 0, returned: 0 },
            };
          else if (url.pathname.endsWith('/orders/filter-options'))
            data = {
              productOptions: [
                {
                  value: 'name:' + 'a'.repeat(64),
                  label: 'iPhone 18 Pro Max 512GB 勃艮第酒红色',
                  count: 1,
                },
              ],
              recipientTags: ['长沙 明威', '重庆 合成测试'],
              payers: ['付款人甲'],
              stores: ['Apple 重庆解放碑'],
              officialOrderStatuses: ['PICKED_UP', 'RETURN_STARTED'],
            };
          else if (url.pathname.endsWith('/orders')) data = { orders: [], total: 0 };
          else if (url.pathname.endsWith('/inventory/catalog'))
            data = {
              products: [
                { sku: 'SKU1', model: 'iPhone 18 Pro Max', capacity: '512GB', color: '黑色' },
              ],
              stores: [
                { storeCode: 'S1', city: '重庆', storeName: 'Apple 重庆解放碑' },
                { storeCode: 'S2', city: '长沙', storeName: 'Apple 长沙测试门店' },
              ],
            };
          else if (url.pathname.endsWith('/inventory/settings'))
            data = { config: { enabled: false, notificationsEnabled: false } };
          else if (url.pathname.endsWith('/inventory/latest'))
            data = { items: [], total: 0, page: 1, pageSize: 50, summary: {} };
          else if (url.pathname.endsWith('/inventory/scope'))
            data = {
              products: [],
              stores: [],
              combinations: 0,
              state: 'disabled',
              lastSuccessAt: null,
            };
          else if (url.pathname.endsWith('/inventory/health'))
            data = { state: 'disabled', paused: false };
          else if (url.pathname.endsWith('/apple-ids')) data = { apple_ids: [], total: 0 };
          else throw new Error(`未知 API ${url.pathname}`);
          await route.fulfill({
            json: { success: true, data },
            headers: {
              'Access-Control-Allow-Origin': base,
              'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            },
          });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      const navigateTo = async path => {
        try {
          const openNavigation = page.getByRole('button', { name: '打开导航', exact: true });
          if (await openNavigation.isVisible()) await openNavigation.click();
          const navigation = page.getByRole('navigation', { name: '主导航', exact: true });
          while (await navigation.locator('button[aria-expanded="false"]').count()) {
            await navigation.locator('button[aria-expanded="false"]').first().click();
          }
          await navigation.locator(`a[href="${path}"]`).click();
          await page.waitForURL(base + path);
        } catch (error) {
          throw new Error(`导航失败：${error.message}`, { cause: error });
        }
      };
      const checkBounds = async dialog => {
        const b = await dialog.boundingBox();
        assert(
          b.x >= 0 &&
            b.x + b.width <= width + 1 &&
            b.y >= 0 &&
            b.y + b.height <= page.viewportSize().height + 1
        );
        assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
      };
      await page.goto(base + '/stock');
      await page.getByRole('button', { name: '入库登记', exact: true }).click();
      const form = page.getByRole('dialog', { name: '入库登记', exact: true });
      const model = form.locator('select').first();
      const modelTrigger = form.getByRole('button', {
        name: '机器型号 / 容量 / 颜色',
        exact: true,
      });
      assert.equal(await model.inputValue(), '');
      assert.equal(await model.evaluate(el => el.validity.valid), false);
      if (width < 768) {
        // 实际触摸事件路径，不能只用 selectOption 绕过交互。
        await modelTrigger.tap();
        const picker = page.getByRole('dialog', { name: '机器型号 / 容量 / 颜色', exact: true });
        await checkBounds(picker);
        assert.equal(await page.evaluate(() => document.body.style.position), 'fixed');
        assert(await model.isHidden(), '手机原生select必须完全不可触摸或聚焦');
        assert.equal(await model.evaluate(el => el.tabIndex), -1);
        assert(
          await picker.evaluate(el => document.activeElement === el),
          '面板打开聚焦容器而非关闭按钮'
        );
        const closeButton = picker.getByRole('button', { name: '关闭机器型号 / 容量 / 颜色' });
        const closeStyle = await closeButton.evaluate(el => ({
          shadow: getComputedStyle(el).boxShadow,
          outline: getComputedStyle(el).outlineWidth,
          outlineStyle: getComputedStyle(el).outlineStyle,
          focused: el === document.activeElement,
        }));
        assert(
          !closeStyle.focused &&
            (closeStyle.outlineStyle === 'none' || closeStyle.outline === '0px'),
          JSON.stringify(closeStyle)
        );
        assert(!closeStyle.shadow.includes('30, 58, 138'), '触摸打开不得给关闭按钮蓝框');
        assert.equal(await picker.getByRole('option').count(), 16);
        assert.equal(await picker.getByRole('option', { selected: true }).count(), 0);
        await picker.getByRole('textbox', { name: '搜索机器型号 / 容量 / 颜色' }).fill('512GB');
        assert.equal(await picker.getByRole('option').count(), 4);
        await picker.getByRole('textbox').fill('不存在的机型');
        await picker.getByText('没有匹配的选项').waitFor();
        await picker.getByRole('textbox').fill('512GB');
        await page.screenshot({ path: `${output}/入库型号选择-${width}.png` });
        await picker
          .getByRole('option', { name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色', exact: true })
          .click();
        await picker.waitFor({ state: 'hidden' });
        assert.equal(await model.inputValue(), 'p-512-2');
        assert.equal(await model.evaluate(el => el.checkValidity()), true);
        assert(await form.isVisible());
        assert(await modelTrigger.evaluate(el => el === document.activeElement));
        await modelTrigger.press('Enter');
        await picker.waitFor();
        await page.keyboard.press('Escape');
        await picker.waitFor({ state: 'hidden' });
        assert.equal(await model.inputValue(), 'p-512-2');
        for (let repeat = 0; repeat < 3; repeat += 1) {
          await modelTrigger.tap();
          await picker.getByRole('button', { name: '关闭机器型号 / 容量 / 颜色' }).tap();
          assert(await modelTrigger.evaluate(el => el === document.activeElement));
          assert(await model.isHidden());
          assert.equal(await page.evaluate(() => document.body.style.position), 'fixed');
          assert.equal(await page.locator('dialog.mobile-picker-dialog').count(), 0);
        }
        await modelTrigger.press('Enter');
        await page.keyboard.press('Tab');
        assert(
          await closeButton.evaluate(
            el => el === document.activeElement && el.matches(':focus-visible')
          )
        );
        assert.notEqual(await closeButton.evaluate(el => getComputedStyle(el).outlineWidth), '0px');
        await page.keyboard.press('Escape');
        // 选择层取消不关闭入库表单。
        await form.getByRole('button', { name: '入库仓库', exact: true }).tap();
        const warehouse = page.getByRole('dialog', { name: '入库仓库', exact: true });
        await warehouse.getByRole('option', { name: '长沙 明威', exact: true }).click();
        assert.equal(
          await form.locator('select[data-responsive-select="入库仓库"]').inputValue(),
          'w1'
        );
        await page.setViewportSize({ width, height: 480 });
        await modelTrigger.tap();
        await checkBounds(picker);
        await picker.getByRole('button', { name: '关闭机器型号 / 容量 / 颜色' }).click();
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => window.nativeSelectFocuses), 0);
      } else {
        await model.selectOption('p-512-2');
        assert.equal(await page.locator('.mobile-picker-dialog').count(), 0);
        assert.equal(await model.inputValue(), 'p-512-2');
      }
      page.once('dialog', dialog => dialog.accept());
      await form.getByRole('button', { name: '关闭入库登记' }).click();
      assert.equal(await page.evaluate(() => document.body.style.position), '');
      await page.getByRole('button', { name: '统计分析', exact: true }).click();
      const stats = page.getByRole('dialog', { name: '统计分析', exact: true });
      await stats.getByRole('button', { name: '统计仓库', exact: true }).click();
      const choices =
        width < 768 ? page.getByRole('dialog', { name: '统计仓库', exact: true }) : stats;
      if (width < 768) await checkBounds(choices);
      await choices.getByRole('option', { name: '长沙 明威', exact: true }).click();
      assert.equal(await choices.getByRole('option', { selected: true }).count(), 1);
      // 多选保持展开，完成只关闭当前层。
      if (width < 768) {
        await choices.getByRole('button', { name: /完成/ }).click();
        assert(await stats.isVisible());
        await stats.getByRole('button', { name: '统计仓库', exact: true }).click();
        await choices.getByPlaceholder('搜索 仓库').fill('重庆');
        assert.equal(await choices.getByRole('option').count(), 1);
        await choices.getByRole('button', { name: '统计仓库全选搜索结果', exact: true }).click();
        await page.screenshot({ path: `${output}/统计仓库多选-${width}.png` });
        await page.keyboard.press('Escape');
        assert(await stats.isVisible());
      }
      await stats.getByRole('button', { name: '关闭统计分析', exact: true }).click();
      await navigateTo('/orders');
      if (width < 768) await page.getByRole('button', { name: /筛选条件.*展开/ }).click();
      await page.getByRole('button', { name: '官网订单状态筛选', exact: true }).click();
      const official =
        width < 768 ? page.getByRole('dialog', { name: '官网订单状态筛选', exact: true }) : page;
      await official.getByRole('option', { name: '已取货', exact: true }).click();
      if (width < 768) await official.getByRole('button', { name: /完成/ }).click();
      else await page.locator('input[placeholder^="搜索 "]').press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.mobile-picker-dialog'));
      await page.getByRole('button', { name: /^下单日期：/ }).click();
      const date = page.locator('.date-range-popover');
      const mode = date.locator('select');
      if (width < 768) {
        await date.getByRole('button', { name: '下单日期条件', exact: true }).tap();
        const modes = page.getByRole('dialog', { name: '下单日期条件', exact: true });
        await modes.getByRole('option', { name: '指定日期', exact: true }).click();
        assert(await date.isVisible(), '嵌套选项不能关闭日期面板');
      } else await mode.selectOption('on');
      assert.equal(await mode.inputValue(), 'on');
      await date.getByRole('button', { name: '取消', exact: true }).click();
      await navigateTo('/apple-ids');
      const status = page.locator('select').filter({ has: page.locator('option[value="使用中"]') });
      if (width < 768) {
        await page.getByRole('button', { name: '状态筛选', exact: true }).tap();
        const options = page.getByRole('dialog', { name: '状态筛选', exact: true });
        await options.getByRole('option', { name: '使用中', exact: true }).click();
      } else await status.selectOption('使用中');
      await page.waitForFunction(
        () =>
          document.querySelector(
            'select[data-responsive-select="状态筛选"], select[aria-label="状态筛选"]'
          ).value === '使用中'
      );
      assert(requests.some(r => r.path.endsWith('/apple-ids') && r.params.status === '使用中'));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await navigateTo('/inventory-monitor');
      if (width < 768)
        await page.getByRole('button', { name: '商品与门店筛选', exact: true }).click();
      await page.getByRole('button', { name: '城市', exact: true }).click();
      const city =
        width < 768
          ? page.getByRole('dialog', { name: '城市', exact: true })
          : page.locator('.inventory-picker-popover');
      if (width < 768) await checkBounds(city);
      await city.getByRole('textbox', { name: '搜索城市' }).fill('重庆');
      await city.getByRole('checkbox', { name: '重庆', exact: true }).check();
      await city.getByRole('button', { name: /^完成/ }).click();
      await page.getByText('条件已修改，应用后生效', { exact: true }).waitFor();
      assert(
        !requests.some(r => r.path.endsWith('/inventory/latest') && r.params.cities === '重庆'),
        '监控选择不能绕过应用按钮'
      );
      await page.getByRole('button', { name: '应用筛选', exact: true }).click();
      await page.waitForTimeout(100);
      assert(
        requests.some(r => r.path.endsWith('/inventory/latest') && r.params.cities === '重庆')
      );
      assert.deepEqual(errors, []);
      process.stdout.write(
        `${engine} ${width}px 单选触摸/搜索/关闭、嵌套日期、多选与跨页面状态筛选通过\n`
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
