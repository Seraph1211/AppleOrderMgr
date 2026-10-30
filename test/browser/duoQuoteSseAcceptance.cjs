/* global document, window, localStorage */
/* eslint-disable no-magic-numbers -- 独立隔离API、版本、金额与延迟验收边界。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const API_A = process.env.DUO_SSE_API_A || 'http://127.0.0.1:5201';
const API_B = process.env.DUO_SSE_API_B || 'http://127.0.0.1:5202';
const DIST =
  process.env.DUO_SSE_FRONTEND_DIST || '/tmp/apple-duo-live-20261025/frontend-release/frontend';
const OUTPUT = process.env.DUO_SSE_OUTPUT || '/tmp/apple-duo-native-sse-acceptance';
const DATABASE = 'apple_order_mgr_duo_live_qa_20261025';
const PG_CONTAINER = 'apple-order-mgr-dev-postgres-1';
for (const url of [API_A, API_B])
  assert.ok(/^http:\/\/127\.0\.0\.1:520[12]$/.test(url), '禁止连接生产或任意业务API');

async function api(endpoint, method = 'GET', body) {
  const response = await fetch(`${API_A}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const stateDigest = value =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        version: value.version,
        adjustments: value.adjustments,
        history: value.history,
      })
    )
    .digest('hex');

async function proxy(apiOrigin, firstStream503) {
  const streams = new Set();
  let injected = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (firstStream503 && !injected && url.pathname === '/api/public/duo-quotes/events') {
        injected = true;
        response.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end('{"success":false,"error":{"code":"QA_INITIAL_UNAVAILABLE"}}');
        return;
      }
      const upstream = http.request(
        new URL(request.url, apiOrigin),
        { method: request.method, headers: { ...request.headers, host: new URL(apiOrigin).host } },
        result => {
          response.writeHead(result.statusCode, result.headers);
          if (url.pathname.endsWith('/events')) streams.add(response);
          result.pipe(response);
        }
      );
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      response.on('close', () => {
        streams.delete(response);
        upstream.destroy();
      });
      request.pipe(upstream);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = path.resolve(DIST, relative || 'index.html');
    if (!file.startsWith(`${path.resolve(DIST)}/`) && file !== path.resolve(DIST)) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(DIST, 'index.html');
    const type =
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.xlsx': 'application/octet-stream',
      }[path.extname(file)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, streams, origin: `http://127.0.0.1:${server.address().port}` };
}

async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('实时验收等待超时');
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  assert.ok(fs.existsSync(path.join(DIST, 'index.html')));
  const frontA = await proxy(API_A, true);
  const frontB = await proxy(API_B, false);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  let probe;
  try {
    await api('/__qa/failure', 'POST', { audit: false, source: false, notify: false });
    const devices = [];
    const errors = [];
    for (const [index, front] of [frontA, frontB].entries()) {
      const context = await browser.newContext({
        viewport: index ? { width: 1440, height: 900 } : { width: 375, height: 400 },
        serviceWorkers: 'block',
      });
      await context.addInitScript(value => {
        localStorage.setItem('qa-isolation', value);
        localStorage.setItem('token', 'must-not-be-sent');
      }, `device-${index}`);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      const frames = [];
      const streamResponses = [];
      cdp.on('Network.eventSourceMessageReceived', event => {
        try {
          const payload = JSON.parse(event.data);
          frames.push({
            name: event.eventName,
            id: event.eventId,
            keys: Object.keys(payload),
            version: payload.version,
            at: Date.now(),
          });
        } catch (_error) {
          errors.push('INVALID_STREAM_JSON');
        }
      });
      page.on('response', response => {
        if (new URL(response.url()).pathname.endsWith('/duo-quotes/events'))
          streamResponses.push({
            status: response.status(),
            type: response.headers()['content-type'],
            buffer: response.headers()['x-accel-buffering'],
          });
      });
      page.on('request', request => {
        if (
          new URL(request.url()).pathname.startsWith('/api/public/') &&
          request.headers().authorization
        )
          errors.push('PUBLIC_AUTHORIZATION_LEAK');
      });
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${front.origin}/quote/duo`);
      await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 8);
      await until(() => frames.length > 0, 6000);
      assert.deepEqual(
        await page
          .getByRole('group', { name: '颜色', exact: true })
          .getByRole('button')
          .allTextContents(),
        ['全部', '夜空色', '星光白色']
      );
      const capacities = page.getByRole('group', { name: '容量', exact: true });
      const colors = page.getByRole('group', { name: '颜色', exact: true });
      for (const capacity of index ? ['512G', '1TB'] : ['256G', '512G'])
        await capacities.getByRole('button', { name: capacity, exact: true }).click();
      for (const color of index ? ['夜空色'] : ['夜空色', '星光白色'])
        await colors.getByRole('button', { name: color, exact: true }).click();
      await page.evaluate(() => {
        window.__qaNoReload = true;
        window.scrollTo({ top: 150, behavior: 'instant' });
      });
      const filters = await page
        .locator('.duo-filter-option')
        .evaluateAll(elements =>
          elements.map(element => [element.textContent, element.getAttribute('aria-pressed')])
        );
      const scroll = await page.evaluate(() => window.scrollY);
      if (!index) assert.ok(scroll > 0);
      devices.push({ context, page, frames, streamResponses, filters, scroll });
    }
    assert.deepEqual(
      devices[0].streamResponses.map(item => item.status),
      [503, 200],
      '原生EventSource首次503后应重建恢复200'
    );
    assert.equal(
      await devices[0].page.evaluate(() => localStorage.getItem('qa-isolation')),
      'device-0'
    );
    assert.equal(
      await devices[1].page.evaluate(() => localStorage.getItem('qa-isolation')),
      'device-1'
    );
    const save = async amount => {
      const current = (await api('/api/quote-pricing/duo')).body.data;
      const result = await api('/api/quote-pricing/duo/adjustments', 'PUT', {
        productKeys: current.items.map(item => item.productKey),
        mode: 'markup',
        amount,
        expectedVersion: current.version,
        expectedSourceVersion: current.sourceVersion,
      });
      return result;
    };
    const verifyScreens = async (version, started, timeout) => {
      const quote = (await api('/api/public/duo-quotes')).body.data;
      assert.deepEqual(
        Object.keys(quote).sort(),
        ['enabled', 'version', 'updatedAt', 'lastCheckedAt', 'stale', 'items'].sort()
      );
      for (const item of quote.items)
        assert.deepEqual(
          Object.keys(item).sort(),
          [
            'productKey',
            'productName',
            'productModel',
            'storageGb',
            'color',
            'retailPrice',
            'officialPrice',
            'premiumAmount',
          ].sort()
        );
      assert.equal(quote.version, version);
      const latencies = await Promise.all(
        devices.map(async (device, index) => {
          const expected = quote.items
            .filter(
              item =>
                (index ? [512, 1024] : [256, 512]).includes(item.storageGb) &&
                (!index || item.color === '夜空色')
            )
            .map(item => `¥${new Intl.NumberFormat('zh-CN').format(item.retailPrice)}`);
          await until(async () => {
            const actual = await device.page.locator('.duo-retail').allTextContents();
            return (
              JSON.stringify(actual) === JSON.stringify(expected) &&
              (await device.page.locator('time').getAttribute('datetime')) === quote.updatedAt
            );
          }, timeout);
          assert.equal(await device.page.evaluate(() => window.__qaNoReload), true);
          assert.equal(await device.page.evaluate(() => window.scrollY), device.scroll);
          assert.deepEqual(
            await device.page
              .locator('.duo-filter-option')
              .evaluateAll(elements =>
                elements.map(element => [element.textContent, element.getAttribute('aria-pressed')])
              ),
            device.filters
          );
          return Date.now() - started;
        })
      );
      return latencies;
    };
    const initialVersion = (await api('/__qa/state')).body.version;
    const baseAmount = 100 + initialVersion * 100;
    const firstStart = Date.now();
    const saved = await save(baseAmount + 25);
    assert.equal(saved.status, 200);
    const commitLatencies = await verifyScreens(initialVersion + 1, firstStart, 2000);
    assert.ok(
      commitLatencies.every(value => value < 2000),
      `正常提交更新应小于2秒: ${commitLatencies}`
    );
    const rollbackResults = [];
    for (const flag of ['audit', 'source', 'notify']) {
      const before = (await api('/__qa/state')).body;
      const beforeFrames = devices.map(device => device.frames.length);
      const current = (await api('/api/quote-pricing/duo')).body.data;
      await api('/__qa/failure', 'POST', {
        audit: false,
        source: false,
        notify: false,
        [flag]: true,
      });
      const failed = await api('/api/quote-pricing/duo/adjustments', 'PUT', {
        productKeys: current.items.map(item => item.productKey),
        mode: 'markup',
        amount: 999,
        expectedVersion: current.version,
        expectedSourceVersion: current.sourceVersion,
      });
      assert.equal(failed.status, flag === 'source' ? 409 : 500);
      await api('/__qa/failure', 'POST', { audit: false, source: false, notify: false });
      await new Promise(resolve => setTimeout(resolve, 350));
      const after = (await api('/__qa/state')).body;
      assert.equal(stateDigest(before), stateDigest(after), '真实rollback必须保全三报价表');
      assert.deepEqual(
        devices.map(device => device.frames.length),
        beforeFrames,
        'rollback不得推送调价事件'
      );
      rollbackResults.push(flag);
    }
    probe = new AbortController();
    const sharedProbe = await fetch(`${API_B}/api/public/duo-quotes/events`, {
      signal: probe.signal,
    });
    assert.equal(sharedProbe.status, 200);
    const listenerWhere = "datname=current_database() AND query='LISTEN duo_quote_pricing_changed'";
    const query = `SELECT count(*) FROM pg_stat_activity WHERE ${listenerWhere}`;
    const psql = sql =>
      execFileSync(
        'docker',
        [
          'exec',
          '-u',
          'postgres',
          PG_CONTAINER,
          'sh',
          '-c',
          'exec psql -X -qAt -U "$POSTGRES_USER" -d "$1" -c "$2"',
          'qa-duo-sse',
          DATABASE,
          sql,
        ],
        { encoding: 'utf8' }
      ).trim();
    assert.equal(Number(psql(query)), 2, '双API各共享一个PG LISTEN连接，不按浏览器增加');
    const requestCounts = devices.map(device => device.streamResponses.length);
    const killed = psql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE ${listenerWhere}`
    )
      .split('\n')
      .filter(item => item === 't').length;
    assert.equal(killed, 2);
    const listenerStart = Date.now();
    const afterDisconnect = await save(baseAmount + 125);
    assert.equal(afterDisconnect.status, 200);
    const listenerLatencies = await verifyScreens(initialVersion + 2, listenerStart, 5000);
    assert.deepEqual(
      devices.map(device => device.streamResponses.length),
      requestCounts,
      'PG重连应在原HTTP流上校准，不依赖浏览器重连'
    );
    for (const stream of [...frontB.streams]) stream.destroy();
    const browserReconnectStart = Date.now();
    const duringStreamGap = await save(baseAmount + 225);
    assert.equal(duringStreamGap.status, 200);
    const streamReconnectLatencies = await verifyScreens(
      initialVersion + 3,
      browserReconnectStart,
      7000
    );
    assert.ok(devices[1].streamResponses.length > requestCounts[1]);
    for (const [index, device] of devices.entries()) {
      for (const frame of device.frames) {
        assert.equal(frame.name, 'quote-version');
        assert.deepEqual(frame.keys, ['version']);
        assert.ok(Number.isSafeInteger(frame.version));
        assert.equal(frame.id, String(frame.version));
      }
      const successful = device.streamResponses.filter(item => item.status === 200);
      assert.ok(
        successful.every(item => item.type.startsWith('text/event-stream') && item.buffer === 'no')
      );
      await device.page.screenshot({
        path: path.join(OUTPUT, `native-device-${index}.png`),
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(OUTPUT, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          nativeEventSource: true,
          independentStorageContexts: true,
          crossInstancePgNotify: true,
          nativeInitial503RecoveryAtQaProxy: true,
          commitLatenciesMs: commitLatencies,
          rollbackResults,
          sharedPgListeners: 2,
          pgListenerReconnectLatenciesMs: listenerLatencies,
          nativeStreamReconnectLatenciesMs: streamReconnectLatencies,
          filtersScrollAndDocumentPreserved: true,
          streamPayloadWhitelist: true,
          apiCandidate: process.env.DUO_SSE_API_IMAGE || null,
          frontendArtifact: process.env.DUO_SSE_ARTIFACT_SHA256 || null,
          frameVersions: devices.map(device => device.frames.map(frame => frame.version)),
          errors,
        },
        null,
        2
      )
    );
  } finally {
    probe?.abort();
    await browser.close();
    for (const front of [frontA, frontB]) {
      for (const stream of front.streams) stream.destroy();
      await new Promise(resolve => front.server.close(resolve));
    }
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
