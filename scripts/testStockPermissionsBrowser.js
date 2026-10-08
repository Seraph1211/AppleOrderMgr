/* global localStorage, document, innerWidth */
/** 本地合成账号真实权限 API 与 PC/H5 授权配置验收，禁止指向生产。 */
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert/strict');
const { chromium } = require('playwright-core');
const logger = require('../src/utils/logger');
const { getPermissionCatalog } = require('../src/constants/permissionCatalog');
const origin = 'http://127.0.0.1:5320';
const apiOrigin = 'http://127.0.0.1:3310/api';

/** 验证保存持久化、旧授权、依赖、服务端隔离和窄屏触控。 */
async function main() {
  let browser;
  try {
    fs.mkdirSync('tmp/permission-browser', { recursive: true });
    const credentials = JSON.parse(fs.readFileSync('tmp/test-login.json', 'utf8'));
    const login = await fetch(`${apiOrigin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    }).then(response => response.json());
    assert(login.success, '本地登录失败');
    const token = login.data.token;
    const api = async (path, body, method = 'GET', auth = token) => {
      try {
        const response = await fetch(`${apiOrigin}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${auth}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const result = await response.json();
        assert(result.success, `${path}: ${result.error?.message || result.message}`);
        return result.data;
      } catch (error) {
        throw new Error(`本地 API 验收失败：${error.message}`);
      }
    };
    const username = `permission_${Date.now()}`;
    const password = crypto.randomBytes(18).toString('hex');
    const user = await api(
      '/users',
      { username, password, role: 'operator', permissions: ['stock.read', 'stock.cost.read'] },
      'POST'
    );
    browser = await chromium.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    const results = [];
    for (const mobile of [false, true]) {
      let state = await api(`/users/${user.id}/permissions`);
      await api(
        `/users/${user.id}/permissions`,
        {
          permissions: ['stock.read', 'stock.cost.read'],
          orderAccess: { mode: 'tags', tags: ['SYNTHETIC'] },
          expectedVersion: state.version,
        },
        'PUT'
      );
      const context = await browser.newContext({
        viewport: mobile ? { width: 375, height: 460 } : { width: 1440, height: 1000 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      await context.addInitScript(value => localStorage.setItem('token', value), token);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const click = async locator => {
        try {
          if (mobile) await locator.tap();
          else await locator.click();
        } catch (error) {
          throw new Error(`本地页面操作失败：${error.message}`);
        }
      };
      const open = async () => {
        try {
          await page.goto(`${origin}/users`);
          await page.getByText(username, { exact: true }).first().waitFor();
          await click(page.getByRole('row').filter({ hasText: username }).getByTitle('权限配置'));
          await page.getByRole('region', { name: '自有库存业务权限' }).waitFor();
        } catch (error) {
          throw new Error(`打开权限弹窗失败：${error.message}`);
        }
      };
      await open();
      const panel = page.getByRole('region', { name: '自有库存业务权限' });
      assert.equal(
        await panel
          .getByRole('checkbox', { name: '可查看成本与利润', exact: true })
          .evaluate(node => node.indeterminate),
        true
      );
      assert.equal(await panel.getByText('stock.cost.read', { exact: true }).count(), 0);
      await click(page.getByRole('button', { name: '保存权限', exact: true }));
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      state = await api(`/users/${user.id}/permissions`);
      assert.deepEqual(state.permissions, ['stock.cost.read', 'stock.read']);
      assert.deepEqual(state.orderAccess, { mode: 'tags', tags: ['SYNTHETIC'] });
      await open();
      await click(panel.getByRole('checkbox', { name: '可登记销售', exact: true }));
      await click(panel.getByRole('checkbox', { name: '可登记货款', exact: true }));
      assert(await panel.getByRole('checkbox', { name: '可查看销售', exact: true }).isChecked());
      assert(await panel.getByRole('checkbox', { name: '可查看货款', exact: true }).isChecked());
      await page.getByText('本次权限变更（含必要依赖）').scrollIntoViewIfNeeded();
      assert(await page.getByRole('button', { name: '保存权限', exact: true }).isVisible());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await click(page.getByRole('button', { name: '保存权限', exact: true }));
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      state = await api(`/users/${user.id}/permissions`);
      assert(
        state.permissions.includes('stock.sales.ship') &&
          state.permissions.includes('stock.receipts.edit')
      );
      assert(
        !state.permissions.includes('stock.profit.read') &&
          !state.permissions.includes('stock.cost.edit')
      );
      await open();
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `tmp/permission-browser/${mobile ? 'mobile' : 'desktop'}.png`,
        fullPage: true,
      });
      await click(panel.getByRole('checkbox', { name: '可查看库存', exact: true }));
      await click(page.getByRole('button', { name: '保存权限', exact: true }));
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      state = await api(`/users/${user.id}/permissions`);
      assert.deepEqual(state.permissions, []);
      assert.deepEqual(errors, []);
      results.push({
        viewport: mobile ? '375x460 touch' : '1440x1000',
        partialUnchanged: true,
        savedReloaded: true,
        recursiveDependencies: true,
        revokeCascade: true,
        tagUnchanged: true,
      });
      await context.close();
    }
    const ordinaryLogin = await fetch(`${apiOrigin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then(r => r.json());
    assert(ordinaryLogin.success);
    for (const path of ['/stock/ledger', '/users/permission-catalog']) {
      const response = await fetch(`${apiOrigin}${path}`, {
        headers: { Authorization: `Bearer ${ordinaryLogin.data.token}` },
      });
      assert.equal(response.status, 403, path);
    }
    // 不完整权限仍由真实后端拒绝，不能利用组合绕过依赖。
    const state = await api(`/users/${user.id}/permissions`);
    const invalid = await fetch(`${apiOrigin}/users/${user.id}/permissions`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ permissions: ['stock.sales.ship'], expectedVersion: state.version }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(getPermissionCatalog().filter(item => item.module === 'stock').length, 21);
    fs.writeFileSync(
      'tmp/permission-browser/result.json',
      JSON.stringify(
        { results, unauthorizedDenied: true, invalidDependencyRejected: true },
        null,
        2
      )
    );
    logger.info('库存权限 PC/H5 本地 HTTP 验收通过', { viewports: results.length });
  } catch (error) {
    logger.error('库存权限本地验收失败', { message: error.message });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}
main();
