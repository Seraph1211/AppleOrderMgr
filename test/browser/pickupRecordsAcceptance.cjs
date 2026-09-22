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
    const requests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('token', 'pickup-synthetic-token'));
    await page.route('**/api/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      requests.push({ path, query: Object.fromEntries(url.searchParams) });
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
      } else if (path === '/api/pickups/filter-options') {
        data = { tags: ['长沙 张良帅', "上海, 测试'O", '南京 测试'] };
      } else if (path === '/api/pickups/522/events') {
        data = [
          {
            id: 'event-1',
            actorName: '测试员工',
            createdAt: '2026-09-22T19:39:00Z',
            eventType: 'updated',
            changes: {
              status: { before: 'pending', after: 'picked_up' },
              pickedUpAt: { before: null, after: '2026-09-22T19:39:00Z' },
              settlementAmount: { before: null, after: 150 },
              notes: { before: null, after: '长备注'.repeat(100) },
            },
          },
          {
            id: 'event-2',
            actorName: '测试员工',
            createdAt: '2026-09-22T19:39:00Z',
            eventType: 'evidence_added',
            changes: {
              evidence: { kind: 'pickup', id: 'internal-secret-id', name: '测试凭证.jpg' },
            },
          },
        ];
      } else if (path === '/api/pickups/export') {
        return route.fulfill({ status: 500, json: { success: false } });
      } else if (path === '/api/pickups') {
        data = {
          items: [
            {
              orderId: 522,
              orderNumber: 'W1687010672',
              tag: '长沙 张良帅' + 'LongTag'.repeat(12),
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
              notes: '长备注'.repeat(100),
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
          page: Number(url.searchParams.get('page')) || 1,
          pageSize: Number(url.searchParams.get('pageSize')) || 20,
          total: 655,
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

    for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
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
      await page.getByRole('button', { name: '订单 TAG 筛选' }).click();
      await page.getByPlaceholder('搜索 TAG').fill('上海');
      assert(await page.getByRole('option', { name: "上海, 测试'O", exact: true }).isVisible());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `TAG 下拉横向溢出：${width}`);
      await page.keyboard.press('Escape');
      for (const label of ['导出Excel', '登记']) {
        const button = page
          .getByRole('button', { name: label, exact: true })
          .filter({ visible: true })
          .first();
        const aligned = await button.evaluate(element => {
          const style = getComputedStyle(element);
          return (
            ['flex', 'inline-flex'].includes(style.display) &&
            style.alignItems === 'center' &&
            style.justifyContent === 'center'
          );
        });
        assert(aligned, `按钮图标文字未居中：${label} ${width}`);
      }
      await page
        .getByRole('button', {
          name: width >= 1024 ? '记录' : '查看订单 522 更新记录',
          exact: true,
        })
        .first()
        .click();
      const history = page.getByRole('dialog', { name: '更新记录', exact: true });
      await history.waitFor();
      const historyText = await history.innerText();
      assert(historyText.includes('取货状态：待取货 → 已取货'));
      assert(historyText.includes('结款金额：未填写 → ¥150.00'));
      assert(historyText.includes('03:39:00'));
      assert(historyText.includes('上传取货凭证：测试凭证.jpg'));
      assert(!historyText.includes('pickedUpAt') && !historyText.includes('internal-secret-id'));
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `历史横向溢出：${width}`
      );
      if (output && width === 390)
        await page.screenshot({ path: `${output}/中文更新记录-390.png` });
      await page.getByRole('button', { name: '关闭更新记录' }).click();
      if (output && [390, 1440].includes(width))
        await page.screenshot({ path: `${output}/取货列表-${width}.png`, fullPage: true });
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
    await page.getByRole('button', { name: '订单 TAG 筛选' }).click();
    await page.getByPlaceholder('搜索 TAG').fill('上海');
    await page.getByRole('option', { name: "上海, 测试'O", exact: true }).click();
    await page.getByPlaceholder('搜索 TAG').fill('长沙');
    await page.getByRole('option', { name: '长沙 张良帅', exact: true }).click();
    await page.waitForResponse(response => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/pickups' &&
        JSON.parse(url.searchParams.get('tags') || '[]').length === 2
      );
    });
    await page.keyboard.press('Escape');
    const selected = requests.filter(item => item.path === '/api/pickups').at(-1);
    assert.deepEqual(JSON.parse(selected.query.tags), ["上海, 测试'O", '长沙 张良帅']);
    await page.getByTitle('下一页', { exact: true }).click();
    await page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/pickups' &&
        new URL(response.url()).searchParams.get('page') === '2'
    );
    await page
      .locator('select')
      .filter({ has: page.locator('option[value="100"]') })
      .selectOption('50');
    await page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/pickups' &&
        new URL(response.url()).searchParams.get('pageSize') === '50'
    );
    const resized = requests.filter(item => item.path === '/api/pickups').at(-1);
    assert.equal(resized.query.page, '1');
    await page.getByRole('button', { name: '导出Excel', exact: true }).click();
    await page.getByText('导出取货清单失败', { exact: true }).waitFor();
    assert.deepEqual(
      JSON.parse(requests.find(item => item.path === '/api/pickups/export').query.tags),
      ["上海, 测试'O", '长沙 张良帅']
    );
    await page.getByRole('button', { name: '订单 TAG 筛选' }).click();
    await page.getByRole('button', { name: '清空选择' }).click();
    await page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/pickups' &&
        new URL(response.url()).searchParams.get('tags') === '[]'
    );
    assert.deepEqual(pageErrors, []);
    console.log('取货记录凭证预览与手机适配验收通过');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
