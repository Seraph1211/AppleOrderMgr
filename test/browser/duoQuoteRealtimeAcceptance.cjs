/* global document, window, localStorage */
/* eslint-disable no-magic-numbers -- 实时事件、金额和计时边界均为独立合成场景。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ORIGIN = process.env.DUO_BROWSER_URL || 'http://127.0.0.1:5173';
const OUTPUT = process.env.DUO_REALTIME_OUTPUT || '/tmp/apple-duo-realtime-acceptance';
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(ORIGIN), '仅允许本地候选制品');

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 400 } });
    await context.addInitScript(() => {
      localStorage.setItem('token', 'synthetic-token-must-not-be-sent');
      window.__duoSources = [];
      window.EventSource = class extends window.EventTarget {
        static get CONNECTING() {
          return 0;
        }
        static get OPEN() {
          return 1;
        }
        static get CLOSED() {
          return 2;
        }
        constructor(url, options) {
          super();
          if (window.__duoThrowConstructs > 0) {
            window.__duoThrowConstructs--;
            throw new Error('synthetic constructor failure');
          }
          this.url = String(url);
          this.options = options;
          this.readyState = 0;
          this.closeCount = 0;
          window.__duoSources.push(this);
        }
        send(type, value) {
          if (this.readyState === 2) return;
          let event = new window.Event(type);
          if (type === 'quote-version')
            event = new window.MessageEvent(type, {
              data: JSON.stringify(value),
              lastEventId: String(value.version),
            });
          this.readyState = type === 'error' ? 0 : 1;
          this.dispatchEvent(event);
          this[`on${type}`]?.(event);
        }
        close() {
          this.readyState = 2;
          this.closeCount++;
        }
        failClosed() {
          this.readyState = 2;
          const event = new window.Event('error');
          this.dispatchEvent(event);
          this.onerror?.(event);
        }
      };
    });
    const page = await context.newPage();
    await page.clock.install();
    page.setDefaultTimeout(10000);
    let calls = 0;
    let requestCap = Infinity;
    let active = 0;
    let maximumActive = 0;
    let holdNext = false;
    let release;
    let expectedAbort = false;
    let aborted = 0;
    const errors = [];
    const unexpected = [];
    const waiters = [];
    const data = {
      enabled: true,
      version: 0,
      stale: false,
      updatedAt: '2026-10-25T10:00:00.000Z',
      lastCheckedAt: '2026-10-25T10:01:00.000Z',
      // 故意白色在前，客户端仍须按夜空→星光排序。
      items: [256, 512, 1024, 2048].flatMap((storageGb, index) =>
        ['星光白色', '夜空色'].map((color, colorIndex) => ({
          productKey: `${storageGb}-${colorIndex}`,
          productModel: 'Duo',
          storageGb,
          color,
          retailPrice: 16000 + index * 1000 + colorIndex * 100,
          officialPrice: 15999 + index * 1000,
          premiumAmount: 100,
        }))
      ),
    };
    const waitCalls = number =>
      new Promise((resolve, reject) => {
        if (calls >= number) return resolve();
        const timeout = setTimeout(() => reject(new Error(`未观察到第${number}次公开GET`)), 5000);
        timeout.unref();
        waiters.push(() => {
          if (calls < number) return false;
          clearTimeout(timeout);
          resolve();
          return true;
        });
      });
    const handle = async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== ORIGIN) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      assert.equal(request.method(), 'GET');
      assert.equal(request.headers().authorization, undefined);
      if (url.pathname === '/api/public/apple-quotes')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              enabled: true,
              items: [],
              filters: { productModels: [], storageGb: [], colors: [] },
            },
          }),
        });
      if (url.pathname !== '/api/public/duo-quotes') {
        unexpected.push(url.pathname);
        return route.abort();
      }
      calls++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      const snapshot = JSON.stringify({ success: true, data });
      const shouldHold = holdNext;
      holdNext = false;
      let gate;
      if (shouldHold)
        gate = new Promise(resolve => {
          release = resolve;
        });
      for (let index = waiters.length - 1; index >= 0; index--)
        if (waiters[index]()) waiters.splice(index, 1);
      try {
        if (gate) await gate;
        await route.fulfill({
          status: calls > requestCap ? 503 : 200,
          contentType: 'application/json',
          body:
            calls > requestCap
              ? JSON.stringify({ success: false, error: { message: '合成请求保护上限' } })
              : snapshot,
        });
      } catch (error) {
        if (!expectedAbort) unexpected.push(error.message);
      } finally {
        active--;
      }
    };
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => {
      if (new URL(request.url()).pathname === '/api/public/duo-quotes') aborted++;
    });
    await page.route('**/*', handle);
    const emit = value =>
      page.evaluate(
        version => window.__duoSources.at(-1).send('quote-version', { version }),
        value
      );
    const signal = type => page.evaluate(value => window.__duoSources.at(-1).send(value), type);
    const price = value =>
      page
        .locator('.duo-retail')
        .filter({ hasText: `¥${new Intl.NumberFormat('zh-CN').format(value)}` })
        .first()
        .waitFor();
    await page.goto(`${ORIGIN}/quote/duo`);
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 8);
    assert.equal(
      await page.evaluate(
        () => window.__duoSources.filter(source => source.readyState !== 2).length
      ),
      1
    );
    assert.ok(
      (await page.evaluate(() => window.__duoSources.at(-1).url)).endsWith(
        '/public/duo-quotes/events'
      )
    );
    const initialCalls = calls;
    maximumActive = active;
    await signal('open');
    await emit(0);
    await page.waitForTimeout(50);
    assert.equal(calls, initialCalls, '首次同版本握手不能重复GET');
    const capacities = page.getByRole('group', { name: '容量', exact: true });
    const colors = page.getByRole('group', { name: '颜色', exact: true });
    for (const label of ['256G', '512G'])
      await capacities.getByRole('button', { name: label, exact: true }).click();
    for (const label of ['夜空色', '星光白色'])
      await colors.getByRole('button', { name: label, exact: true }).click();
    assert.deepEqual(await page.locator('tbody tr td:nth-child(2)').allTextContents(), [
      '夜空色',
      '星光白色',
      '夜空色',
      '星光白色',
    ]);
    await page.evaluate(() => {
      window.__duoPageMarker = 'no-reload';
      window.scrollTo({ top: 180, behavior: 'instant' });
      window.__duoPainted = [];
      new window.MutationObserver(() =>
        window.__duoPainted.push(document.querySelector('tbody')?.innerText || '')
      ).observe(document.querySelector('tbody'), {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    const scroll = await page.evaluate(() => window.scrollY);
    assert.ok(scroll > 0, '必须在实际滚动位置验证通知不跳动');
    data.version = 1;
    data.items[1].retailPrice = 17777;
    holdNext = true;
    await emit(1);
    await waitCalls(initialCalls + 1);
    data.version = 3;
    data.items[1].retailPrice = 19003;
    data.updatedAt = '2026-10-25T10:02:00.000Z';
    await emit(2);
    await emit(3);
    release();
    await waitCalls(initialCalls + 2);
    await price(19003);
    assert.equal(calls, initialCalls + 2, 'pending多次通知应只补一轮GET');
    assert.equal(maximumActive, 1, '同页只允许一个公开GET在途');
    assert.equal(
      await page.evaluate(() => window.__duoPainted.some(text => text.includes('¥17,777'))),
      false,
      '失效旧响应不能短暂覆盖页面'
    );
    assert.equal(await page.evaluate(() => window.__duoPageMarker), 'no-reload');
    assert.equal(await page.evaluate(() => window.scrollY), scroll);
    assert.equal(await page.locator('time').getAttribute('datetime'), data.updatedAt);
    for (const label of ['256G', '512G'])
      assert.equal(
        await capacities
          .getByRole('button', { name: label, exact: true })
          .getAttribute('aria-pressed'),
        'true'
      );
    for (const label of ['夜空色', '星光白色'])
      assert.equal(
        await colors.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'),
        'true'
      );
    await emit(3);
    await emit(2);
    await page.waitForTimeout(50);
    assert.equal(calls, initialCalls + 2, '重复/旧版本不能无谓重新GET');
    data.items[1].retailPrice = 20003;
    await signal('error');
    await signal('open');
    await emit(3);
    await waitCalls(initialCalls + 3);
    await price(20003);
    assert.equal(calls, initialCalls + 3, '重连即使version相同也应核对来源，但不重复GET');
    data.items[1].retailPrice = 21003;
    await signal('error');
    await page.clock.fastForward(60000);
    await waitCalls(initialCalls + 4);
    await price(21003);
    data.items[1].retailPrice = 22003;
    await page.evaluate(() => document.dispatchEvent(new window.Event('visibilitychange')));
    await waitCalls(initialCalls + 5);
    await price(22003);
    data.items[1].retailPrice = 23003;
    await page.evaluate(() =>
      window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }))
    );
    await waitCalls(initialCalls + 6);
    await price(23003);
    await page.screenshot({ path: path.join(OUTPUT, 'pending-reconnect-375.png'), fullPage: true });
    const abortedBeforeUnmount = aborted;
    holdNext = true;
    expectedAbort = true;
    data.version = 4;
    await emit(4);
    await waitCalls(initialCalls + 7);
    await page.evaluate(() => {
      window.history.pushState({}, '', '/quote/apple');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    await page.getByRole('heading', { name: 'Apple 实时报价' }).waitFor();
    release();
    assert.equal(
      await page.evaluate(() => window.__duoSources.at(-1).closeCount),
      1,
      '卸载必须关闭SSE'
    );
    await emit(99);
    await page.evaluate(() => {
      document.dispatchEvent(new window.Event('visibilitychange'));
      window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.clock.fastForward(60000);
    await page.waitForTimeout(50);
    assert.equal(calls, initialCalls + 7, '卸载后timer/event/foreground监听必须清理');
    assert.ok(aborted > abortedBeforeUnmount, '卸载必须取消在途GET');
    // 初次GET尚未返回便收到较新hello，必须在首次响应版本不足时追赶。
    const initialRaceCalls = calls;
    expectedAbort = false;
    holdNext = true;
    data.version = 0;
    data.items[1].retailPrice = 23999;
    await page.evaluate(() => {
      window.history.pushState({}, '', '/quote/duo');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    await waitCalls(initialRaceCalls + 1);
    await signal('open');
    await emit(1);
    data.version = 1;
    data.items[1].retailPrice = 24001;
    release();
    await waitCalls(initialRaceCalls + 2);
    await price(24001);
    assert.equal(calls, initialRaceCalls + 2, '初次GET低于握手version时应补读且不丢通知');

    // 服务器持续返回落后版本时，以外部请求速率验证有界退避，不依赖内部timer实现。
    const staleStart = calls;
    requestCap = staleStart + 20;
    await emit(5);
    await waitCalls(staleStart + 1);
    for (let second = 0; second < 10; second++) {
      await page.clock.fastForward(1000);
      await page.waitForTimeout(25);
    }
    assert.ok(
      calls - staleStart >= 2 && calls - staleStart <= 12,
      `连续旧响应10秒内请求应有界，实际${calls - staleStart}`
    );
    const beforeHigherTarget = calls;
    await emit(7);
    await page.waitForTimeout(50);
    assert.equal(calls, beforeHigherTarget, '退避期间新目标不能绕过限频');
    data.version = 7;
    data.items[1].retailPrice = 27007;
    data.updatedAt = '2026-10-25T10:03:00.000Z';
    let caughtUp = false;
    for (let second = 0; second < 31; second++) {
      await page.clock.fastForward(1000);
      await page.waitForTimeout(25);
      caughtUp = (await page.locator('tbody').innerText()).includes('¥27,007');
      if (caughtUp) break;
    }
    assert.equal(caughtUp, true, '退避仍应保留最高目标并最终追上');
    assert.equal(await page.locator('time').getAttribute('datetime'), data.updatedAt);
    requestCap = Infinity;
    await emit(9);
    await page.waitForTimeout(80);
    await page.evaluate(() => {
      window.history.pushState({}, '', '/quote/apple');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    await page.getByRole('heading', { name: 'Apple 实时报价' }).waitFor();
    const afterRetryUnmount = calls;
    await page.clock.fastForward(45000);
    await page.waitForTimeout(50);
    assert.equal(calls, afterRetryUnmount, '卸载必须清理退避重试timer');
    // 原生CONNECTING仅使用浏览器重连；CLOSED和构造异常才受控重建。
    await page.evaluate(() => {
      window.history.pushState({}, '', '/quote/duo');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 8);
    await signal('open');
    await emit(7);
    const beforeConnecting = await page.evaluate(() => window.__duoSources.length);
    await signal('error');
    await page.clock.fastForward(4000);
    assert.equal(
      await page.evaluate(() => window.__duoSources.length),
      beforeConnecting,
      'CONNECTING错误不能另建第二条流'
    );
    const failClosed = () => page.evaluate(() => window.__duoSources.at(-1).failClosed());
    await failClosed();
    await page.clock.fastForward(500);
    assert.equal(await page.evaluate(() => window.__duoSources.length), beforeConnecting);
    await page.clock.fastForward(1000);
    assert.equal(await page.evaluate(() => window.__duoSources.length), beforeConnecting + 1);
    await failClosed();
    await page.clock.fastForward(1000);
    assert.equal(
      await page.evaluate(() => window.__duoSources.length),
      beforeConnecting + 1,
      '连续CLOSED应指数退避'
    );
    await page.clock.fastForward(1500);
    assert.equal(await page.evaluate(() => window.__duoSources.length), beforeConnecting + 2);
    data.items[1].retailPrice = 28007;
    await signal('open');
    await emit(7);
    await price(28007);
    await failClosed();
    await page.clock.fastForward(1500);
    assert.equal(
      await page.evaluate(() => window.__duoSources.length),
      beforeConnecting + 3,
      '成功open后应重置重连退避'
    );
    assert.equal(
      await page.evaluate(
        () => window.__duoSources.filter(source => source.readyState !== 2).length
      ),
      1
    );
    await failClosed();
    await page.evaluate(() => {
      window.history.pushState({}, '', '/quote/apple');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    await page.getByRole('heading', { name: 'Apple 实时报价' }).waitFor();
    const closedUnmountCount = await page.evaluate(() => window.__duoSources.length);
    await page.clock.fastForward(45000);
    assert.equal(
      await page.evaluate(() => window.__duoSources.length),
      closedUnmountCount,
      '卸载必须清理SSE重建timer'
    );
    await page.evaluate(() => {
      window.__duoThrowConstructs = 1;
      window.history.pushState({}, '', '/quote/duo');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 8);
    assert.equal(await page.evaluate(() => window.__duoSources.length), closedUnmountCount);
    await page.clock.fastForward(1500);
    assert.equal(
      await page.evaluate(() => window.__duoSources.length),
      closedUnmountCount + 1,
      '构造异常必须受控重试'
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    fs.writeFileSync(
      path.join(OUTPUT, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          calls,
          maximumActive,
          staleResponseSuppressed: true,
          latestBurstPreserved: true,
          reconnectSameVersionRefresh: true,
          pollingFallback: true,
          foregroundRefresh: true,
          unmountClosedAndAborted: true,
          initialHandshakeRace: true,
          boundedStaleVersionRequests: true,
          retainedMaximumTarget: true,
          retryTimerCleanedOnUnmount: true,
          closedReconnectRecovered: true,
          nativeConnectingSingleStream: true,
          constructorRetryControlled: true,
          sseReconnectTimerCleanedOnUnmount: true,
          filtersAndScrollPreserved: true,
          colorOrder: ['夜空色', '星光白色'],
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
fs.mkdirSync(OUTPUT, { recursive: true });
main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
