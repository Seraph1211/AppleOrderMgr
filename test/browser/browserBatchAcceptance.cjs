// 专用无头浏览器 + 本机 HTTPS/SOCKS5 合成验收，代理只允许转发至本机 Fixture。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const https = require('https');
const { execFileSync } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { validateBatchConfig } = require('../../src/services/crawler/browserBatch/batchConfig');
const { openBatchCheckpoint } = require('../../src/services/crawler/browserBatch/batchCheckpoint');
const { runBrowserBatch } = require('../../src/services/crawler/browserBatch/batchRunner');
const { collectBrowserOrder } = require('../../src/services/crawler/browserBatch/batchCollector');
const { buildLifecycleJson } = require('../fixtures/officialOrderLifecycle');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-batch-acceptance-'));
  const servers = [];
  const sockets = new Set();
  const tunnels = new Map();
  const observed = [];
  const usedProxies = new Map();
  let browser;
  let checkpoint;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' }
    );
    const web = https.createServer(
      {
        key: fs.readFileSync(path.join(dir, 'key.pem')),
        cert: fs.readFileSync(path.join(dir, 'cert.pem')),
      },
      (req, res) => {
        const number = req.url.match(/W\d{10}/)?.[0];
        if (!number) {
          res.writeHead(404);
          res.end();
          return;
        }
        const proxyIndex = tunnels.get(req.socket.remotePort);
        observed.push({ number, proxyIndex, cookie: req.headers.cookie, url: req.url });
        if (!usedProxies.has(number)) usedProxies.set(number, new Set());
        usedProxies.get(number).add(proxyIndex);
        if (req.headers.host === 'www.apple.com.cn') {
          res.writeHead(302, {
            Location: `https://secure8.www.apple.com.cn/shop/order/guest/${number}/fixture`,
            'Set-Cookie': `testOrder=${number}; Domain=.apple.com.cn; Path=/; Secure; SameSite=None`,
          });
          res.end();
        } else if (req.url.includes('_a=fetchOrder')) {
          const json = buildLifecycleJson('PROCESSING');
          json.orderDetail.orderHeader.d.orderNumber = number;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ body: json }));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            `<html><body>Loading<script>fetch('/shop/order/lookup?_a=fetchOrder&order=${number}',` +
              "{method:'POST'});</script></body></html>"
          );
        }
      }
    );
    web.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    servers.push(web);
    await listen(web);
    const proxies = [];
    for (let index = 0; index < 10; index++) {
      const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        let stage = 0;
        let pending = Buffer.alloc(0);
        const handshake = chunk => {
          pending = Buffer.concat([pending, chunk]);
          if (stage === 0) {
            if (pending.length < 2 || pending.length < 2 + pending[1]) return;
            pending = pending.subarray(2 + pending[1]);
            socket.write(Buffer.from([5, 0]));
            stage = 1;
          }
          if (stage === 1) {
            if (pending.length < 5) return;
            if (pending[0] !== 5 || pending[1] !== 1 || pending[3] !== 3) {
              socket.destroy();
              return;
            }
            const length = pending[4];
            if (pending.length < length + 7) return;
            const host = pending.subarray(5, 5 + length).toString();
            const port = pending.readUInt16BE(5 + length);
            if (!['www.apple.com.cn', 'secure8.www.apple.com.cn'].includes(host) || port !== 443) {
              socket.destroy();
              return;
            }
            stage = 2;
            const remainder = pending.subarray(length + 7);
            socket.removeListener('data', handshake);
            socket.pause();
            const upstream = net.connect(web.address().port, '127.0.0.1', () => {
              tunnels.set(upstream.localPort, index);
              socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
              if (remainder.length) upstream.write(remainder);
              socket.pipe(upstream).pipe(socket);
              socket.resume();
            });
            sockets.add(upstream);
            upstream.on('close', () => {
              sockets.delete(upstream);
              socket.destroy();
            });
            upstream.on('error', () => socket.destroy());
            socket.on('close', () => upstream.destroy());
          }
        };
        socket.on('data', handshake);
      });
      servers.push(server);
      await listen(server);
      proxies.push(`socks5://127.0.0.1:${server.address().port}`);
    }
    const config = validateBatchConfig({
      apiBaseUrl: 'http://127.0.0.1:3000',
      tokenFile: path.join(dir, 'unused-token'),
      checkpointFile: path.join(dir, 'state.json'),
      orderIds: Array.from({ length: 20 }, (_, i) => i + 1),
      proxies,
    });
    checkpoint = openBatchCheckpoint(config);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.BROWSER_BATCH_TEST_EXECUTABLE
        ? { executablePath: process.env.BROWSER_BATCH_TEST_EXECUTABLE }
        : { channel: 'chrome' }),
      proxy: { server: 'per-context' },
      // 仅合成测试允许本机自签证书；产品执行器没有此参数。
      args: ['--ignore-certificate-errors', '--disable-background-networking'],
    });
    let peakContexts = 0;
    const sampler = setInterval(() => {
      peakContexts = Math.max(peakContexts, browser.contexts().length);
    }, 5);
    const permits = [];
    let nextSlot = 0;
    let submissions = 0;
    const api = {
      start(id) {
        const orderNumber = `W${String(id).padStart(10, '0')}`;
        return Promise.resolve({
          ticket: 'local-fixture',
          orderNumber,
          orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/fixture%40example.com`,
          expiresAt: new Date(Date.now() + 330000).toISOString(),
          maxRequests: 100,
          maxDurationMs: 300000,
        });
      },
      async permit(_id, _ticket, signal) {
        try {
          const slot = Math.max(nextSlot, Date.now());
          nextSlot = slot + 200;
          await delay(Math.max(0, slot - Date.now()));
          signal.throwIfAborted();
          permits.push(Date.now());
        } catch (error) {
          throw new Error(`fixture permit failed: ${error.name}`);
        }
      },
      submit(id, _ticket, page) {
        assert.equal(
          page.orderJson.orderDetail.orderHeader.d.orderNumber,
          `W${String(id).padStart(10, '0')}`
        );
        assert.ok(page.pageUrl.endsWith('/redacted'));
        submissions++;
        return Promise.resolve({ success: true, orderId: id });
      },
    };
    let summary;
    try {
      summary = await runBrowserBatch({
        config,
        checkpoint,
        api,
        collect: options => collectBrowserOrder({ browser, ...options }),
      });
    } finally {
      clearInterval(sampler);
    }
    assert.deepEqual(summary.counts, { succeeded: 20 }, JSON.stringify(checkpoint.orders));
    assert.equal(peakContexts, 10);
    assert.equal(submissions, 20);
    assert.equal(browser.contexts().length, 0);
    assert.equal(usedProxies.size, 20);
    for (const nodes of usedProxies.values()) {
      assert.equal(nodes.size, 1);
      assert.ok(!nodes.has(undefined));
    }
    const finalPages = observed.filter(row => row.url.includes('/guest/'));
    assert.equal(finalPages.length, 20);
    for (const row of finalPages) assert.equal(row.cookie, `testOrder=${row.number}`);
    const detailRequests = observed.filter(row => row.url.includes('_a=fetchOrder'));
    assert.equal(detailRequests.length, 20);
    for (const row of detailRequests) assert.equal(row.cookie, `testOrder=${row.number}`);
    assert.ok(permits.length >= 60, '初始请求、重定向与异步详情都必须取得许可');
    for (let i = 1; i < permits.length; i++) assert.ok(permits[i] - permits[i - 1] >= 150);
    process.stdout.write(
      JSON.stringify({
        success: true,
        orders: 20,
        peakContexts,
        distinctProxies: 10,
        submissions,
        permits: permits.length,
        cookieIsolation: true,
        queryDetailResponses: detailRequests.length,
        contextsAfterRun: browser.contexts().length,
      }) + '\n'
    );
  } finally {
    if (browser) await browser.close();
    checkpoint?.close();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
