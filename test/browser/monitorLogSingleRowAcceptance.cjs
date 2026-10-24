/* global document, window, localStorage, getComputedStyle */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const baseUrl = process.env.MONITOR_SINGLE_ROW_URL || 'http://127.0.0.1:5173';
const output =
  process.env.MONITOR_SINGLE_ROW_OUTPUT || '/tmp/monitor-log-single-row-v2-attempt-001';
const PIXEL_TOLERANCE = 0.5;
fs.mkdirSync(output, { recursive: true });

/** 真实浏览器验收五筛选单行；全部API使用合成接口，不访问生产业务。 */
async function main() {
  let browser;
  let currentPage;
  const results = [];
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const widths = (process.env.MONITOR_SINGLE_ROW_WIDTHS || '1366,1440,1920,3598,768,375')
      .split(',')
      .map(Number);
    for (const width of widths) {
      const height = width === 3598 ? 1800 : 1000;
      const desktop = width >= 768;
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: !desktop,
        hasTouch: !desktop,
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      currentPage = page;
      page.setDefaultTimeout(12000);
      const errors = [];
      const requests = [];
      let forbiddenWrites = 0;
      const devices = Array.from({ length: 20 }, (_, index) => ({
        id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
        name: `US Server No.${index === 2 ? 20 : index === 19 ? 3 : index + 1}`,
        enabled: index !== 1,
        tag: index === 0 ? '北京' : index === 2 ? '长标签'.repeat(33) + '长' : '',
        tagVersion: index === 0 || index === 2 ? 1 : 0,
      }));
      const instances = devices.flatMap((device, index) =>
        [0, 1].map(item => ({
          deviceId: device.id,
          localId: `${String(index + 2).padStart(8, '0')}-2222-4222-8222-${String(item + 1).padStart(12, '0')}`,
          label: `心蓝0${item + 1}`,
          active: item === 0,
          tag:
            index === 0 && item === 0
              ? '主力'
              : index === 2 && item === 0
                ? '实例标签'.repeat(25)
                : '',
          tagVersion: (index === 0 && item === 0) || (index === 2 && item === 0) ? 1 : 0,
          snapshot: null,
        }))
      );
      const first = devices[0];
      const firstInstance = instances[0];
      const log = {
        id: '44444444-4444-4444-8444-444444444444',
        deviceId: first.id,
        localId: firstInstance.localId,
        fileId: '55555555-5555-4555-8555-555555555555',
        fileName: 'SyntheticLog_123.txt',
        loggedAt: new Date().toISOString(),
        lineNumber: '123',
        partIndex: 0,
        accountNumber: '001',
        message: '合成查询日志\n',
        parseState: 'parsed',
      };
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        try {
          const request = route.request();
          const url = new URL(request.url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === baseUrl) return await route.continue();
            return await route.abort();
          }
          if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
            forbiddenWrites++;
            return await route.abort();
          }
          let data;
          if (url.pathname === '/api/auth/me')
            data = {
              id: 9,
              username: 'synthetic-single-row',
              role: 'operator',
              permissions: ['monitor.manage', 'monitor.logs.read'],
              availableHome: '/server-monitor/logs',
            };
          else if (url.pathname === '/api/server-monitor/logs/states')
            data = { devices, instances };
          else if (url.pathname === '/api/server-monitor/logs/accounts')
            data = {
              items: ['001', '128'].filter(item =>
                item.includes(url.searchParams.get('search') || '')
              ),
              nextCursor: null,
            };
          else if (url.pathname === '/api/server-monitor/logs') {
            requests.push(Object.fromEntries(url.searchParams));
            data = { items: [log], nextCursor: null };
          } else throw new Error(`非预期合成API：${url.pathname}`);
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      await context.addInitScript(() =>
        localStorage.setItem('token', 'synthetic-single-row-token')
      );
      await page.goto(`${baseUrl}/server-monitor/logs`);
      const panel = page.getByRole('region', { name: '完整日志查询', exact: true });
      const server = panel.getByRole('button', { name: '服务器', exact: true });
      const instance = panel.getByRole('button', { name: '软件实例', exact: true });
      const account = panel.getByRole('combobox', { name: '账号编号', exact: true });
      const range = panel.getByRole('button', { name: /^日志时间范围：/ });
      const keyword = panel.getByRole('textbox', { name: '正文关键词', exact: true });
      const query = panel.getByRole('button', { name: '查询', exact: true });
      const controls = [server, instance, account, range, keyword];
      const geometries = [];

      async function measure(state, baseline) {
        const boxes = await Promise.all(controls.map(control => control.boundingBox()));
        assert(boxes.every(Boolean), `${state}五控件都应存在`);
        if (desktop) {
          boxes.forEach(box =>
            assert(Math.abs(box.height - 36) <= PIXEL_TOLERANCE, `${state}桌面筛选控件统一36px`)
          );
          assert(
            Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y)) <=
              PIXEL_TOLERANCE,
            `${state}桌面五筛选必须同一y，禁止换行`
          );
          assert(
            Math.max(...boxes.map(box => box.height)) - Math.min(...boxes.map(box => box.height)) <=
              PIXEL_TOLERANCE,
            `${state}五控件高度应一致`
          );
          if (baseline)
            boxes.forEach((box, index) =>
              assert(
                Math.abs(box.y - baseline[index].y) <= PIXEL_TOLERANCE,
                `${state}展开不得推移其他筛选触发器`
              )
            );
        }
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          `${state}页面不得横向溢出`
        );
        const scrollContainers = await panel.evaluate(element =>
          [...element.querySelectorAll('*')]
            .filter(
              node =>
                node.scrollWidth > node.clientWidth + 2 &&
                ['auto', 'scroll'].includes(getComputedStyle(node).overflowX)
            )
            .map(node => ({
              className: node.className,
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
            }))
        );
        geometries.push({ state, boxes, scrollContainers });
        return boxes;
      }

      await server.waitFor();
      const baseline = await measure('闭合');
      assert(await instance.isDisabled());
      await page.screenshot({ path: path.join(output, `闭合-${width}.png`), fullPage: true });
      const before = await query.boundingBox();
      await server.click();
      const search = panel.getByRole('combobox', { name: '搜索服务器', exact: true });
      const serverList = panel.getByRole('listbox', { name: '服务器', exact: true });
      await serverList.waitFor();
      await measure('服务器展开', baseline);
      const positions = await serverList.evaluate(element => {
        const result = [];
        for (
          let node = element;
          node && node.getAttribute('aria-label') !== '完整日志查询';
          node = node.parentElement
        )
          result.push(getComputedStyle(node).position);
        return result;
      });
      assert(
        !positions.some(position => ['absolute', 'fixed'].includes(position)),
        '服务器下拉必须正常文档流展开'
      );
      assert((await query.boundingBox()).y > before.y + 80, '展开列表必须向下推开查询操作区');
      assert(
        (await serverList.evaluate(element => element.scrollHeight)) >
          (await serverList.evaluate(element => element.clientHeight)),
        '长列表应内部滚动'
      );
      await page.screenshot({ path: path.join(output, `服务器展开-${width}.png`), fullPage: true });
      await search.fill(first.tag);
      assert.equal(await serverList.getByRole('option').count(), 1);
      await search.press('ArrowDown');
      await search.press('Enter');
      assert((await server.innerText()).includes(first.tag));
      assert((await server.getAttribute('title')).includes(first.tag));
      assert(
        await server
          .locator('.monitor-resource-trigger-name')
          .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
        '服务器名称编号应完整可辨'
      );
      assert(
        await server
          .locator('.monitor-resource-trigger-tag')
          .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
        '短标签应完整可见'
      );
      const selectedServer = await measure('服务器已选');
      await instance.click();
      const instanceSearch = panel.getByRole('combobox', { name: '搜索软件实例', exact: true });
      const instanceList = panel.getByRole('listbox', { name: '软件实例', exact: true });
      await instanceList.waitFor();
      await measure('实例展开', selectedServer);
      const instancePosition = await instanceList.evaluate(
        element => getComputedStyle(element).position
      );
      assert(!['absolute', 'fixed'].includes(instancePosition));
      await page.screenshot({ path: path.join(output, `实例展开-${width}.png`), fullPage: true });
      if (process.env.MONITOR_SINGLE_ROW_GEOMETRY_ONLY === 'true') {
        assert(
          geometries[0].scrollContainers.some(item => item.scrollWidth > item.clientWidth),
          '窄桌面仅筛选区域提供局部横滚'
        );
        assert.deepEqual(errors, []);
        results.push({
          width,
          height,
          passed: true,
          desktopSingleRow: desktop,
          geometryOnly: true,
          localFilterScroll: true,
          geometries,
        });
        await context.close();
        continue;
      }
      await instanceSearch.fill(firstInstance.tag);
      assert.equal(await instanceList.getByRole('option').count(), 1);
      await instanceList.getByRole('option').click();
      assert((await instance.innerText()).includes(firstInstance.tag));
      assert((await instance.getAttribute('title')).includes(firstInstance.tag));
      await measure('服务器与实例已选');
      await panel.getByRole('button', { name: '选择第1条日志', exact: true }).waitFor();

      await account.fill('001');
      const accountList = page.getByRole('listbox', { name: '账号候选', exact: true });
      await accountList.getByRole('option', { name: '001', exact: true }).waitFor();
      await accountList.getByRole('option', { name: '001', exact: true }).click();
      assert.equal(await account.inputValue(), '001');
      await range.click();
      const rangeDialog = page.getByRole('dialog', { name: '日志时间范围选择', exact: true });
      const yesterday = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const startAt = `${yesterday}T23:59:58`;
      const endAt = `${today}T00:00:02`;
      await rangeDialog.getByLabel('开始日期和时间', { exact: true }).fill(startAt);
      await rangeDialog.getByLabel('结束日期和时间', { exact: true }).fill(endAt);
      await rangeDialog.getByRole('button', { name: '应用时间范围', exact: true }).click();
      await keyword.fill('合成');
      const request = page.waitForRequest(
        item =>
          new URL(item.url()).pathname === '/api/server-monitor/logs' &&
          new URL(item.url()).searchParams.get('startAt') === startAt
      );
      await Promise.all([request, query.click()]);
      assert(
        requests.some(
          item =>
            item.startAt === startAt &&
            item.endAt === endAt &&
            item.account === '001' &&
            item.keyword === '合成'
        )
      );
      await measure('跨日账号关键词查询');
      await page.screenshot({ path: path.join(output, `标签已选-${width}.png`), fullPage: true });

      await server.click();
      await search.fill(devices[2].tag);
      await serverList.getByRole('option').click();
      assert((await server.getAttribute('title')).includes(devices[2].tag));
      assert((await instance.innerText()).includes('请选择实例'), '换服务器清空旧实例');
      await instance.click();
      await instanceSearch.fill('实例标签'.repeat(25));
      await instanceList.getByRole('option').click();
      assert((await instance.getAttribute('title')).includes('实例标签'.repeat(25)));
      await measure('100字长标签已选');
      assert(
        await server
          .locator('.monitor-resource-trigger-name')
          .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
        '长标签不能挤掉服务器编号'
      );
      await server.click();
      await search.fill('不存在的服务器');
      assert.equal(await serverList.getByRole('option').count(), 0);
      await search.press('Escape');
      assert(await server.evaluate(element => element === document.activeElement));
      await page.clock.install({ time: new Date('2027-01-02T04:00:00Z') });
      await range.click();
      await rangeDialog.getByLabel('开始日期和时间', { exact: true }).fill('2026-12-31T23:59:58');
      await rangeDialog.getByLabel('结束日期和时间', { exact: true }).fill('2027-01-01T00:00:02');
      await rangeDialog.getByRole('button', { name: '应用时间范围', exact: true }).click();
      const rangeText = await range.innerText();
      const rangeTitle = await range.getAttribute('title');
      assert(rangeText.includes('2026') && rangeText.includes('2027'), '跨年摘要必须明确两端年份');
      assert(
        rangeTitle?.includes('2026-12-31') && rangeTitle?.includes('2027-01-01'),
        '完整title保留跨年日期'
      );
      await measure('跨年范围已选');
      await page.screenshot({ path: path.join(output, `跨年范围-${width}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      assert.equal(forbiddenWrites, 0);
      results.push({
        width,
        height,
        passed: true,
        desktopSingleRow: desktop,
        inlineDropdown: true,
        fullTagSearchAndSelection: true,
        longTagTitle: true,
        rangeAccountQuery: true,
        crossYearRange: true,
        geometries,
      });
      await context.close();
    }
    fs.writeFileSync(
      path.join(output, '单行筛选浏览器结果.json'),
      JSON.stringify({ specVersion: 'v2-single-row', passed: true, results }, null, 2)
    );
  } catch (error) {
    if (currentPage && !currentPage.isClosed())
      await currentPage
        .screenshot({ path: path.join(output, '失败页面.png'), fullPage: true })
        .catch(() => {});
    fs.writeFileSync(
      path.join(output, '单行筛选浏览器结果.json'),
      JSON.stringify(
        { specVersion: 'v2-single-row', passed: false, results, error: error.stack },
        null,
        2
      )
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
