/* global localStorage, document, navigator */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const logger = require('../src/utils/logger');

const BASE_URL = process.env.MONITOR_BROWSER_BASE_URL;
const EXECUTABLE = process.env.MONITOR_BROWSER_EXECUTABLE;
const OUTPUT_DIR = path.resolve(
  process.env.MONITOR_BROWSER_ARTIFACT_DIR || 'coverage/monitor-log-date-range'
);
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const LOCAL_ID = '22222222-2222-4222-8222-222222222222';
const ROW_ID = '44444444-4444-4444-8444-444444444444';

function beijingDate(offset = 0) {
  return new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

function beijingTimestamp(date, time) {
  return new Date(`${date}T${time}+08:00`).toISOString();
}

function contextTimestamp(date, index) {
  const anchor = Date.parse(`${date}T23:59:30+08:00`);
  return new Date(anchor + (index - 100) * 100).toISOString();
}

function contextMessage(timestamp, label) {
  const date = new Date(timestamp);
  const beijing = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return `${beijing}.${date.toISOString().slice(20, 23)} [2][128]${label}\n`;
}

function contextEdgeTimes(direction, twoDaysAgo, yesterday, today) {
  return direction === 'before'
    ? [
      beijingTimestamp(twoDaysAgo, '23:58:00'),
      beijingTimestamp(twoDaysAgo, '23:59:00'),
      beijingTimestamp(yesterday, '00:00:01'),
      beijingTimestamp(yesterday, '23:40:00'),
      beijingTimestamp(yesterday, '23:42:00'),
    ]
    : [
      beijingTimestamp(yesterday, '23:59:50'),
      beijingTimestamp(yesterday, '23:59:59'),
      beijingTimestamp(today, '00:00:01'),
      beijingTimestamp(today, '00:01:00'),
      beijingTimestamp(today, '00:02:00'),
    ];
}

async function assertSelectedContextHighlight(reader, rowId) {
  const anchor = reader.locator(`tr[data-context-id="${rowId}"]`);
  await anchor.waitFor();
  const style = await anchor.evaluate(element => {
    const cells = Array.from(element.querySelectorAll(':scope > td'));
    return {
      selected: element.getAttribute('data-selected'),
      ariaSelected: element.getAttribute('aria-selected'),
      backgrounds: cells.map(
        cell => cell.ownerDocument.defaultView.getComputedStyle(cell).backgroundColor
      ),
      shadows: cells.map(cell => cell.ownerDocument.defaultView.getComputedStyle(cell).boxShadow),
    };
  });
  assert.equal(style.selected, 'true', 'context锚点身份应保持选中');
  assert.equal(style.ariaSelected, 'true', 'context锚点应暴露选中语义');
  assert(
    style.backgrounds.length > 0 &&
      style.backgrounds.every(color => color === 'rgb(239, 246, 255)'),
    `context锚点的每个td应实际渲染浅蓝背景：${style.backgrounds.join(', ')}`
  );
  assert(
    style.shadows.some(shadow => shadow.includes('rgb(30, 58, 138)')),
    `context锚点的td应实际渲染蓝色强调线：${style.shadows.join(', ')}`
  );
}

async function assertFilterLayout(page, panel) {
  const rangeButton = panel.getByRole('button', { name: /^日志时间范围：/ });
  const rangeBox = await rangeButton.locator('xpath=..').boundingBox();
  const rangeLabel = await rangeButton.getAttribute('aria-label');
  const rangeText = rangeButton.locator('span').first();
  const rangeTextLayout = await rangeText.evaluate(element => ({
    text: element.innerText,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  const keywordBox = await panel
    .getByLabel('正文关键词', { exact: true })
    .locator('xpath=..')
    .boundingBox();
  const checkboxBox = await panel
    .locator('#log-query-filters label')
    .filter({ hasText: '仅查看未识别账号的日志' })
    .boundingBox();
  const gridBox = await panel.locator('#log-query-filters > div').first().boundingBox();
  const viewport = page.viewportSize();
  assert(
    rangeBox.x >= 0 && rangeBox.x + rangeBox.width <= viewport.width + 1,
    '范围控件不得横向溢出'
  );
  assert.equal(
    rangeTextLayout.text,
    rangeLabel.replace(/^日志时间范围：/, ''),
    '范围按钮完整显示所选时间'
  );
  assert(
    rangeTextLayout.scrollWidth <= rangeTextLayout.clientWidth + 1,
    '范围按钮文字不被横向裁切'
  );
  assert(
    rangeTextLayout.scrollHeight <= rangeTextLayout.clientHeight + 1,
    '范围按钮文字完整换行显示'
  );
  assert(
    keywordBox.x >= 0 && keywordBox.x + keywordBox.width <= viewport.width + 1,
    '关键词控件不得横向溢出'
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.defaultView.innerWidth + 1
    ),
    '筛选布局不得造成页面横向溢出'
  );
  if (viewport.width >= 1280) {
    assert(Math.abs(rangeBox.width / gridBox.width - 0.5) < 0.06, '桌面范围控件占6/12列');
    assert(keywordBox.width / gridBox.width > 0.62, '桌面关键词控件占8/12列');
    assert(checkboxBox.width / gridBox.width < 0.5, '桌面未识别账号控件保持紧凑宽度');
    assert(rangeBox.y < keywordBox.y, '桌面时间范围位于关键词上方');
    assert(Math.abs(keywordBox.y - checkboxBox.y) < 80, '关键词和未识别账号位于同一排');
    assert(keywordBox.x < checkboxBox.x, '桌面关键词位于未识别账号控件左侧');
  } else if (viewport.width >= 640) {
    assert(rangeBox.width > gridBox.width * 0.4, '竖屏时间范围应保持可读宽度');
    assert(keywordBox.width > gridBox.width * 0.4, '竖屏关键词应保持可读宽度');
    assert(rangeBox.y < keywordBox.y, '竖屏时间范围排在关键词之前');
    assert(Math.abs(keywordBox.y - checkboxBox.y) < 80, '竖屏关键词和未识别账号位于同一排');
    assert(keywordBox.x < checkboxBox.x, '竖屏关键词位于未识别账号控件左侧');
  } else {
    assert(rangeBox.width > gridBox.width * 0.85, '窄屏时间范围控件占满可用行宽');
    assert(keywordBox.width > gridBox.width * 0.85, '窄屏关键词控件占满可用行宽');
    assert(rangeBox.y < keywordBox.y, '窄屏时间范围排在关键词之前');
  }
}

async function chooseSelect(page, panel, label, value, optionName) {
  const control = panel.getByLabel(label, { exact: true });
  if ((await control.evaluate(element => element.tagName)) === 'SELECT') {
    await control.selectOption(value);
    return;
  }
  await control.click();
  await page
    .getByRole('dialog', { name: label, exact: true })
    .getByRole('option', { name: optionName, exact: true })
    .click();
}

/** 用合成API执行完整日志时间范围的浏览器回归。 */
async function runViewport(browser, mode) {
  const mobile = mode === 'mobile';
  let viewport;
  if (mobile) viewport = { width: 375, height: 740 };
  else if (mode === 'portrait') viewport = { width: 1080, height: 1920 };
  else if (mode === 'standard') viewport = { width: 1440, height: 1000 };
  else viewport = { width: 1920, height: 1080 };
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    serviceWorkers: 'block',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);

  const errors = [];
  const listQueries = [];
  const contextQueries = [];
  const exportQueries = [];
  const ticketBodies = [];
  const now = new Date().toISOString();
  const today = beijingDate();
  const yesterday = beijingDate(-1);
  const twoDaysAgo = beijingDate(-2);
  const row = {
    id: ROW_ID,
    deviceId: DEVICE_ID,
    localId: LOCAL_ID,
    fileId: '55555555-5555-4555-8555-555555555555',
    fileName: `Log${yesterday.replaceAll('-', '')}_128.txt`,
    loggedAt: contextTimestamp(yesterday, 100),
    lineNumber: '42',
    partIndex: 0,
    accountNumber: '128',
    message: contextMessage(contextTimestamp(yesterday, 100), '跨日合成原文'),
    parseState: 'parsed',
  };

  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    try {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/')) {
        if (url.origin === BASE_URL) await route.continue();
        else await route.abort();
        return;
      }

      let data;
      if (url.pathname === '/api/auth/me') {
        data = {
          id: 9,
          username: 'monitor-range-browser-test',
          role: 'operator',
          permissions: ['monitor.manage', 'monitor.logs.read'],
          availableHome: '/server-monitor',
        };
      } else if (url.pathname === '/api/server-monitor/logs/states') {
        data = {
          devices: [{ id: DEVICE_ID, name: '合成服务器01', enabled: true }],
          instances: [
            {
              deviceId: DEVICE_ID,
              localId: LOCAL_ID,
              label: '合成实例1',
              active: true,
              fresh: true,
              observedAt: now,
              snapshot: {
                state: 'ready',
                dates: [today, yesterday],
                fileCount: 2,
                totalBytes: 2048,
                scannedBytes: 2048,
                pending: 0,
                issues: 0,
                expired: 0,
              },
            },
          ],
        };
      } else if (url.pathname.endsWith('/logs/accounts')) {
        data = { items: ['001', '128', '129'], nextCursor: null };
      } else if (url.pathname.endsWith('/context')) {
        const query = Object.fromEntries(url.searchParams);
        contextQueries.push(query);
        const direction = url.searchParams.get('direction');
        const rows = direction
          ? Array.from({ length: 5 }, (_, index) => ({
            ...row,
            id: `context-${direction}-${index}`,
            lineNumber: String(direction === 'before' ? index + 1 : 48 + index),
            loggedAt: contextEdgeTimes(direction, twoDaysAgo, yesterday, today)[index],
            message: contextMessage(
              contextEdgeTimes(direction, twoDaysAgo, yesterday, today)[index],
              `${direction === 'before' ? '更早' : '更晚'}上下文行 ${index}`
            ),
          }))
          : Array.from({ length: 201 }, (_, index) => ({
            ...row,
            id: index === 100 ? ROW_ID : `context-initial-${index}`,
            lineNumber: String(index + 1),
            loggedAt: contextTimestamp(yesterday, index),
            message:
                index === 100
                  ? row.message
                  : contextMessage(contextTimestamp(yesterday, index), `上下文初始行 ${index}`),
          }));
        data = direction
          ? { anchorId: ROW_ID, scope: query.scope, direction, hasMore: false, items: rows }
          : {
            anchorId: ROW_ID,
            scope: query.scope,
            direction: null,
            hasMoreBefore: true,
            hasMoreAfter: true,
            items: rows,
          };
      } else if (url.pathname === '/api/server-monitor/logs/export-ticket') {
        ticketBodies.push(JSON.parse(route.request().postData()));
        await route.fulfill({ json: { success: true, data: { expiresInSeconds: 60 } } });
        return;
      } else if (url.pathname === '/api/server-monitor/logs/export') {
        exportQueries.push(Object.fromEntries(url.searchParams));
        await route.fulfill({
          body: '跨日完整合成日志\n',
          contentType: 'text/plain; charset=utf-8',
          headers: { 'content-disposition': 'attachment; filename="synthetic-range.log"' },
        });
        return;
      } else if (url.pathname === '/api/server-monitor/logs') {
        listQueries.push(Object.fromEntries(url.searchParams));
        data = {
          items: [{ ...row }],
          nextCursor: null,
        };
      } else {
        throw new Error(`非预期API：${url.pathname}`);
      }
      await route.fulfill({ json: { success: true, data } });
    } catch (error) {
      errors.push(error.message);
      await route.abort();
    }
  });

  try {
    await context.addInitScript(() =>
      localStorage.setItem('token', 'synthetic-monitor-range-token')
    );
    await page.goto(`${BASE_URL}/server-monitor/logs`);
    const panel = page.getByRole('region', { name: '完整日志查询', exact: true });
    await chooseSelect(page, panel, '服务器', DEVICE_ID, '合成服务器01');
    await chooseSelect(page, panel, '软件实例', LOCAL_ID, '合成实例1');
    await panel.getByRole('button', { name: '选择第1条日志', exact: true }).waitFor();
    await assertFilterLayout(page, panel);
    assert(listQueries.length >= 1, '选择实例后应读取默认当天日志');
    assert.equal(listQueries.at(-1).startAt?.slice(0, 10), today);
    assert.equal(listQueries.at(-1).endAt?.slice(0, 10), today);
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `date-range-${mode}-main.png`),
      fullPage: true,
      animations: 'disabled',
    });

    const rangeButton = page.getByRole('button', { name: /^日志时间范围：/ });
    await rangeButton.click();
    const rangeDialog = page.getByRole('dialog', { name: '日志时间范围选择', exact: true });
    const startInput = rangeDialog.getByLabel('开始日期和时间', { exact: true });
    const endInput = rangeDialog.getByLabel('结束日期和时间', { exact: true });
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `date-range-${mode}-picker.png`),
      fullPage: true,
      animations: 'disabled',
    });
    const lastQueryCount = listQueries.length;
    await startInput.fill(`${yesterday}T23:50:17`);
    await endInput.fill(`${today}T00:10:42`);
    await rangeDialog.getByRole('button', { name: '应用时间范围', exact: true }).click();
    assert.equal(listQueries.length, lastQueryCount, '应用草稿范围本身不能提前查询');
    await panel.getByRole('button', { name: '查询', exact: true }).click();
    await page.waitForFunction(() => true);
    await page.waitForTimeout(100);
    const crossDayQuery = listQueries.at(-1);
    assert.equal(crossDayQuery.startAt, `${yesterday}T23:50:17`);
    assert.equal(crossDayQuery.endAt, `${today}T00:10:42`);
    assert.equal(crossDayQuery.deviceId, DEVICE_ID);
    assert.equal(crossDayQuery.localId, LOCAL_ID);
    assert.equal(crossDayQuery.account || undefined, undefined);
    assert.equal(crossDayQuery.keyword || undefined, undefined);

    await rangeButton.click();
    await rangeDialog.getByRole('button', { name: '最近24小时', exact: true }).click();
    const recentStart = await startInput.inputValue();
    const recentEnd = await endInput.inputValue();
    const rangeMillis = Date.parse(`${recentEnd}+08:00`) - Date.parse(`${recentStart}+08:00`);
    assert.equal(rangeMillis, 24 * 60 * 60 * 1000, '最近24小时必须覆盖完整24小时');
    await rangeDialog.getByRole('button', { name: '应用时间范围', exact: true }).click();
    assert.equal(listQueries.length, lastQueryCount + 1, '快捷范围应用仍只更新草稿');

    await rangeButton.click();
    const beforeInvalid = listQueries.length;
    await endInput.evaluate((element, value) => {
      Object.getOwnPropertyDescriptor(
        element.ownerDocument.defaultView.HTMLInputElement.prototype,
        'value'
      ).set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, `${today}T11:59:59`);
    await startInput.evaluate((element, value) => {
      Object.getOwnPropertyDescriptor(
        element.ownerDocument.defaultView.HTMLInputElement.prototype,
        'value'
      ).set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, `${today}T12:00:00`);
    await rangeDialog.getByRole('alert').waitFor();
    assert(
      await rangeDialog.getByRole('button', { name: '应用时间范围', exact: true }).isDisabled(),
      '结束早于开始时应用按钮应禁用'
    );
    assert.equal(listQueries.length, beforeInvalid, '结束早于开始时不得发查询请求');
    assert(await rangeDialog.isVisible(), '无效范围应留在日期范围对话框中供修正');
    await startInput.fill(`${yesterday}T23:50:17`);
    await endInput.fill(`${today}T00:10:42`);
    await rangeDialog.getByRole('button', { name: '应用时间范围', exact: true }).click();

    const keyword = panel.getByLabel('正文关键词', { exact: true });
    await keyword.fill('跨日');
    const accountInput = panel.getByRole('combobox', { name: '账号编号', exact: true });
    await accountInput.fill('128');
    const beforeDraftQuery = listQueries.length;
    await keyword.fill('草稿变更');
    assert.equal(listQueries.length, beforeDraftQuery, '编辑关键词只改草稿');
    const updateQuery = page.waitForRequest(request => {
      const url = new URL(request.url());
      return (
        url.pathname === '/api/server-monitor/logs' &&
        url.searchParams.get('keyword') === '草稿变更'
      );
    });
    await panel.getByRole('button', { name: '查询', exact: true }).click();
    await updateQuery;
    await panel.getByRole('button', { name: '选择第1条日志', exact: true }).waitFor();

    await panel.getByRole('button', { name: '选择第1条日志', exact: true }).click();
    await panel.getByRole('button', { name: '复制选中日志', exact: true }).click();
    await panel.getByText('日志已复制', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), row.message);
    const trigger = panel.getByRole('button', { name: '详情与上下文', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: '日志详情与上下文', exact: true });
    await drawer.waitFor();
    const infoButton = drawer.getByRole('button', { name: '查看日志元信息', exact: true });
    await infoButton.hover();
    const info = page.getByRole('dialog', { name: '日志元信息', exact: true });
    await info.getByText(row.fileName, { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `date-range-${mode}-metadata.png`),
      fullPage: false,
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await info.waitFor({ state: 'hidden' });
    assert(await drawer.isVisible(), 'Esc关闭悬浮元信息时应保留详情侧栏');
    assert(
      await infoButton.evaluate(element => element === document.activeElement),
      '关闭元信息后焦点返回Info按钮'
    );
    await infoButton.evaluate(element => element.blur());
    await page.waitForTimeout(50);
    await infoButton.focus();
    await info.getByText(row.fileName, { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await info.waitFor({ state: 'hidden' });
    await infoButton.click();
    await info.getByText(row.fileName, { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await info.waitFor({ state: 'hidden' });
    const drawerBox = await drawer.boundingBox();
    const viewport = page.viewportSize();
    assert.equal(drawerBox.y, 0, '详情侧栏顶部应贴合视口');
    assert.equal(drawerBox.height, viewport.height, '详情侧栏应占满视口高度');
    if (mobile) {
      assert.equal(drawerBox.x, 0, '手机详情应从屏幕左侧全屏展开');
      assert.equal(drawerBox.width, viewport.width, '手机详情应全屏宽度');
    } else {
      assert(
        Math.abs(drawerBox.width - Math.min(viewport.width * 0.9, 1600)) <= 2,
        '桌面详情宽度应为 min(90vw, 1600px)'
      );
    }

    const reader = drawer.getByRole('region', { name: '上下文日志阅读区', exact: true });
    if (!mobile) {
      const contextBox = await reader.boundingBox();
      assert(
        Math.abs(contextBox.y + contextBox.height - (drawerBox.y + drawerBox.height)) < 40,
        '桌面上下文阅读区应填满详情侧栏底部剩余空间'
      );
    }
    await reader.getByText(row.message.trim(), { exact: true }).waitFor();
    assert.equal(
      await drawer.getByText(row.message.trim(), { exact: true }).count(),
      1,
      '详情不应另设选中原文区块'
    );
    assert.equal(await reader.locator('tbody tr').count(), 201, '初始上下文包含锚点前后连续行');
    await assertSelectedContextHighlight(reader, ROW_ID);
    assert(
      (await reader.getByText(new RegExp(`${twoDaysAgo} 23:58:00`)).count()) === 0,
      '更早跨日记录须待向上翻页加载'
    );
    assert(
      (await reader.getByText(new RegExp(`${yesterday} 23:59:30`)).count()) > 0,
      '可见原文应显示锚点北京时间'
    );
    await page.mouse.move(viewport.width - 20, 20);
    await infoButton.hover();
    await info.getByText(row.fileName, { exact: true }).waitFor();
    await assertSelectedContextHighlight(reader, ROW_ID);
    await page.keyboard.press('Escape');
    await info.waitFor({ state: 'hidden' });
    await reader.evaluate(element => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await drawer.getByText(/更早上下文行 0/).waitFor();
    await assertSelectedContextHighlight(reader, ROW_ID);
    assert(
      (await reader.getByText(new RegExp(`${twoDaysAgo} 23:58:00`)).count()) > 0,
      '向上翻页可见两天前的北京时间原文'
    );
    if (mode === 'standard') {
      await reader.evaluate(element => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      await page.screenshot({
        path: path.join(OUTPUT_DIR, 'date-range-context-before-boundary.png'),
        fullPage: false,
        animations: 'disabled',
      });
    }
    await reader.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await drawer.getByText(/更晚上下文行 0/).waitFor();
    await assertSelectedContextHighlight(reader, ROW_ID);
    assert(
      (await reader.getByText(new RegExp(`${today} 00:00:01`)).count()) > 0,
      '向下翻页可见今天午夜后的北京时间原文'
    );
    if (mode === 'standard') {
      await reader.evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
      });
      await page.screenshot({
        path: path.join(OUTPUT_DIR, 'date-range-context-after-boundary.png'),
        fullPage: false,
        animations: 'disabled',
      });
    }
    assert(contextQueries.some(query => query.direction === 'before'));
    assert(contextQueries.some(query => query.direction === 'after'));

    const scopeChange = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname.endsWith('/context') && url.searchParams.get('scope') === 'instance';
    });
    await drawer.getByRole('button', { name: '整个实例上下文', exact: true }).click();
    await scopeChange;
    await reader.getByText(/上下文初始行 0/).waitFor();
    await assertSelectedContextHighlight(reader, ROW_ID);
    const accountScopeChange = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname.endsWith('/context') && url.searchParams.get('scope') === 'account';
    });
    await drawer.getByRole('button', { name: '该账号上下文', exact: true }).click();
    await accountScopeChange;
    await reader.getByText(/上下文初始行 0/).waitFor();
    await assertSelectedContextHighlight(reader, ROW_ID);

    await page.screenshot({
      path: path.join(OUTPUT_DIR, `date-range-${mode}-drawer.png`),
      fullPage: false,
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    assert(
      await trigger.evaluate(element => element === document.activeElement),
      'Esc关闭详情后焦点返回打开详情的按钮'
    );

    const appliedQuery = listQueries.at(-1);
    const downloadPromise = page.waitForEvent('download');
    const exportRequestPromise = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/api/server-monitor/logs/export';
    });
    await panel.getByRole('button', { name: /导出/ }).click();
    const download = await downloadPromise;
    await exportRequestPromise;
    assert.equal(ticketBodies.length, 1);
    assert.equal(exportQueries.length, 1);
    for (const query of [ticketBodies[0], exportQueries[0]]) {
      assert.equal(query.deviceId, DEVICE_ID);
      assert.equal(query.localId, LOCAL_ID);
      assert.equal(query.startAt, appliedQuery.startAt);
      assert.equal(query.endAt, appliedQuery.endAt);
      assert.equal(query.account || undefined, undefined, '导出不携带账号筛选');
      assert.equal(query.keyword || undefined, undefined, '导出不携带关键词筛选');
    }
    assert.equal(download.suggestedFilename(), 'synthetic-range.log');
    assert.equal(fs.readFileSync(await download.path(), 'utf8'), '跨日完整合成日志\n');
    assert.deepEqual(errors, [], errors.join('\n'));
  } finally {
    await context.close();
  }
}

async function main() {
  let browser;
  try {
    if (!BASE_URL) throw new Error('必须通过 MONITOR_BROWSER_BASE_URL 指定隔离前端地址');
    if (!EXECUTABLE) throw new Error('需要通过 MONITOR_BROWSER_EXECUTABLE 指定专用浏览器');
    const base = new URL(BASE_URL);
    if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) {
      throw new Error('MONITOR_BROWSER_BASE_URL 只允许本机隔离前端');
    }
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
    for (const mode of ['standard', 'desktop', 'portrait', 'mobile'])
      await runViewport(browser, mode);
    logger.info('完整日志日期范围浏览器合成验收通过', { outputDir: OUTPUT_DIR });
  } catch (error) {
    logger.error('完整日志日期范围浏览器合成验收失败', {
      message: error.message,
      stack: error.stack,
    });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

main();
