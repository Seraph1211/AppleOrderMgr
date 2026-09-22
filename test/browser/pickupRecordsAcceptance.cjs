/* eslint-env node, browser */
// 合成 API 验收：验证取货凭证站内预览与手机登记弹窗，不访问真实业务或 OSS。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const output = process.env.PICKUP_ARTIFACT_DIR || '';
  if (output) fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('token', 'pickup-synthetic-token'));
    await page.route('**/api/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let data;
      if (path === '/api/auth/me') {
        data = {
          id: 9001,
          username: 'pickup_mobile_test',
          nickname: '手机取货测试',
          role: 'pickupStaff',
          permissions: ['pickups.read', 'pickups.edit', 'pickups.export'],
          orderAccess: { mode: 'tags', tags: ['长沙 张良帅'] },
          availableHome: '/pickups',
        };
      } else if (path === '/api/pickups') {
        data = {
          items: [
            {
              orderId: 522,
              orderNumber: 'W1687010672',
              tag: '长沙 张良帅',
              recipientName: '许雨',
              products: [{ name: 'iPhone 18 Pro Max 冰川蓝色 512GB', quantity: 1 }],
              pickupStore: 'Apple 长沙',
              pickupDate: '2026-09-23',
              pickupInfo: {
                startTime: '10:00',
                endTime: '10:15',
                appointmentMode: 'appointment',
              },
              status: 'picked_up',
              pickedUpAt: '2026-09-22T19:39:00.000Z',
              settlementAmount: null,
              settlementPerson: null,
              notes: '',
              version: 1,
              lastUpdater: { id: 1, name: 'admin' },
              updatedAt: '2026-09-22T19:39:09.000Z',
              evidence: [
                {
                  id: 'synthetic-evidence-1',
                  kind: 'pickup',
                  originalName: '11825.jpeg',
                  contentType: 'image/jpeg',
                  sizeBytes: 68,
                  createdAt: '2026-09-22T19:39:09.000Z',
                },
              ],
            },
          ],
          page: 1,
          pageSize: 20,
          total: 1,
        };
      } else if (path === '/api/pickups/522/evidence/synthetic-evidence-1') {
        const previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960" viewBox="0 0 720 960">
          <rect width="720" height="960" fill="#eff6ff" />
          <rect x="72" y="120" width="576" height="720" rx="32" fill="#ffffff" stroke="#1e3a8a" stroke-width="8" />
          <text x="360" y="420" text-anchor="middle" font-size="52" font-family="sans-serif" fill="#1e3a8a">取货凭证</text>
          <text x="360" y="510" text-anchor="middle" font-size="32" font-family="sans-serif" fill="#475569">手机端预览测试</text>
        </svg>`;
        data = {
          url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(previewSvg)}`,
        };
      } else {
        return route.fulfill({
          status: 404,
          json: { success: false, message: `合成环境未定义接口：${path}` },
        });
      }
      return route.fulfill({ json: { success: true, data } });
    });

    for (const width of [320, 375, 390, 430, 768, 1024]) {
      await page.setViewportSize({ width, height: width <= 430 ? 700 : 900 });
      await page.goto('http://127.0.0.1:5173/pickups');
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.pickups-page *')].some(
          element =>
            element.textContent?.includes('W1687010672') &&
            element.getBoundingClientRect().width > 0 &&
            element.getBoundingClientRect().height > 0
        )
      );
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `取货页面横向溢出：${width}`
      );
      await page.locator('button:visible').filter({ hasText: '登记' }).first().click();
      const editDialog = page.getByRole('dialog', { name: /登记取货/ });
      await editDialog.waitFor();
      const dialogBox = await editDialog.boundingBox();
      assert(dialogBox);
      assert(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= width + 1, `弹窗溢出：${width}`);
      assert(dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= (width <= 430 ? 700 : 900) + 1);
      assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');

      if (width <= 767) {
        const fontSizes = await editDialog
          .locator('input:not([type="file"]), select, textarea')
          .evaluateAll(elements =>
            elements.map(element => parseFloat(getComputedStyle(element).fontSize))
          );
        assert(fontSizes.length >= 5);
        assert(
          fontSizes.every(size => size >= 16),
          `手机输入字号小于16px：${width}`
        );
        const footer = editDialog.locator('.pickup-dialog-footer');
        assert(await footer.isVisible());
        const footerBox = await footer.boundingBox();
        assert(footerBox && footerBox.y + footerBox.height <= 701, `操作栏不可见：${width}`);
      }
      if (output && width === 390) {
        await page.screenshot({ path: `${output}/手机登记-390.png` });
      }

      await editDialog.getByRole('button', { name: /11825\.jpeg/ }).click();
      const preview = page.getByRole('dialog', { name: '取货凭证' });
      await preview.waitFor();
      const image = preview.getByRole('img', { name: '11825.jpeg' });
      await image.waitFor();
      assert(await image.isVisible());
      assert(await preview.getByRole('link', { name: '在新窗口打开' }).isVisible());
      if (output && width === 390) {
        await page.screenshot({ path: `${output}/凭证预览-390.png` });
      }
      await preview.getByRole('button', { name: '关闭凭证预览' }).click();
      await editDialog.getByRole('button', { name: '关闭取货登记' }).click();
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    }
    assert.deepEqual(pageErrors, []);
    console.log('取货记录凭证预览与手机适配验收通过');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
