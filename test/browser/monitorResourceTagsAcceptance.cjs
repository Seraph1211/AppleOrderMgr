/* global localStorage, document, window, getComputedStyle */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const output = process.env.MONITOR_TAG_BROWSER_OUTPUT || '/tmp/monitor-resource-tags-acceptance';
const baseUrl = process.env.MONITOR_TAG_BROWSER_URL || 'http://127.0.0.1:5173';
fs.mkdirSync(output, { recursive: true });

/** 独立合成接口验收：所有 API 均拦截，禁止接触业务服务。 */
async function main() {
  let browser;
  let currentPage;
  const results = [];
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const widths = (process.env.MONITOR_TAG_BROWSER_WIDTHS || '1440,375').split(',').map(Number);
    for (const width of widths) {
      const height = width === 1080 ? 1920 : width === 1920 ? 1080 : 1000;
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: width < 768,
        hasTouch: width < 768,
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      currentPage = page;
      page.setDefaultTimeout(10000);
      const errors = [];
      const writes = [];
      const listRequests = [];
      const exportRequests = [];
      const productionComposition = process.env.MONITOR_TAG_TEST_READ_ONLY === 'true';
      let allowed = true;
      let readOnly = false;
      let failSave = false;
      let conflictSave = false;
      const devices = Array.from({ length: 24 }, (_, index) => ({
        id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
        name: `US Server No.${index + 1}${index === 2 ? ` ${'LongServerName'.repeat(8)}` : ''}`,
        enabled: index !== 1,
        tag: index === 0 ? '美国主力' : index === 2 ? '长'.repeat(100) : '',
        tagVersion: index === 0 || index === 2 ? 1 : 0,
      }));
      const instances = devices.flatMap((device, index) =>
        [0, 1].map(item => ({
          deviceId: device.id,
          localId: `${String(index + 2).padStart(8, '0')}-2222-4222-8222-${String(item + 1).padStart(12, '0')}`,
          label: `心蓝0${item + 1}`,
          active: item !== 1,
          tag: index === 0 && item === 0 ? '北京取货' : '',
          tagVersion: index === 0 && item === 0 ? 1 : 0,
          snapshot: null,
        }))
      );
      const first = devices[0];
      const firstInstance = instances[0];
      const logRow = {
        id: '44444444-4444-4444-8444-444444444444',
        deviceId: first.id,
        localId: firstInstance.localId,
        fileId: '55555555-5555-4555-8555-555555555555',
        fileName: 'Log20261024_123.txt',
        loggedAt: new Date().toISOString(),
        lineNumber: '123',
        partIndex: 0,
        accountNumber: '001',
        message: '合成跨日原始日志\n',
        parseState: 'parsed',
      };
      const catalog = () => ({ devices, instances });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        try {
          const request = route.request();
          const url = new URL(request.url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === baseUrl) return await route.continue();
            return await route.abort();
          }
          let data;
          if (url.pathname === '/api/auth/me') {
            data = {
              id: 9,
              username: 'synthetic-tag-test',
              role: 'operator',
              permissions: readOnly
                ? ['monitor.logs.read']
                : allowed
                  ? ['monitor.manage', 'monitor.logs.read']
                  : [],
              availableHome: allowed ? '/server-monitor/logs' : '/profile',
            };
          } else if (url.pathname === '/api/server-monitor/logs/states') {
            data = catalog();
          } else if (url.pathname === '/api/server-monitor/logs/tags') {
            assert.equal(request.method(), 'PUT');
            const body = request.postDataJSON();
            writes.push(body);
            const item = body.localId
              ? instances.find(
                  row => row.deviceId === body.deviceId && row.localId === body.localId
                )
              : devices.find(row => row.id === body.deviceId);
            assert(item);
            if (failSave || conflictSave) {
              if (conflictSave) {
                item.tag = '其他用户新标签';
                item.tagVersion += 1;
              }
              return await route.fulfill({
                status: conflictSave ? 409 : 503,
                json: {
                  success: false,
                  error: {
                    code: conflictSave ? 'CONCURRENT_MODIFICATION' : 'TEMPORARY_FAILURE',
                    message: conflictSave ? '标签已被其他用户修改，请刷新后重试' : '合成保存失败',
                  },
                },
              });
            }
            assert.equal(body.expectedVersion, item.tagVersion);
            item.tag = body.tag.trim();
            item.tagVersion += 1;
            data = {
              deviceId: body.deviceId,
              localId: body.localId || null,
              tag: item.tag,
              tagVersion: item.tagVersion,
            };
          } else if (url.pathname === '/api/server-monitor/logs/accounts') {
            data = { items: [], nextCursor: null };
          } else if (url.pathname === '/api/server-monitor/logs/export-ticket') {
            const body = request.postDataJSON();
            exportRequests.push(body);
            assert.equal(request.method(), 'POST');
            assert.equal(body.account, undefined, '导出不携带账号过滤');
            assert.equal(body.keyword, undefined, '导出不携带关键词过滤');
            data = { expiresInSeconds: 60 };
          } else if (url.pathname === '/api/server-monitor/logs/export') {
            assert.deepEqual(Object.fromEntries(url.searchParams), exportRequests.at(-1));
            return await route.fulfill({
              status: 200,
              headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': 'attachment; filename="synthetic-range.log"',
              },
              body: '合成跨日原始日志\n',
            });
          } else if (url.pathname.endsWith('/context')) {
            data = { anchorId: logRow.id, items: [logRow], beforeCursor: null, afterCursor: null };
          } else if (url.pathname === '/api/server-monitor/logs') {
            listRequests.push(Object.fromEntries(url.searchParams));
            data = {
              items: productionComposition
                ? [
                    {
                      id: '44444444-4444-4444-8444-444444444444',
                      deviceId: first.id,
                      localId: firstInstance.localId,
                      fileId: '55555555-5555-4555-8555-555555555555',
                      fileName: 'Log20261024_123.txt',
                      loggedAt: new Date().toISOString(),
                      lineNumber: '123',
                      partIndex: 0,
                      accountNumber: '001',
                      message: '合成跨日原始日志\n',
                      parseState: 'parsed',
                    },
                  ]
                : [],
              nextCursor: null,
            };
          } else {
            throw new Error(`非预期 API：${url.pathname}`);
          }
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-tag-token'));
      await page.goto(`${baseUrl}/server-monitor/logs`);
      const panel = page.getByRole('region', { name: '完整日志查询', exact: true });
      const server = panel.getByRole('button', { name: '服务器', exact: true });
      const instance = panel.getByRole('button', { name: '软件实例', exact: true });
      await server.waitFor();
      assert(await instance.isDisabled(), '未选服务器时实例不可选');
      if (productionComposition && width >= 1440) {
        const boxes = await Promise.all([
          server.boundingBox(),
          instance.boundingBox(),
          panel.getByRole('combobox', { name: '账号编号', exact: true }).boundingBox(),
          panel.getByRole('button', { name: /^日志时间范围：/ }).boundingBox(),
          panel.getByRole('textbox', { name: '正文关键词', exact: true }).boundingBox(),
        ]);
        assert(
          Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y)) <= 0.5,
          '桌面五项筛选同一行且对齐'
        );
        boxes.forEach(box => assert(Math.abs(box.height - 36) <= 0.5, '桌面筛选控件统一36px'));
      }
      const before = await panel.getByRole('button', { name: '查询', exact: true }).boundingBox();
      await server.click();
      const search = panel.getByRole('combobox', { name: '搜索服务器', exact: true });
      await search.waitFor();
      const list = panel.getByRole('listbox', { name: '服务器', exact: true });
      await list.waitFor();
      const placeholderBounds = await list
        .getByRole('option', { name: '请选择服务器', exact: true })
        .locator('span')
        .first()
        .evaluate(element => ({
          height: element.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(element).lineHeight),
        }));
      assert(
        placeholderBounds.height <= placeholderBounds.lineHeight + 1,
        '服务器下拉占位选项应保持一行，不能被窄列拆字'
      );
      assert((await search.boundingBox()).width >= 160, '资源搜索输入应有足够宽度');
      const layout = await list.evaluate(element => {
        const ancestors = [];
        for (
          let current = element;
          current && current.getAttribute('aria-label') !== '完整日志查询';
          current = current.parentElement
        ) {
          ancestors.push(getComputedStyle(current).position);
        }
        return { ancestors, height: element.clientHeight, scrollHeight: element.scrollHeight };
      });
      assert(
        !layout.ancestors.some(position => ['absolute', 'fixed'].includes(position)),
        '资源下拉必须在正常文档流中'
      );
      const after = await panel.getByRole('button', { name: '查询', exact: true }).boundingBox();
      assert(after.y > before.y + 80, '展开应推开下方内容，不能悬浮覆盖');
      assert(
        layout.height <= 400 && layout.scrollHeight > layout.height,
        '长列表限制高度并内部滚动'
      );
      assert(await list.getByRole('option').filter({ hasText: '已停用' }).count());
      await page.screenshot({ path: path.join(output, `下拉展开-${width}.png`), fullPage: true });
      await search.fill('美国主力');
      assert.equal(await list.getByRole('option').count(), 1);
      await search.press('ArrowDown');
      await search.press('Enter');
      await search.waitFor({ state: 'hidden' });
      assert((await server.innerText()).includes('美国主力'));
      assert(
        await server.evaluate(element => element === document.activeElement),
        '键盘选择后返回触发器'
      );
      await instance.click();
      const instanceList = panel.getByRole('listbox', { name: '软件实例', exact: true });
      assert((await instanceList.innerText()).includes('已移除'));
      await panel.getByRole('combobox', { name: '搜索软件实例', exact: true }).fill('北京取货');
      await instanceList.getByRole('option').filter({ hasText: '北京取货' }).click();
      assert((await instance.innerText()).includes('北京取货'));
      if (productionComposition) {
        const yesterday = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
        const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
        const startAt = `${yesterday}T23:59:58`;
        const endAt = `${today}T00:00:02`;
        await panel.getByRole('button', { name: /^日志时间范围：/ }).click();
        const range = page.getByRole('dialog', { name: '日志时间范围选择', exact: true });
        await range.getByLabel('开始日期和时间', { exact: true }).fill(startAt);
        await range.getByLabel('结束日期和时间', { exact: true }).fill(endAt);
        await range.getByRole('button', { name: '应用时间范围', exact: true }).click();
        await panel.getByRole('textbox', { name: '正文关键词', exact: true }).fill('合成');
        await panel.getByRole('combobox', { name: '账号编号', exact: true }).fill('001');
        await panel.getByRole('combobox', { name: '账号编号', exact: true }).press('Escape');
        const rangeRequest = page.waitForRequest(
          request =>
            new URL(request.url()).pathname === '/api/server-monitor/logs' &&
            new URL(request.url()).searchParams.get('startAt') === startAt
        );
        await Promise.all([
          rangeRequest,
          panel.getByRole('button', { name: '查询', exact: true }).click(),
        ]);
        assert(
          listRequests.some(
            request =>
              request.startAt === startAt &&
              request.endAt === endAt &&
              request.account === '001' &&
              request.keyword === '合成'
          )
        );
        const firstLog = panel.getByRole('button', { name: '选择第1条日志', exact: true });
        await firstLog.click();
        await panel.getByRole('button', { name: '详情与上下文', exact: true }).click();
        const details = page.getByRole('dialog', { name: '日志详情与上下文', exact: true });
        await details.getByRole('button', { name: '查看日志元信息', exact: true }).click();
        const metadata = page.getByRole('dialog', { name: '日志元信息', exact: true });
        await metadata.getByText('Log20261024_123.txt', { exact: true }).waitFor();
        await metadata.getByText('第 123 行 · 第 1 段', { exact: true }).waitFor();
        await page.screenshot({
          path: path.join(output, `跨日查询元信息-${width}.png`),
          fullPage: true,
        });
        await metadata.getByRole('button', { name: '关闭日志元信息', exact: true }).click();
        await details.getByRole('button', { name: '关闭日志详情', exact: true }).click();
        const downloadPromise = page.waitForEvent('download');
        await panel.getByRole('button', { name: '导出范围日志', exact: true }).click();
        const download = await downloadPromise;
        assert.equal(fs.readFileSync(await download.path(), 'utf8'), '合成跨日原始日志\n');
        assert.deepEqual(exportRequests.at(-1), {
          deviceId: first.id,
          localId: firstInstance.localId,
          startAt,
          endAt,
        });
      }
      await server.click();
      await search.fill('No.2');
      assert((await list.innerText()).includes('No.2'));
      await search.fill('绝不存在');
      assert.equal(await list.getByRole('option').count(), 0);
      await search.press('Escape');
      await list.waitFor({ state: 'hidden' });
      assert(await server.evaluate(element => element === document.activeElement));
      await panel.getByRole('button', { name: '标签管理', exact: true }).click();
      const tags = panel.getByRole('region', { name: '服务器与实例标签管理', exact: true });
      const serverInput = tags.getByRole('textbox', { name: `${first.name}标签`, exact: true });
      const serverRow = serverInput.locator('xpath=ancestor::tr');
      const instanceInput = tags.getByRole('textbox', {
        name: `${first.name} / ${firstInstance.label}标签`,
        exact: true,
      });
      const instanceRow = instanceInput.locator('xpath=ancestor::tr');
      assert.equal(await serverInput.inputValue(), '美国主力');
      assert.equal(await instanceInput.inputValue(), '北京取货');
      assert.equal(await serverInput.getAttribute('maxlength'), '100');
      await serverInput.fill('上海测试');
      await serverInput.press('Enter');
      await page.waitForFunction(() =>
        document.querySelector('button[aria-label="服务器"]').textContent.includes('上海测试')
      );
      assert.equal(first.tag, '上海测试');
      assert.equal(writes.at(-1).localId, null);
      await instanceInput.fill('<script>window.tagInjected=true</script>');
      await instanceRow.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('button[aria-label="软件实例"]').textContent.includes('<script>')
      );
      assert.equal(
        await page.evaluate(() => window.tagInjected),
        undefined,
        '标签必须按纯文本显示'
      );
      await page.reload();
      await server.click();
      await search.fill('上海测试');
      await list.getByRole('option').click();
      assert((await server.innerText()).includes('上海测试'), '刷新后服务端标签仍显示');
      await instance.click();
      await panel.getByRole('combobox', { name: '搜索软件实例', exact: true }).fill('<script>');
      await instanceList.getByRole('option').click();
      await panel.getByRole('button', { name: '标签管理', exact: true }).click();
      await instanceRow.getByRole('button', { name: '清空', exact: true }).click();
      await page.waitForFunction(
        () =>
          !document.querySelector('button[aria-label="软件实例"]').textContent.includes('<script>')
      );
      assert.equal(firstInstance.tag, '');
      failSave = true;
      await serverInput.fill('不得丢失的编辑');
      await serverRow.getByRole('button', { name: '保存', exact: true }).click();
      await tags.getByText('合成保存失败', { exact: false }).waitFor();
      assert.equal(await serverInput.inputValue(), '不得丢失的编辑');
      assert.equal(first.tag, '上海测试');
      failSave = false;
      await serverRow.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('button[aria-label="服务器"]').textContent.includes('不得丢失的编辑')
      );
      conflictSave = true;
      await serverInput.fill('冲突草稿');
      await serverRow.getByRole('button', { name: '保存', exact: true }).click();
      await serverRow.getByText('标签已被其他用户修改，请刷新后重试', { exact: false }).waitFor();
      assert.equal(await serverInput.inputValue(), '冲突草稿');
      conflictSave = false;
      await serverRow.getByRole('button', { name: '重新读取', exact: true }).click();
      await serverRow.getByText('最新标签：其他用户新标签', { exact: false }).waitFor();
      assert.equal(await serverInput.inputValue(), '冲突草稿', '读取最新版本也应保留用户草稿');
      await serverRow.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('button[aria-label="服务器"]').textContent.includes('冲突草稿')
      );
      await tags
        .getByRole('textbox', { name: '搜索标签管理资源', exact: true })
        .fill('US Server No.1');
      await tags.getByRole('textbox', { name: '搜索标签管理资源', exact: true }).press('Enter');
      await page.screenshot({ path: path.join(output, `标签管理-${width}.png`), fullPage: true });
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        '窄屏页面不得横向溢出'
      );
      await server.click();
      await search.fill('长长长');
      assert.equal(await list.getByRole('option').count(), 1);
      await list.getByRole('option').click();
      assert(
        (await server.getAttribute('title')).includes('长'.repeat(100)),
        '选中摘要 title 保留完整标签'
      );
      const selectedSummary = await server
        .locator('span')
        .first()
        .evaluate(element => ({
          height: element.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(element).lineHeight),
        }));
      assert(selectedSummary.height <= selectedSummary.lineHeight * 2 + 1, '选中摘要最多两行');
      assert(await instance.isEnabled());
      assert(!(await instance.innerText()).includes('北京取货'), '切换服务器重置实例选择');
      assert.equal(await instance.innerText(), '请选择实例');
      await instance.click();
      await panel.getByRole('combobox', { name: '搜索软件实例', exact: true }).fill('心蓝01');
      await instanceList.getByRole('option').click();
      assert(!(await instance.innerText()).includes('冲突草稿'), '另一服务器同名实例不继承旧标签');
      await tags
        .getByRole('textbox', { name: '搜索标签管理资源', exact: true })
        .fill('LongServerName');
      const longInput = tags.getByRole('textbox', { name: `${devices[2].name}标签`, exact: true });
      assert.equal(await longInput.inputValue(), '长'.repeat(100));
      if (width < 768) {
        await longInput.scrollIntoViewIfNeeded();
        const bounds = await longInput.boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width, '表格横滚后输入框完整可见');
        const clear = longInput
          .locator('xpath=ancestor::tr')
          .getByRole('button', { name: '清空', exact: true });
        await clear.scrollIntoViewIfNeeded();
        assert(await clear.isVisible(), '横向滚动可访问每行操作按钮');
      }
      await page.screenshot({
        path: path.join(output, `长名称长标签-${width}.png`),
        fullPage: true,
      });
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        '长标签不得撑破页面'
      );
      if (process.env.MONITOR_TAG_TEST_READ_ONLY === 'true') {
        readOnly = true;
        await page.reload();
        await server.waitFor();
        assert.equal(await panel.getByRole('button', { name: '标签管理', exact: true }).count(), 0);
        assert.equal(
          await panel.getByRole('region', { name: '服务器与实例标签管理', exact: true }).count(),
          0
        );
        await server.click();
        await search.fill('冲突草稿');
        assert.equal(await list.getByRole('option').count(), 1, '只读用户仍可搜索标签');
        await list.getByRole('option').click();
        assert((await server.innerText()).includes('冲突草稿'));
        readOnly = false;
      }
      allowed = false;
      await page.reload();
      await panel.waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('button', { name: '标签管理', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      results.push({
        width,
        height,
        passed: true,
        writes: writes.length,
        inlineDropdown: true,
        keyboard: true,
        persistence: true,
        failureRecovery: true,
        conflictRecovery: true,
        longTag: true,
        readOnly: process.env.MONITOR_TAG_TEST_READ_ONLY === 'true',
      });
      await context.close();
    }
    fs.writeFileSync(
      path.join(output, '浏览器结果.json'),
      JSON.stringify({ passed: true, results }, null, 2)
    );
  } catch (error) {
    if (currentPage && !currentPage.isClosed())
      await currentPage
        .screenshot({ path: path.join(output, '失败页面.png'), fullPage: true })
        .catch(() => {});
    fs.writeFileSync(
      path.join(output, '浏览器结果.json'),
      JSON.stringify({ passed: false, results, error: error.stack }, null, 2)
    );
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
