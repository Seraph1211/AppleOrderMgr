/* global localStorage, document, innerWidth */
/** 独立合成库的桌面/触控台账验收；禁止指向生产站点。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const { chromium } = require('playwright-core');
const logger = require('../src/utils/logger');
const origin = 'http://127.0.0.1:5320';
const apiOrigin = 'http://127.0.0.1:3310/api';
const output = path.resolve('tmp/settlement-browser');

/** 在本机合成库建立资料并验证保存后重载。 */
async function main() {
  let browser;
  try {
    fs.mkdirSync(output, { recursive: true });
    const credentials = JSON.parse(fs.readFileSync('tmp/test-login.json', 'utf8'));
    const login = await fetch(`${apiOrigin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: credentials.username, password: credentials.password }),
    }).then(r => r.json());
    assert(login.success, '合成登录失败');
    const token = login.data.token;
    const api = async (url, body, method = 'POST') => {
      try {
        const response = await fetch(`${apiOrigin}/stock${url}`, {
          method: body ? method : 'GET',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify({ requestKey: crypto.randomUUID(), ...body }) } : {}),
        });
        const result = await response.json();
        assert(result.success, `${url}: ${result.error?.message}`);
        return result.data;
      } catch (error) {
        throw new Error(`合成接口失败: ${error.message}`);
      }
    };
    let catalog = await api('/ledger/catalog');
    if (!catalog.enabled)
      await api('/settings', { expectedVersion: catalog.settingsVersion, enabled: true }, 'PATCH');
    const prefix = `B${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const location = await api('/locations', {
      name: `${prefix}验收仓`,
      kind: 'warehouse',
      isActive: true,
    });
    const product = catalog.products.find(p => p.entryEligible);
    assert(product, '预置规格缺失');
    const result = await api('/ledger/receive', {
      units: [1, 2, 3, 4].map(i => ({
        serialNumber: `${prefix}${String(i).padStart(3, '0')}`,
        productId: product.id,
        warehouseId: location.id,
        receivedOn: '2026-10-04',
        officialCostAmount: '11999.00',
        notes: `原备注${i}`,
      })),
    });
    const units = result.items.sort((a, b) => a.serialNumber.localeCompare(b.serialNumber));
    browser = await chromium.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    const reports = [];
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 375, height: 667 } : { width: 1440, height: 1000 },
        isMobile: mobile,
        hasTouch: mobile,
        deviceScaleFactor: 1,
      });
      await context.addInitScript(value => localStorage.setItem('token', value), token);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const click = async locator => {
        try {
          if (mobile) await locator.tap();
          else await locator.click();
        } catch (error) {
          logger.debug('本地浏览器步骤失败', { name: error.name });
          throw error;
        }
      };
      const search = async value => {
        try {
          await page.getByRole('textbox', { name: '搜索 SN 或订单号' }).fill(value);
          const response = page.waitForResponse(
            r =>
              new URL(r.url()).pathname === '/api/stock/ledger' &&
              new URL(r.url()).searchParams.get('q') === value &&
              r.request().method() === 'GET'
          );
          await click(page.getByRole('button', { name: '查询', exact: true }));
          await (await response).finished();
          await page.getByRole('checkbox', { name: `选择 ${value}` }).waitFor();
        } catch (error) {
          logger.debug('本地浏览器步骤失败', { name: error.name });
          throw error;
        }
      };
      await page.goto(`${origin}/stock`);
      await page.getByRole('heading', { name: '自有库存', exact: true }).waitFor();
      const pair = mobile ? units.slice(2) : units.slice(0, 2);
      if (!mobile) {
        await click(page.getByRole('button', { name: '基础设置', exact: true }));
        await click(page.getByRole('tab', { name: '销售人', exact: true }));
        await page.getByRole('textbox', { name: '新增销售人姓名' }).fill(`${prefix}销售`);
        await click(page.getByRole('button', { name: '添加销售人', exact: true }));
        await page.getByRole('cell', { name: `${prefix}销售`, exact: true }).waitFor();
        await click(page.getByRole('tab', { name: '出货人', exact: true }));
        await page.getByRole('textbox', { name: '新增出货人姓名' }).fill(`${prefix}出货`);
        await click(page.getByRole('button', { name: '添加出货人', exact: true }));
        await page.getByRole('cell', { name: `${prefix}出货`, exact: true }).waitFor();
        await click(page.getByRole('button', { name: '关闭基础设置' }));
      }
      await search(pair[0].serialNumber);
      await click(page.getByRole('button', { name: pair[0].serialNumber, exact: true }));
      await click(
        page
          .getByRole('dialog', { name: '设备详情' })
          .getByRole('button', { name: '编辑资料', exact: true })
      );
      const stockEdit = page.getByRole('dialog', { name: '编辑设备资料' });
      await stockEdit.getByRole('textbox', { name: '备注', exact: true }).fill('在库备注已编辑');
      await click(stockEdit.getByRole('button', { name: '保存资料', exact: true }));
      await page
        .getByRole('dialog', { name: '设备详情' })
        .getByText('在库备注已编辑', { exact: true })
        .waitFor();
      await click(page.getByRole('button', { name: '关闭设备详情' }));
      await click(page.getByRole('checkbox', { name: `选择 ${pair[0].serialNumber}` }));
      await click(page.getByRole('button', { name: '登记售出', exact: true }));
      let dialog = page.getByRole('dialog', { name: '登记售出 · 1 台' });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('button', { name: '应用到全部' }).count(), 0);
      assert.equal(await dialog.getByText('统一售价').count(), 0);
      await page.screenshot({
        path: path.join(output, `${mobile ? 'mobile' : 'desktop'}-single.png`),
      });
      await click(dialog.getByRole('button', { name: '取消', exact: true }));
      await search(pair[1].serialNumber);
      await click(page.getByRole('checkbox', { name: `选择 ${pair[1].serialNumber}` }));
      await page.getByText('已选 2 台（最多 100 台）', { exact: true }).waitFor();
      await click(page.getByRole('button', { name: '查看已选', exact: true }));
      dialog = page.getByRole('dialog', { name: '已选设备 · 2 台' });
      assert.equal(
        await dialog.getByRole('cell', { name: pair[0].serialNumber, exact: true }).count(),
        1
      );
      await click(dialog.getByRole('button', { name: `移除 ${pair[1].serialNumber}` }));
      await click(page.getByRole('button', { name: '关闭已选设备 · 1 台' }));
      await click(page.getByRole('checkbox', { name: `选择 ${pair[1].serialNumber}` }));
      await click(page.getByRole('button', { name: '登记售出', exact: true }));
      dialog = page.getByRole('dialog', { name: '登记售出 · 2 台' });
      await dialog.getByRole('combobox', { name: '销售人预置选项' }).selectOption(`${prefix}销售`);
      await dialog.getByRole('combobox', { name: '出货人', exact: true }).fill(`${prefix}手填出货`);
      await dialog.getByRole('textbox', { name: '售价（元）', exact: true }).fill('13200');
      await click(dialog.getByRole('button', { name: '应用到全部' }));
      for (const unit of pair) {
        assert.equal(
          await dialog
            .getByRole('textbox', { name: `${unit.serialNumber} 售价`, exact: true })
            .inputValue(),
          '13200'
        );
        await dialog
          .getByRole('textbox', { name: `${unit.serialNumber} 结算金额`, exact: true })
          .fill('12900');
        await dialog
          .getByRole('textbox', { name: `${unit.serialNumber} 其他费用`, exact: true })
          .fill('100');
      }
      await dialog.getByRole('textbox', { name: '备注（可选）' }).fill('售出备注');
      if (mobile) await page.setViewportSize({ width: 375, height: 460 });
      await dialog.getByRole('button', { name: '确认售出 2 台' }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(output, `${mobile ? 'mobile' : 'desktop'}-batch.png`),
      });
      await click(dialog.getByRole('button', { name: '确认售出 2 台' }));
      await page.getByText('已保存 2 台，列表已刷新。', { exact: true }).waitFor();
      await page.goto(`${origin}/stock?view=sold`);
      await search(pair[0].serialNumber);
      await page
        .getByText(mobile ? '备注：售出备注' : '售出备注', { exact: true })
        .first()
        .waitFor();
      await click(page.getByRole('button', { name: pair[0].serialNumber, exact: true }));
      dialog = page.getByRole('dialog', { name: '设备详情' });
      await dialog.getByText('结算金额', { exact: true }).waitFor();
      await click(dialog.getByRole('button', { name: '编辑资料', exact: true }));
      dialog = page.getByRole('dialog', { name: '编辑设备资料' });
      await dialog.getByRole('textbox', { name: '备注', exact: true }).fill('已售备注已编辑');
      await dialog.getByRole('textbox', { name: '更正原因', exact: false }).fill('合成验收备注');
      const edited = page.waitForResponse(
        r =>
          r.request().method() === 'PATCH' &&
          new URL(r.url()).pathname === `/api/stock/ledger/${pair[0].id}`
      );
      await click(dialog.getByRole('button', { name: '确认更正并保存' }));
      assert((await edited).ok(), '备注更正保存失败');
      await dialog.waitFor({ state: 'hidden' });
      const saved = await api(`/ledger/${pair[0].id}`);
      assert.equal(saved.notes, '已售备注已编辑');
      assert.equal(saved.grossProfit, '901.00');
      assert.equal(saved.settlementAmount, '12900.00');
      assert.equal(saved.handlerName, `${prefix}手填出货`);
      await page.goto(`${origin}/stock?view=sold`);
      await search(pair[0].serialNumber);
      await page
        .getByText(mobile ? '备注：已售备注已编辑' : '已售备注已编辑', { exact: true })
        .first()
        .waitFor();
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        '页面横向溢出'
      );
      await page.screenshot({
        path: path.join(output, `${mobile ? 'mobile' : 'desktop'}-sold.png`),
        fullPage: true,
      });
      assert.deepEqual(errors, []);
      reports.push({
        viewport: mobile ? '375 touch, 460 short' : '1440 desktop',
        singlePrice: true,
        crossSearchSelection: true,
        presetsAndManual: true,
        settlement: saved.settlementAmount,
        grossProfit: saved.grossProfit,
        notesReload: true,
      });
      await context.close();
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(reports, null, 2));
    process.stdout.write('桌面与 375px 触控真实本地 API 验收通过\n');
  } catch (error) {
    logger.error('结算浏览器验收失败', { message: error.message, stack: error.stack });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}
main();
