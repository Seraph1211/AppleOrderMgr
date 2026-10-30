/* global localStorage, document, window */
/* eslint-disable no-magic-numbers -- 独立合成报价、版本、响应码及视口验收边界。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const BASE_URL = process.env.DUO_PRICING_BROWSER_URL || 'http://127.0.0.1:5173';
const OUTPUT_DIR = process.env.DUO_PRICING_BROWSER_OUTPUT || '/tmp/apple-duo-pricing-acceptance';
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE_URL), '仅允许本地候选前端');

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-duo-qa-token'));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const unexpected = [];
    const writes = [];
    const previews = [];
    const readonlyRebase = process.env.DUO_PRICING_READONLY_REBASE === 'true';
    let version = 0;
    let sourceVersion = 'a'.repeat(64);
    let role = 'admin';
    let conflict = '';
    let serverFailure = false;
    let saveDelayMs = 0;
    let pricingDelayMs = 0;
    let historyEmpty = false;
    let dataUnavailable = false;
    let pricingReads = 0;
    let historyOffset = -1;
    const now = '2026-10-25T06:00:00.000Z';
    const lastCheckedAt = '2026-10-25T06:07:00.000Z';
    const adjustedAt = '2026-10-25T06:09:00.000Z';
    const rows = [256, 512, 1024, 2048].flatMap((storageGb, index) =>
      ['星光白色', '夜空色'].map((color, colorIndex) => ({
        productKey: String(index * 2 + colorIndex + 1).repeat(40),
        productName: `iPhone Duo ${color} ${storageGb}GB`,
        productModel: 'Duo',
        storageGb,
        color,
        wholesalePrice: 16000 + index * 1000 + colorIndex * 100,
        officialPrice: 15999 + index * 1000,
        markup: 50,
      }))
    );
    const computed = row => {
      const rawRetail = row.wholesalePrice === null ? null : row.wholesalePrice + row.markup;
      const invalid = rawRetail !== null && rawRetail < 0;
      return {
        ...row,
        retailPrice: invalid ? null : rawRetail,
        premiumAmount:
          rawRetail === null || invalid
            ? null
            : Math.floor((rawRetail - row.officialPrice) / 10) * 10,
        ...(invalid ? { pricingError: 'DUO_RETAIL_PRICE_INVALID' } : {}),
      };
    };
    const historyId = '10000000-0000-4000-8000-000000000001';
    const historical = rows.map(row => ({ ...row, markup: 20 }));
    const historyRow = index => ({
      id: index ? '10000000-0000-4000-8000-000000000002' : historyId,
      revision: 21 - index,
      action: 'adjust',
      actorName: '独立验收管理员',
      createdAt: now,
      snapshot: historical,
      changes: [
        {
          ...computed(rows[0]),
          previousMarkup: 50,
          markup: 20,
          previousRetailPrice: 16050,
          retailPrice: 16020,
        },
      ],
    });
    const tokens = body => {
      assert.equal(body.expectedVersion, version);
      assert.equal(body.expectedSourceVersion, sourceVersion);
    };
    const proposal = body =>
      rows.map(row => {
        const selected = body.operation === 'restore' || body.productKeys?.includes(row.productKey);
        const markup = !selected
          ? row.markup
          : body.operation === 'restore'
            ? 20
            : body.operation === 'reset'
              ? 50
              : body.mode === 'retail'
                ? Number(body.amount) - row.wholesalePrice
                : Number(body.amount);
        return {
          ...computed({ ...row, markup }),
          previousMarkup: row.markup,
          previousRetailPrice: computed(row).retailPrice,
          selected,
        };
      });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      try {
        const request = route.request();
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/'))
          return url.origin === BASE_URL ? route.continue() : route.abort();
        const endpoint = url.pathname;
        if (readonlyRebase && !['GET', 'HEAD'].includes(request.method())) {
          unexpected.push(`${request.method()} ${endpoint}`);
          return route.abort();
        }
        let data;
        let status = 200;
        if (endpoint === '/api/auth/me') {
          data = {
            id: 1,
            username: 'duo-qa',
            nickname: '独立验收管理员',
            role,
            status: 'active',
            permissions: [],
            permissionsVersion: 1,
            availableHome: '/profile',
          };
        } else if (endpoint === '/api/quote-pricing/duo' && request.method() === 'GET') {
          pricingReads++;
          if (pricingDelayMs) await new Promise(resolve => setTimeout(resolve, pricingDelayMs));
          data = {
            version,
            sourceVersion,
            sourceUpdatedAt: now,
            updatedAt: version ? adjustedAt : now,
            pricingUpdatedAt: version ? adjustedAt : null,
            lastCheckedAt,
            stale: false,
            publicEnabled: true,
            publicPath: '/quote/duo',
            defaultMarkup: 50,
            items: rows.map(computed),
          };
          if (dataUnavailable) {
            status = 503;
            data = { code: 'QUOTE_SOURCE_UNAVAILABLE', message: '合成报价来源暂不可用' };
          }
        } else if (endpoint === '/api/quote-pricing/duo/versions') {
          historyOffset = Number(url.searchParams.get('offset') || 0);
          data = { items: historyOffset ? [historyRow(1)] : [historyRow(0)], total: 2 };
          if (historyEmpty) data = { items: [], total: 0 };
        } else if (endpoint.startsWith('/api/quote-pricing/duo/')) {
          assert.equal(request.headers().authorization, 'Bearer synthetic-duo-qa-token');
          const body = request.postDataJSON();
          tokens(body);
          if (conflict === (endpoint.endsWith('/preview') ? 'preview' : 'save')) {
            conflict = '';
            version++;
            sourceVersion = 'b'.repeat(64);
            status = 409;
            data = { code: 'DUO_SOURCE_CHANGED', message: '来源版本已变化' };
          } else if (serverFailure && !endpoint.endsWith('/preview')) {
            serverFailure = false;
            status = 503;
            data = { code: 'SYNTHETIC_FAILED', message: '合成保存失败，请重试' };
          } else if (endpoint.endsWith('/preview')) {
            previews.push(body);
            data = {
              version,
              sourceVersion,
              sourceUpdatedAt: now,
              selectedCount: body.operation === 'restore' ? 8 : body.productKeys.length,
              items: proposal(body),
            };
          } else {
            const operation = endpoint.endsWith('/reset')
              ? 'reset'
              : endpoint.endsWith('/restore')
                ? 'restore'
                : 'adjust';
            const values = proposal({ ...body, operation });
            writes.push({ operation, ...body });
            values.forEach((value, index) => {
              rows[index].markup = value.markup;
            });
            version++;
            data = {
              version,
              selectedCount: operation === 'restore' ? 8 : body.productKeys.length,
            };
            if (saveDelayMs) await new Promise(resolve => setTimeout(resolve, saveDelayMs));
          }
        } else {
          unexpected.push(`${request.method()} ${endpoint}`);
          return route.abort();
        }
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(
            status === 200 ? { success: true, data } : { success: false, error: data }
          ),
        });
      } catch (error) {
        unexpected.push(error.message);
        await route.abort();
      }
    });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    await page.goto(`${BASE_URL}/quote-pricing`);
    await page.getByRole('heading', { name: '报价管理', exact: true }).waitFor();
    const list = page.getByRole('region', { name: 'Duo 报价列表' });
    const history = page.getByRole('region', { name: '报价历史' });
    const dialog = page.getByRole('dialog');
    const preview = dialog.getByRole('region', { name: '报价变更预览' });
    const firstName = '设置 256G 星光白色';
    const secondName = '设置 256G 夜空色';
    const successMessage = '已保存加价额，Duo 公开报价已生效。';
    const conflictMessage =
      '报价来源或设置版本已变化。输入已保留，请点击“刷新并核对”，核对最新批发价后重新预览。';
    const refreshedMessage = '已读取最新报价。输入与选择已保留，请核对后重新预览。';
    const settle = () =>
      page.evaluate(
        () =>
          new Promise(resolve =>
            window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
          )
      );
    const shot = async name => {
      await settle();
      return page.screenshot({ path: path.join(OUTPUT_DIR, name), fullPage: false });
    };
    const amountInput = () => dialog.getByRole('textbox');
    const close = async () => {
      await dialog.getByRole('button', { name: '关闭报价设置弹窗' }).click();
      await dialog.waitFor({ state: 'hidden' });
      await settle();
    };
    const openSingle = async (name = firstName) => {
      await page.getByRole('button', { name, exact: true }).click();
      await dialog.waitFor();
      assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    };
    const openBatch = async () => {
      await page.getByRole('button', { name: /^批量设置（已选 / }).click();
      await dialog.waitFor();
    };
    const saved = async () => {
      await page.getByText(successMessage, { exact: true }).waitFor();
      assert.equal(await dialog.count(), 0);
      await settle();
    };
    const assertDialogFits = async label => {
      await settle();
      const viewport = page.viewportSize();
      const box = await dialog.boundingBox();
      assert.ok(
        box.x >= -1 &&
          box.y >= -1 &&
          box.x + box.width <= viewport.width + 1 &&
          box.y + box.height <= viewport.height + 1,
        `${label}弹窗超出视口: ${JSON.stringify(box)}`
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${label}正文横向溢出`
      );
      assert.ok(
        await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
        `${label}弹窗横向溢出`
      );
      const footer = await dialog.locator('footer').boundingBox();
      assert.ok(
        footer.y >= 0 && footer.y + footer.height <= viewport.height + 1,
        `${label}底部操作不可达`
      );
      assert.ok(
        Math.abs(footer.y + footer.height - box.y - box.height) <= 1,
        `${label}主操作区应贴弹窗底部`
      );
    };
    const assertTime = async scope => {
      const timeElement = scope.locator('time');
      assert.equal(await timeElement.getAttribute('datetime'), now);
      const text = await timeElement.innerText();
      assert.ok(text.includes('14:00:00'), '应显示批发价来源时间');
      assert.ok(
        !text.includes('14:07') && !text.includes('14:09'),
        '不能用检查或人工时间冒充批发价更新时间'
      );
    };
    const verifyEmptyStates = async () => {
      historyEmpty = true;
      const emptyStateWidths = [];
      for (const width of [320, 375]) {
        await page.setViewportSize({ width, height: 812 });
        pricingDelayMs = 1200;
        await page.reload();
        await list.getByText('正在加载报价…', { exact: true }).waitFor();
        assert.equal(await list.locator('table').count(), 0, '加载空态不得渲染带隐藏列的表头');
        assert.equal(await history.locator('table').count(), 0);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        );
        await shot(`loading-${width}.png`);
        await page.waitForFunction(
          () =>
            document.querySelectorAll('section[aria-label="Duo 报价列表"] tbody tr').length === 8
        );
        await history.getByText('暂无调价历史', { exact: true }).waitFor();
        assert.equal(
          await history.locator('table, thead').count(),
          0,
          '无历史时不显示表格或碎裂表头'
        );
        await history.scrollIntoViewIfNeeded();
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        );
        await shot(`empty-history-${width}.png`);
        dataUnavailable = true;
        await page.reload();
        await page.getByText('合成报价来源暂不可用', { exact: true }).waitFor();
        await list.getByText('报价读取失败，请刷新重试', { exact: true }).waitFor();
        assert.equal(await list.locator('table, thead').count(), 0, '来源异常无商品时不显示表头');
        assert.equal(await history.locator('table, thead').count(), 0);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await shot(`source-error-${width}.png`);
        dataUnavailable = false;
        emptyStateWidths.push(width);
      }
      pricingDelayMs = 0;
      historyEmpty = false;
      await page.reload();
      await page.waitForFunction(
        () => document.querySelectorAll('section[aria-label="Duo 报价列表"] tbody tr').length === 8
      );
      assert.equal(await history.locator('tbody tr').count(), 1, '非空历史表格继续保留');
      return emptyStateWidths;
    };
    assert.equal(await list.locator('tbody tr').count(), 8);
    assert.equal(
      await page.getByRole('region', { name: '设置报价' }).count(),
      0,
      '页面不能保留常驻设置区'
    );
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.getByRole('link', { name: '报价管理', exact: true }).count(), 1);
    assert.equal(await page.getByRole('link', { name: '公开报价', exact: true }).count(), 0);
    assert.equal(
      await page.getByRole('link', { name: '查看公开报价' }).getAttribute('href'),
      '/quote/duo'
    );
    await assertTime(page.locator('.duo-pricing-times'));
    assert.ok((await page.locator('.duo-pricing-times').innerText()).includes('暂未调价'));

    if (readonlyRebase) {
      const widths = [];
      for (const width of [1440, 375, 320]) {
        await page.setViewportSize({ width, height: width < 768 ? 812 : 1000 });
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        );
        if (width < 768)
          assert.ok(
            await list
              .locator('.duo-pricing-list-wrap')
              .evaluate(element => element.scrollWidth <= element.clientWidth + 1)
          );
        await page.screenshot({
          path: path.join(OUTPUT_DIR, `readonly-admin-${width}.png`),
          fullPage: true,
        });
        await openSingle();
        await assertDialogFits(`${width}只读设置`);
        await assertTime(dialog);
        assert.equal(await amountInput().inputValue(), '50');
        await shot(`readonly-dialog-${width}.png`);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        await settle();
        await page.getByRole('checkbox', { name: '选择 2T 星光白色', exact: true }).check();
        await page.getByRole('checkbox', { name: '选择 2T 夜空色', exact: true }).check();
        await list.locator('tbody tr').nth(7).scrollIntoViewIfNeeded();
        const batch = page.getByRole('button', { name: /^批量设置（已选 / });
        assert.equal(await batch.count(), 1);
        if (width < 768) {
          const box = await batch.boundingBox();
          assert.ok(box.y >= 0 && box.y + box.height <= 813 && box.height >= 44);
        }
        await batch.click();
        await dialog.waitFor();
        await assertDialogFits(`${width}只读批量`);
        assert.equal(await amountInput().inputValue(), '');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        await settle();
        assert.equal(await batch.evaluate(element => element === document.activeElement), true);
        widths.push(width);
      }
      const emptyStateWidths = await verifyEmptyStates();
      assert.deepEqual(writes, []);
      assert.deepEqual(previews, []);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
      fs.writeFileSync(
        path.join(OUTPUT_DIR, 'result.json'),
        JSON.stringify(
          {
            passed: true,
            readonlyRebase: true,
            widths,
            emptyStateWidths,
            emptyHistoryWithoutTable: true,
            loadingAndErrorWithoutTable: true,
            nonemptyHistoryPreserved: true,
            mobileDialogAndBatchEntry: true,
            writes: 0,
            previews: 0,
            errors,
            unexpected,
          },
          null,
          2
        )
      );
      return;
    }

    await openSingle();
    await assertTime(dialog);
    assert.equal(await amountInput().inputValue(), '50');
    await amountInput().fill('88.25');
    await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
    await preview.waitFor();
    assert.equal(writes.length, 0);
    await dialog.getByRole('button', { name: '取消预览' }).click();
    assert.equal(await preview.count(), 0);
    assert.equal(await amountInput().inputValue(), '88.25');
    await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
    await preview.waitFor();
    const beforeModeSwitch = previews.length;
    await dialog.getByRole('radio', { name: '按零售价设置' }).check();
    assert.equal(await amountInput().inputValue(), '');
    assert.equal(await preview.count(), 0);
    await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
    await dialog.getByText('请输入金额，最多保留两位小数', { exact: true }).waitFor();
    assert.equal(previews.length, beforeModeSwitch, '空金额不能调用预览');
    assert.equal(writes.length, 0);
    await close();
    await openSingle(secondName);
    assert.equal(await amountInput().inputValue(), '16150');
    await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
    await preview.waitFor();
    await dialog.getByRole('radio', { name: '按加价额设置' }).check();
    assert.equal(await amountInput().inputValue(), '');
    assert.equal(await preview.count(), 0);
    await close();
    await openSingle();
    assert.equal(await amountInput().inputValue(), '50');
    await amountInput().fill('88.25');
    await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
    await preview.waitFor();
    await amountInput().fill('88.50');
    assert.equal(await preview.count(), 0, '编辑金额必须撤销预览');
    await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
    await preview.waitFor();
    saveDelayMs = 700;
    const confirm = dialog.getByRole('button', { name: '确认保存加价额' });
    const confirmBox = await confirm.boundingBox();
    await page.mouse.click(
      confirmBox.x + confirmBox.width / 2,
      confirmBox.y + confirmBox.height / 2
    );
    await page.mouse.click(
      confirmBox.x + confirmBox.width / 2,
      confirmBox.y + confirmBox.height / 2
    );
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(await amountInput().isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: '关闭报价设置弹窗' }).isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true, '提交中不能Esc退出');
    await saved();
    saveDelayMs = 0;
    assert.equal(writes.length, 1, '连续点击仅可提交一次');
    assert.equal(rows[0].markup, 88.5);
    assert.equal(
      await page
        .getByRole('button', { name: firstName, exact: true })
        .evaluate(element => element === document.activeElement),
      true,
      '保存后焦点回到入口'
    );
    await openSingle(secondName);
    assert.equal(await amountInput().inputValue(), '50');
    await close();
    await openSingle();
    assert.equal(await amountInput().inputValue(), '88.5');
    await close();

    await page.getByRole('checkbox', { name: '全选 Duo 商品', exact: true }).check();
    await openBatch();
    assert.equal(await amountInput().inputValue(), '', '批量新输入必须留空');
    await dialog.getByRole('radio', { name: '按零售价设置' }).check();
    assert.equal(await amountInput().inputValue(), '');
    await amountInput().fill('20000');
    await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
    await preview.waitFor();
    assert.equal(await preview.locator('tbody tr').count(), 8);
    assert.ok((await preview.innerText()).includes('¥4,000'));
    assert.ok((await preview.innerText()).includes('¥3,900'));
    await dialog.getByRole('button', { name: '确认保存加价额' }).click();
    await saved();
    assert.equal(writes.at(-1).mode, 'retail');
    assert.equal(writes.at(-1).productKeys.length, 8);
    assert.equal(rows[0].markup, 4000);
    assert.equal(rows[1].markup, 3900);
    await openBatch();
    const beforeReset = writes.length;
    await dialog.getByRole('button', { name: '恢复默认 +50', exact: true }).click();
    await preview.waitFor();
    assert.equal(writes.length, beforeReset, '重置也必须先预览');
    await dialog.getByRole('button', { name: '确认保存加价额' }).click();
    await saved();
    assert.ok(rows.every(row => row.markup === 50));
    await openSingle(secondName);
    assert.equal(await amountInput().inputValue(), '16150');
    await close();
    await openSingle();
    assert.equal(await amountInput().inputValue(), '16050');
    await close();
    await page.getByRole('checkbox', { name: '全选 Duo 商品', exact: true }).check();
    await page.getByRole('button', { name: '加载更多历史', exact: true }).click();
    await page.getByText('已显示 2 / 2 条', { exact: true }).waitFor();
    assert.equal(historyOffset, 1);
    await page
      .getByRole('button', { name: /^预览恢复版本 / })
      .first()
      .click();
    await preview.waitFor();
    assert.equal(await preview.locator('tbody tr').count(), 8);
    const beforeHistory = writes.length;
    await dialog.locator('summary').click();
    assert.equal(await dialog.locator('details').getAttribute('open'), '');
    assert.ok((await dialog.locator('details').innerText()).includes('¥16,020'));
    await dialog.getByRole('button', { name: '取消预览' }).click();
    await dialog.getByRole('button', { name: '重新预览恢复', exact: true }).click();
    await preview.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    await settle();
    assert.equal(writes.length, beforeHistory, '取消历史恢复不得提交');
    await page
      .getByRole('button', { name: /^预览恢复版本 / })
      .first()
      .click();
    await preview.waitFor();
    await dialog.getByRole('button', { name: '确认保存加价额' }).click();
    await saved();
    assert.equal(writes.at(-1).operation, 'restore');
    assert.ok(rows.every(row => row.markup === 20));

    await openBatch();
    await dialog.getByRole('radio', { name: '按加价额设置' }).check();
    await amountInput().fill('-20.25');
    for (const at of ['preview', 'save']) {
      conflict = at;
      const before = writes.length;
      await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
      if (at === 'save') {
        await preview.waitFor();
        await dialog.getByRole('button', { name: '确认保存加价额' }).click();
      }
      await dialog.getByText(conflictMessage, { exact: true }).waitFor();
      assert.equal(await amountInput().inputValue(), '-20.25');
      assert.equal(await dialog.getByRole('button', { name: '预览设置', exact: true }).count(), 0);
      assert.equal(await preview.count(), 0);
      assert.equal(writes.length, before, '409不得自动覆盖或重复提交');
      assert.ok(
        (await dialog.getByRole('heading', { name: /批量设置 8 款报价/ }).count()) === 1,
        '409保留8款选择'
      );
      await dialog.getByRole('button', { name: '刷新并核对', exact: true }).click();
      await dialog.getByText(refreshedMessage, { exact: true }).waitFor();
      await assertTime(dialog);
    }
    serverFailure = true;
    await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
    await preview.waitFor();
    await dialog.getByRole('button', { name: '确认保存加价额' }).click();
    await dialog.getByText('合成保存失败，请重试', { exact: true }).waitFor();
    assert.equal(await amountInput().inputValue(), '-20.25');
    assert.equal(await preview.count(), 0);
    await close();

    rows[0].wholesalePrice = null;
    await page.getByRole('button', { name: '刷新并核对', exact: true }).click();
    await page.getByText(refreshedMessage, { exact: true }).waitFor();
    const nullCells = await list
      .locator('tbody tr')
      .first()
      .locator('td:visible')
      .allTextContents();
    assert.equal(nullCells[3], '—');
    assert.equal(nullCells[6], '—');
    await openSingle();
    await dialog.getByRole('radio', { name: '按零售价设置' }).check();
    await dialog
      .getByText('所选商品缺少批发价，无法按零售价换算；可按加价额设置。', { exact: true })
      .waitFor();
    assert.equal(await amountInput().inputValue(), '');
    assert.equal(
      await dialog.getByRole('button', { name: '预览设置', exact: true }).isDisabled(),
      true
    );
    await close();
    await openSingle();
    assert.equal(await amountInput().inputValue(), '', '缺零售价逐款带空');
    await close();
    rows[0].wholesalePrice = 100;
    rows[0].markup = -15900;
    await page.getByRole('button', { name: '刷新并核对', exact: true }).click();
    await page.getByText('零售价异常，请调整加价', { exact: true }).waitFor();
    await openSingle();
    assert.equal(await amountInput().inputValue(), '');
    await dialog.getByRole('button', { name: '恢复默认 +50', exact: true }).click();
    await preview.waitFor();
    assert.ok((await preview.innerText()).includes('¥150'));
    await dialog.getByRole('button', { name: '确认保存加价额' }).click();
    await saved();
    assert.equal(rows[0].markup, 50);
    rows[0].wholesalePrice = 16000;
    await page.getByRole('button', { name: '刷新并核对', exact: true }).click();
    await page.getByText(refreshedMessage, { exact: true }).waitFor();

    const dimensions = [];
    for (const [width, height] of [
      [1440, 1000],
      [768, 1024],
      [390, 844],
      [375, 812],
      [320, 740],
    ]) {
      await page.setViewportSize({ width, height });
      await settle();
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `正文在${width}px横向溢出`
      );
      assert.equal(await page.getByRole('region', { name: '设置报价' }).count(), 0);
      const wrap = list.locator('.duo-pricing-list-wrap');
      await wrap.evaluate(element => {
        element.scrollLeft = 0;
      });
      if (width < 768) {
        assert.ok(
          await wrap.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          `手机${width}主列表不应横滑`
        );
        for (const row of await list.locator('tbody tr').all()) {
          const visibleCells = row.locator('td:visible');
          assert.equal(await visibleCells.count(), 3);
          const product = await visibleCells.nth(0).innerText();
          const prices = await visibleCells.nth(1).innerText();
          assert.ok(/256G|512G|1T|2T/.test(product) && /星光白色|夜空色/.test(product));
          assert.ok(
            prices.includes('批发') && prices.includes('¥'),
            '手机行内必须同时提供零售价和批发价'
          );
          const rowBox = await row.boundingBox();
          assert.ok(rowBox.x >= 0 && rowBox.x + rowBox.width <= width + 1, '手机行不可裁切');
          const buttonBox = await row.getByRole('button', { name: /^设置 / }).boundingBox();
          assert.ok(buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= width + 1, '设置无需横滑');
        }
        await page.getByRole('checkbox', { name: '选择 2T 星光白色', exact: true }).check();
        await page.getByRole('checkbox', { name: '选择 2T 夜空色', exact: true }).check();
        await list.locator('tbody tr').nth(7).scrollIntoViewIfNeeded();
        const fixedEntry = page.getByRole('button', { name: /^批量设置（已选 / });
        assert.equal(await fixedEntry.count(), 1, '手机只保留一个可见批量入口');
        const fixedBox = await fixedEntry.boundingBox();
        assert.ok(
          fixedBox.y >= 0 && fixedBox.y + fixedBox.height <= height + 1 && fixedBox.height >= 44,
          '滚到第8款时批量入口仍可达且至少44px'
        );
        assert.equal(
          await fixedEntry.evaluate(element => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return hit === element || element.contains(hit);
          }),
          true,
          '批量按钮不能被其他元素遮挡'
        );
        assert.equal(
          await list
            .locator('.duo-pricing-list-toolbar')
            .evaluate(element => window.getComputedStyle(element).position),
          'fixed'
        );
        await shot(`batchbar-${width}.png`);
        await fixedEntry.click();
        await dialog.waitFor();
        assert.equal(
          await page.locator('.duo-pricing-list-toolbar').isVisible(),
          false,
          '弹窗开启时固定工具条隐藏'
        );
        await assertDialogFits(`${width}滚动后批量设置`);
        await page.keyboard.press('Escape');
        assert.equal(await dialog.count(), 0);
        await settle();
        assert.equal(
          await fixedEntry.evaluate(element => element === document.activeElement),
          true,
          '关闭批量弹窗焦点回固定入口'
        );
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const historyBox = await history.boundingBox();
        const toolbarBox = await list.locator('.duo-pricing-list-toolbar').boundingBox();
        assert.ok(
          historyBox.y + historyBox.height <= toolbarBox.y + 1,
          '固定工具条不能遮住页面末尾内容'
        );
        await shot(`history-${width}.png`);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUTPUT_DIR, `admin-${width}.png`), fullPage: true });
      const entry = page.getByRole('button', { name: firstName, exact: true });
      await entry.scrollIntoViewIfNeeded();
      const previousY = await page.evaluate(() => window.scrollY);
      const previousBodyStyle = await page.evaluate(() => document.body.style.cssText);
      await entry.click();
      await dialog.waitFor();
      await assertDialogFits(`${width}编辑`);
      await assertTime(dialog);
      assert.equal(await page.locator('.duo-pricing-page').getAttribute('aria-hidden'), 'true');
      assert.equal(await page.locator('.duo-pricing-page').getAttribute('inert'), '');
      assert.equal(
        await page.evaluate(
          () =>
            document.body.style.position === 'fixed' && document.body.style.overflow === 'hidden'
        ),
        true
      );
      await page.keyboard.press('Shift+Tab');
      assert.equal(
        await dialog
          .getByRole('button', { name: '预览设置', exact: true })
          .evaluate(element => element === document.activeElement),
        true,
        '反向Tab应留在弹窗'
      );
      await page.keyboard.press('Tab');
      assert.equal(
        await dialog
          .getByRole('button', { name: '关闭报价设置弹窗' })
          .evaluate(element => element === document.activeElement),
        true,
        'Tab应循环到弹窗首项'
      );
      await dialog.getByRole('radio', { name: '按加价额设置' }).check();
      await amountInput().fill('75.25');
      await shot(`editor-${width}.png`);
      await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
      await preview.waitFor();
      await assertDialogFits(`${width}预览`);
      await dialog.locator('.duo-pricing-dialog-body').evaluate(element => {
        element.scrollTop = element.scrollHeight;
      });
      await shot(`preview-${width}.png`);
      if (width === 375) {
        const beforeMobile = writes.length;
        await dialog.getByRole('button', { name: '确认保存加价额' }).click();
        await saved();
        assert.equal(writes.length, beforeMobile + 1);
        assert.equal(rows[0].markup, 75.25);
      } else {
        await dialog.getByRole('button', { name: '取消预览' }).click();
        await page.keyboard.press('Escape');
        assert.equal(await dialog.count(), 0);
        await settle();
      }
      assert.equal(
        await entry.evaluate(element => element === document.activeElement),
        true,
        '关闭后焦点回到设置入口'
      );
      assert.equal(
        await page.evaluate(() => document.body.style.cssText),
        previousBodyStyle,
        '关闭后还原滚动锁样式'
      );
      assert.ok(
        Math.abs((await page.evaluate(() => window.scrollY)) - previousY) <= 1,
        '关闭后还原页面滚动位置'
      );
      assert.equal(await page.locator('.duo-pricing-page').getAttribute('aria-hidden'), null);
      assert.equal(await page.locator('.duo-pricing-page').getAttribute('inert'), null);
      if (width < 768) {
        assert.ok(
          await history
            .locator('table')
            .evaluate(element => element.scrollWidth <= element.parentElement.clientWidth + 1),
          `手机${width}历史不应横滑`
        );
        for (const row of await history.locator('tbody tr').all()) {
          assert.equal(await row.locator('td:visible').count(), 3);
          const restoreBox = await row
            .getByRole('button', { name: /^预览恢复版本 / })
            .boundingBox();
          assert.ok(
            restoreBox.x >= 0 && restoreBox.x + restoreBox.width <= width + 1,
            '手机历史恢复应直接可见'
          );
        }
      }
      const restoreEntry = history.getByRole('button', { name: /^预览恢复版本 / }).first();
      await restoreEntry.click();
      await preview.waitFor();
      await dialog.locator('summary').click();
      assert.equal(await dialog.locator('details').getAttribute('open'), '');
      await assertDialogFits(`${width}历史详情`);
      await dialog.locator('details').scrollIntoViewIfNeeded();
      await shot(`history-dialog-${width}.png`);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 0);
      await settle();
      assert.equal(
        await restoreEntry.evaluate(element => element === document.activeElement),
        true
      );
      dimensions.push({ width, height });
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('checkbox', { name: '全选 Duo 商品', exact: true }).check();
    const batchEntry = page.getByRole('button', { name: /^批量设置（已选 8 款）/ });
    const shortScreens = [];
    for (const attempt of [1, 2, 3]) {
      await page.setViewportSize({ width: 375, height: 812 });
      await batchEntry.click();
      await dialog.waitFor();
      await amountInput().fill('99.99');
      for (const height of [568, 400]) {
        await page.setViewportSize({ width: 375, height });
        await amountInput().scrollIntoViewIfNeeded();
        await amountInput().focus();
        await assertDialogFits(`375x${height}`);
        assert.ok(
          await amountInput().evaluate(
            element => parseFloat(window.getComputedStyle(element).fontSize) >= 16
          ),
          'H5金额输入字号至少16px'
        );
        if (!(await preview.count())) {
          await dialog.getByRole('button', { name: '预览设置', exact: true }).click();
          await preview.waitFor();
        }
        assert.equal(await preview.locator('tbody tr').count(), 8);
        await assertDialogFits(`375x${height}批量预览`);
        const scrollable = dialog.locator('.duo-pricing-dialog-body');
        assert.ok(
          await scrollable.evaluate(element => element.scrollHeight > element.clientHeight),
          '批量预览应在弹窗内滚动'
        );
        await scrollable.evaluate(element => {
          element.scrollTop = element.scrollHeight;
        });
        if (attempt === 1) await shot(`short-preview-375x${height}.png`);
        if (attempt === 1) shortScreens.push({ width: 375, height });
      }
      const beforeCancel = writes.length;
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 0);
      await settle();
      assert.equal(writes.length, beforeCancel);
      await settle();
      const shortFocusRestored = await batchEntry.evaluate(
        element => element === document.activeElement
      );
      if (!shortFocusRestored) {
        fs.writeFileSync(
          path.join(OUTPUT_DIR, 'short-focus-failure.json'),
          JSON.stringify(
            await page.evaluate(() => ({
              activeTag: document.activeElement?.tagName,
              activeLabel: document.activeElement?.getAttribute('aria-label'),
              activeText: document.activeElement?.textContent?.slice(0, 80),
              toolbarVisibility: window.getComputedStyle(
                document.querySelector('.duo-pricing-list-toolbar')
              ).visibility,
            })),
            null,
            2
          )
        );
      }
      assert.equal(shortFocusRestored, true, '短屏关闭后焦点应回批量入口');
    }

    const emptyStateWidths = await verifyEmptyStates();
    const readsBefore = pricingReads;
    role = 'operator';
    await page.reload();
    await page.waitForURL(`${BASE_URL}/profile`);
    assert.equal(await page.getByRole('link', { name: '报价管理', exact: true }).count(), 0);
    assert.equal(pricingReads, readsBefore, '普通账号直达不得读取报价配置');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          dimensions,
          shortScreens,
          writes: writes.length,
          previews: previews.length,
          modalOnlyEditor: true,
          mobileListWithoutHorizontalScroll: true,
          modalEscapeAndFocusRestore: true,
          modalScrollLock: true,
          modalFocusTrap: true,
          sourceTimestampVerified: true,
          emptyStateWidths,
          emptyHistoryWithoutTable: true,
          loadingAndErrorWithoutTable: true,
          shortFocusRestoreCycles: 3,
          historyWithoutHorizontalScroll: true,
          historyFullChangesDetails: true,
          footerAtDialogBottom: true,
          mobileFixedBatchEntry: true,
          fixedBatchEntryFocusRestore: true,
          fixedBatchbarDoesNotCoverContent: true,
          submitDisabledAndDeduplicated: true,
          conflicts: ['preview', 'save'],
          nullBase: true,
          invalidRetailRepair: true,
          mobileSave: true,
          modeSwitchClearsAmount: true,
          rowPrefillsCurrentValue: true,
          adminGuard: true,
          errors,
          unexpected,
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
