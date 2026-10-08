/* global document, location, window */
/* eslint-disable no-magic-numbers -- 完全隔离的本地 TLS 合成服务器。 */
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const assert = require('assert/strict');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const Cdp = require('../src/services/officialOrderCdp');
const { OfficialReceiptCollector } = require('../src/services/officialReceiptCollector');
const { captureOfficialReceipt } = require('../src/services/officialReceiptCapture');
const { hash, encrypt, delay } = require('../src/services/officialOrderSupport');

const HOST = 'secure6.www.apple.com.cn';
const DETAIL = `https://${HOST}/shop/order/detail/test/W1234567890`;
const receiptModel = {
  orderInvoices: {
    c: ['orderInvoice-1'],
    'orderInvoice-1': {
      invoiceOrderSummary: { d: { orderNumber: 'W1234567890' } },
      invoiceLineItems: {
        c: ['invoiceLineItem-1'],
        'invoiceLineItem-1': {
          d: {
            quantityShipped: 1,
            quantityOrdered: 1,
            hasLineItemSerialInfo: true,
            lineItemSerialInfo: ['TESTSN0001'],
            partNumber: 'TEST/A',
            productName: 'TEST PHONE',
          },
        },
      },
    },
  },
};

/** 仅在无外网容器运行；真实 Chromium、CDP 与本地 TLS 服务验证拦截先后顺序。 */
async function main() {
  const root = fs.mkdtempSync(`${os.tmpdir()}/receipt-browser-`);
  let server;
  let child;
  let browser;
  let cdp;
  const observations = [];
  const events = [];
  let collector;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${root}/key.pem`,
        '-out',
        `${root}/cert.pem`,
        '-days',
        '1',
        '-subj',
        `/CN=${HOST}`,
      ],
      { stdio: 'ignore' }
    );
    server = https.createServer(
      { key: fs.readFileSync(`${root}/key.pem`), cert: fs.readFileSync(`${root}/cert.pem`) },
      (req, res) => {
        observations.push({ path: req.url, permits: collector?.receiptPhase?.permits.length || 0 });
        if (req.url.endsWith('/redirect')) {
          res.writeHead(303, { Location: '/shop/order/sorry' });
          res.end();
          return;
        }
        const body = req.url.includes('/print/invoice/')
          ? `<html><script id="init_data" type="application/json">${JSON.stringify(receiptModel)}</script><img src="/blocked-image"></html>`
          : '<html>synthetic detail</html>';
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(body);
      }
    );
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(443, '0.0.0.0', resolve);
    });
    child = spawn(
      OfficialReceiptCollector.prototype.browserExecutable.call({ browserMode: 'headless-shell' }),
      [
        '--no-sandbox',
        '--headless=new',
        '--disable-background-networking',
        '--disable-extensions',
        '--ignore-certificate-errors',
        `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
        '--no-proxy-server',
        '--remote-debugging-port=9223',
        `--user-data-dir=${root}/profile`,
        'about:blank',
      ],
      { stdio: 'ignore' }
    );
    let endpoint;
    for (let i = 0; i < 100 && !endpoint; i += 1) {
      try {
        endpoint = (await (await fetch('http://127.0.0.1:9223/json/version')).json())
          .webSocketDebuggerUrl;
      } catch (_error) {
        await delay(100);
      }
    }
    assert(endpoint, 'browser must start');
    cdp = new Cdp();
    await cdp.open(endpoint);
    collector = Object.assign(Object.create(OfficialReceiptCollector.prototype), {
      root,
      id: 1,
      key: crypto.randomBytes(32),
      directory: `${root}/evidence/run-1`,
      sample: { id: 1, orderNumber: 'W1234567890' },
      result: { completeItemCount: 1, products: [{ quantity: 1, rawStatus: 'PICKED_UP' }] },
      requests: new Map(),
      inFlightHosts: new Map(),
      sessions: new Set(),
      pending: new Set(),
      readyTargets: new Set(),
      authChallenges: new Set(),
      documentLoaders: new Map(),
      bodyCount: 0,
      captureReceipt: true,
      browserMode: 'headless-shell',
      leaseContext: {
        provider: 'iproyal',
        startedAt: new Date().toISOString(),
        egressHash: 'a'.repeat(64),
      },
      cdp,
      isStopRequested: () => false,
      stopped: null,
      log: (message, data = {}) => events.push({ message, ...data }),
      gate: {
        requests: 0,
        permit: async value => {
          try {
            if (collector.deny)
              throw Object.assign(new Error('REQUEST_BUDGET'), { code: 'REQUEST_BUDGET' });
            collector.gate.requests += 1;
            await delay(20);
            return { index: collector.gate.requests, urlHash: hash(value) };
          } catch (error) {
            error.component = 'syntheticGate';
            throw error;
          }
        },
      },
    });
    fs.mkdirSync(collector.directory, { recursive: true });
    cdp.on('event', item => collector.track(collector.event(item)));
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    browser = await chromium.connectOverCDP(endpoint);
    collector.context = browser.contexts()[0];
    collector.page = collector.context.pages()[0];
    collector.pageControl = await collector.context.newCDPSession(collector.page);
    const { targetInfo } = await collector.pageControl.send('Target.getTargetInfo');
    while (!collector.readyTargets.has(targetInfo.targetId)) await delay(20);
    await collector.installTargetGuard();
    await collector.page.goto(DETAIL);
    await Promise.allSettled([...collector.pending]);
    for (const mode of ['ok', 'delayed', 'popup', 'foreign-popup', 'redirect', 'budget']) {
      collector.stopped = null;
      collector.deny = false;
      if (collector.page.url() !== DETAIL) await collector.page.goto(DETAIL);
      await collector.page.evaluate(() => {
        document.body.innerHTML = '<a target="_blank">查看电子收据</a>';
      });
      collector.stopped = 'SUCCEEDED';
      collector.deny = mode === 'budget';
      const url = `https://${HOST}/shop/order/print/invoice/test/${mode}`;
      await collector.page
        .locator('a')
        .evaluate((element, href) => element.setAttribute('href', href), url);
      if (mode === 'delayed')
        await collector.page.locator('a').evaluate(element => {
          element.onclick = event => {
            event.preventDefault();
            setTimeout(() => {
              location.href = element.href;
            }, 200);
          };
        });
      const body = JSON.stringify({
        orderDetail: {
          orderHeader: { d: { orderNumber: collector.sample.orderNumber, invoiceUrl: url } },
        },
      });
      fs.writeFileSync(
        `${collector.directory}/detail.enc`,
        encrypt(Buffer.from(body), collector.key)
      );
      if (mode === 'popup')
        await collector.page.evaluate(() => {
          document.querySelector('a').onclick = event => {
            event.preventDefault();
            window.open(document.querySelector('a').href, '_blank');
          };
        });
      if (mode === 'foreign-popup')
        await collector.page.evaluate(() => {
          document.querySelector('a').onclick = event => {
            event.preventDefault();
            window.open('/shop/order/sorry', '_blank');
          };
        });
      collector.resultEvidence = {
        file: 'detail.enc',
        sha256: hash(body),
        host: HOST,
        urlHash: hash(DETAIL),
      };
      const result = await captureOfficialReceipt(collector);
      if (mode === 'foreign-popup') {
        assert(
          ['RECEIPT_UNCONTROLLED_TARGET', 'RECEIPT_SESSION_REDIRECT', 'RECEIPT_TIMEOUT'].includes(
            result.outcome
          )
        );
        for (const other of collector.context.pages()) {
          if (other !== collector.page) await other.close().catch(() => {});
        }
      } else {
        assert.equal(
          result.outcome,
          {
            ok: 'RECEIPT_VERIFIED',
            delayed: 'RECEIPT_VERIFIED',
            popup: 'RECEIPT_VERIFIED',
            redirect: 'RECEIPT_SESSION_REDIRECT',
            budget: 'REQUEST_BUDGET',
          }[mode]
        );
      }
    }
    const receipts = observations.filter(item => item.path.includes('/print/invoice/'));
    assert.equal(receipts.length, 4);
    assert(
      receipts.every(item => item.permits === 1),
      'first outgoing request must have exactly one prior permit'
    );
    assert(!observations.some(item => /sorry|blocked-image|budget/.test(item.path)));
    assert.equal(events.filter(item => item.message === 'receipt_permit').length, 4);
    process.stdout.write(
      JSON.stringify({
        outcome: 'PASSED',
        cases: [
          'native-first-request-metered',
          'delayed-navigation-awaited',
          'script-popup-stays-controlled',
          'uncontrolled-popup-cannot-send',
          'redirect-blocked',
          'resource-blocked',
          'budget-stops-before-network',
        ],
        observedReceiptRequests: receipts.length,
        receiptPermits: events.filter(item => item.message === 'receipt_permit').length,
        externalNetwork: false,
      }) + '\n'
    );
  } catch (error) {
    process.stderr.write(JSON.stringify({ outcome: 'FAILED', error: error.message }) + '\n');
    process.exitCode = 1;
  } finally {
    if (collector) collector.closing = true;
    if (browser) await browser.close().catch(() => {});
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (cdp) cdp.close();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.exitCode = 1;
});
