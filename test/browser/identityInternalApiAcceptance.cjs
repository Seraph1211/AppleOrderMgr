/* global localStorage, document, navigator */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ORIGIN = 'http://127.0.0.1:5196';
const OUTPUT = path.resolve('.tmp/identity-api/verification/浏览器');
const TOKEN = 'SyntheticTokenForClipboardOnly_12345678901234567890';

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const results = [];
  fs.mkdirSync(OUTPUT, { recursive: true });
  try {
    for (const width of [1440, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-jwt'));
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      let state = null;
      let failLoad = false;
      let failReveal = false;
      let revealCalls = 0;
      let adminRole = false;
      let servicePaused = false;
      let legacyPermissions = false;
      const previewData = {
        batch: {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          source: 'excel',
          status: 'draft',
          summary: { total: 1, valid: 1, duplicates: 0, invalid: 0, empty: 0 },
        },
        rows: [
          {
            id: 1,
            rowNumber: 2,
            name: '合成批量',
            idCardNumber: '110101199001010015',
            status: 'pending',
          },
        ],
        counts: { pending: 1 },
      };
      let unknown = [
        {
          id: 7001,
          userId: 9001,
          message: '合成未知结果',
          startedAt: '2026-10-16T00:00:00Z',
          finishedAt: '2026-10-16T00:00:08Z',
        },
      ];
      const adminData = () => ({
        service: { configured: true, enabled: true, paused: servicePaused },
        unknown,
        tokens: [{ ...state, userId: 9001, prefix: 'syntheti' }],
      });
      const metadata = () => ({
        token: state,
        limits: { requestsPerMinute: 50, dailyProviderCalls: 500, dedupSeconds: 600 },
        usage: { date: '2026-10-16', providerCalls: 9 },
        service: { configured: true, enabled: true, paused: servicePaused },
      });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        try {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== ORIGIN) return route.abort();
          if (!url.pathname.startsWith('/api/')) return route.continue();
          let data = {};
          let status = 200;
          const method = request.method();
          if (url.pathname === '/api/auth/me')
            data = {
              id: 9001,
              username: 'synthetic-api-only',
              nickname: '合成API员工',
              role: adminRole ? 'admin' : 'operator',
              status: 'active',
              permissions: [
                'identity.read',
                'identity.api',
                ...(legacyPermissions ? ['identity.verify', 'identity.batch'] : []),
              ],
              permissionsVersion: 1,
              availableHome: '/identity-verifications',
            };
          else if (url.pathname === '/api/identity-verifications/status') data = metadata().service;
          else if (url.pathname === '/api/identity-verifications/batches')
            data = { batches: [], total: 0 };
          else if (
            url.pathname === '/api/identity-verifications/preview' ||
            url.pathname ===
              '/api/identity-verifications/batches/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
          )
            data = previewData;
          else if (url.pathname === '/api/identity-verifications/api-admin') data = adminData();
          else if (url.pathname === '/api/identity-verifications/api-admin/service') {
            servicePaused = JSON.parse(request.postData()).paused;
            data = adminData();
          } else if (
            url.pathname === '/api/identity-verifications/api-admin/unknown/7001/resolve'
          ) {
            const payload = JSON.parse(request.postData());
            assert(payload.reason.length >= 5 && payload.reason.length <= 200);
            unknown = [];
            data = adminData();
          } else if (url.pathname.startsWith('/api/identity-verifications/api-admin/tokens/')) {
            state = { ...state, status: 'revoked' };
            data = adminData();
          } else if (url.pathname === '/api/identity-verifications/api-token/reveal') {
            revealCalls++;
            if (failReveal) status = 403;
            else data = { token: TOKEN, expiresAt: state.expiresAt };
          } else if (url.pathname === '/api/identity-verifications/api-token/reset') {
            state = { ...state, status: 'active' };
            data = metadata();
          } else if (url.pathname === '/api/identity-verifications/api-token') {
            if (method === 'POST')
              state = {
                id: 'synthetic-record',
                status: 'active',
                createdAt: '2026-10-16T00:00:00Z',
                expiresAt: '2027-01-14T00:00:00Z',
              };
            if (method === 'DELETE') state = { ...state, status: 'revoked' };
            if (method === 'GET' && failLoad) status = 503;
            data = metadata();
          } else throw new Error(`未预期API ${url.pathname}`);
          await route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(
              status === 200
                ? { success: true, data }
                : { success: false, error: { code: 'SYNTHETIC_FAILURE', message: '合成失败' } }
            ),
          });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      await page.goto(`${ORIGIN}/identity-verifications`);
      await page.getByRole('heading', { name: '本人 API 令牌' }).waitFor();
      await page.getByText('未创建', { exact: true }).waitFor();
      await page.getByText('9 / 500 次（北京时间 2026-10-16）', { exact: true }).waitFor();
      assert.equal(await page.getByRole('tab', { name: '单人核验', exact: true }).count(), 0);
      assert.equal(await page.getByRole('tab', { name: 'Excel 批量', exact: true }).count(), 0);
      await page.getByRole('button', { name: '一键复制使用说明' }).click();
      await page.getByText('使用说明已复制，仅包含占位参数，不含本人令牌和证件信息。').waitFor();
      const guide = await page.evaluate(() => navigator.clipboard.readText());
      assert(guide.includes('https://127.0.0.1:5196/api/internal/v1/identity/verify'));
      assert(guide.includes('600 秒') && guide.includes('50 次') && guide.includes('禁止自动重试'));
      assert(guide.includes('每天最多 500 次新供应商调用'));
      assert(!guide.includes('每天最多 100 次新供应商调用'));
      assert(!guide.includes(TOKEN));
      await page.getByRole('button', { name: '创建本人令牌' }).click();
      await page.getByText('令牌已创建，请单独复制并妥善保管。').waitFor();
      await page.getByRole('button', { name: '一键复制 Token' }).click();
      await page.getByText('本人令牌已复制，请妥善保管。').waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), TOKEN);
      assert.equal(revealCalls, 1);
      assert(!(await page.locator('body').innerText()).includes(TOKEN));
      assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(TOKEN));
      await page.screenshot({ path: path.join(OUTPUT, `${width}-有效.png`), fullPage: true });
      const dimensions = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
      await page.getByRole('button', { name: '重置令牌', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page.screenshot({ path: path.join(OUTPUT, `${width}-确认.png`), fullPage: true });
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 0);
      failReveal = true;
      await page.getByRole('button', { name: '一键复制 Token' }).click();
      await page.getByRole('alert').filter({ hasText: '复制失败' }).waitFor();
      failReveal = false;
      await page.getByRole('button', { name: '停用令牌', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
      await page.getByText('令牌已停用，原令牌无法继续调用。').waitFor();
      assert(await page.getByRole('button', { name: '一键复制 Token' }).isDisabled());
      state = { ...state, status: 'active', expiresAt: '2026-01-01T00:00:00Z' };
      await page.getByRole('button', { name: '刷新状态' }).click();
      await page.getByText('已过期', { exact: true }).waitFor();
      assert(await page.getByRole('button', { name: '一键复制 Token' }).isDisabled());
      failLoad = true;
      await page.getByRole('button', { name: '刷新状态' }).click();
      await page.getByRole('alert').filter({ hasText: 'API 信息加载失败' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '一键复制 Token' }).count(), 0);
      await page.screenshot({ path: path.join(OUTPUT, `${width}-加载失败.png`), fullPage: true });
      failLoad = false;
      adminRole = true;
      state = { ...state, status: 'active', expiresAt: '2027-01-14T00:00:00Z' };
      await page.reload();
      await page.getByRole('heading', { name: '管理员管理', exact: true }).waitFor();
      await page.getByRole('button', { name: '暂停服务', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
      await page.getByText('服务已暂停', { exact: true }).waitFor();
      await page.getByRole('button', { name: '恢复服务', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
      await page.getByText('服务未暂停', { exact: true }).waitFor();
      await page.getByRole('button', { name: '核查后解除保护', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const reason = dialog.getByRole('textbox');
      const confirm = dialog.getByRole('button', { name: '确认', exact: true });
      await reason.fill('四字原因');
      assert(await confirm.isDisabled());
      await reason.fill('五字原因好');
      assert(!(await confirm.isDisabled()));
      await reason.fill('据'.repeat(200));
      assert(!(await confirm.isDisabled()));
      await page.screenshot({ path: path.join(OUTPUT, `${width}-管理员核查.png`), fullPage: true });
      await confirm.click();
      await page.getByText('暂无待核查未知结果', { exact: true }).waitFor();
      await page.getByRole('button', { name: '撤销令牌', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
      await page.getByText('已撤销', { exact: true }).waitFor();
      const adminDimensions = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert(adminDimensions.scroll <= adminDimensions.width + 1, JSON.stringify(adminDimensions));
      await page.screenshot({ path: path.join(OUTPUT, `${width}-管理员.png`), fullPage: true });
      legacyPermissions = true;
      servicePaused = true;
      adminRole = false;
      await page.goto(`${ORIGIN}/identity-verifications`);
      await page
        .getByText('身份核验服务已暂停，请联系管理员核查并恢复后继续。仍可预览和查看记录。')
        .waitFor();
      assert(await page.getByRole('button', { name: '核验一次', exact: true }).isDisabled());
      await page.getByRole('tab', { name: 'Excel 批量核验', exact: true }).click();
      await page.getByLabel('选择Excel文件').setInputFiles({
        name: 'synthetic.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from('synthetic mock workbook'),
      });
      assert(!(await page.getByRole('button', { name: '上传并预览', exact: true }).isDisabled()));
      await page.getByRole('button', { name: '上传并预览', exact: true }).click();
      await page.getByRole('heading', { name: '名单预览', exact: true }).waitFor();
      assert(await page.getByRole('button', { name: /开始核验/ }).isDisabled());
      await page.screenshot({ path: path.join(OUTPUT, `${width}-原页面暂停.png`), fullPage: true });
      assert.deepEqual(errors, []);
      results.push({
        width,
        status: 'PASS',
        clipboard: true,
        apiOnly: true,
        noOverflow: true,
        createRevokeExpiredError: true,
        adminPauseReleaseRevoke: true,
        reason4_5_200: true,
        legacyPausedPreview: true,
      });
      await context.close();
    }
    fs.writeFileSync(path.join(OUTPUT, '结果.json'), JSON.stringify(results, null, 2));
    process.stdout.write(JSON.stringify(results) + '\n');
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
