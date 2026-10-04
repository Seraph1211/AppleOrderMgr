/* global navigator, screen */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const { chromium } = require('playwright-core');
const winston = require('winston');
const Cdp = require('./officialOrderCdp');
const OfficialOrderGate = require('./officialOrderGate');
const {
  parseOfficialOrderDetail: parseBody,
  parseOfficialOrderList: parseOrderList,
  isOfficialOrderResponse,
} = require('./officialOrderParser');
const {
  fault: fail,
  hash,
  delay,
  safePath,
  permittedUrl,
  detailUrl,
  readPrivate,
  validateSample,
  encrypt,
  decrypt,
  writePrivate,
  validateSession,
  isCanceledInterception,
} = require('./officialOrderSupport');

const LIMITS = Object.freeze({
  totalRequests: 1470,
  maximumPort: 65535,
  ivBytes: 12,
  hashPrefix: 16,
  bodyBytes: 8388608,
  attachTimeoutMs: 12000,
  browserPollMs: 100,
  attachPollMs: 50,
  cookieMinimumLength: 100,
  observationMs: 170000,
  siteReadyMs: 45000,
  loopPollMs: 750,
  childShutdownMs: 5000,
  jsonIndent: 2,
});
const HTTP_STATUS = Object.freeze({
  ok: 200,
  proxyAuth: 407,
  conflict: 409,
  rateLimited: 429,
  risk: 541,
});

/** 服务器单笔只读采集器；不会写入订单或邮件业务状态。 */
class OfficialOrderCollector {
  constructor({
    root,
    inputFile,
    orderId,
    proxyFile,
    resumeRun,
    totalRequestLimit = LIMITS.totalRequests,
    runRequestLimit,
  }) {
    this.root = path.resolve(root);
    const inputs = readPrivate(inputFile);
    this.sample = validateSample(inputs.samples.find(sample => sample.id === orderId));
    this.gate = new OfficialOrderGate(
      readPrivate(`${this.root}/private/db.json`),
      totalRequestLimit,
      runRequestLimit
    );
    this.key = readPrivate(`${this.root}/private/evidence.key`, false);
    this.proxy = readPrivate(proxyFile);
    if (
      !/^[a-z0-9.-]+$/i.test(this.proxy.host) ||
      !Number.isInteger(Number(this.proxy.port)) ||
      Number(this.proxy.port) < 1 ||
      Number(this.proxy.port) > LIMITS.maximumPort ||
      !this.proxy.username ||
      !this.proxy.password
    )
      throw fail('PROXY_INVALID');
    this.proxyHash = hash(`${this.proxy.host}:${this.proxy.port}:${this.proxy.username}`);
    this.resumeRun = resumeRun;
    this.sessionFile = `${this.root}/private/sessions/${this.sample.accountHash}.enc`;
    this.requests = new Map();
    this.sessions = new Set();
    this.pending = new Set();
    this.readyTargets = new Set();
    this.authChallenges = new Set();
    this.bodyCount = 0;
    this.stopped = null;
    this.passwordSubmitted = false;
    this.emailSubmitted = false;
  }
  seal(value, label) {
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const iv = crypto.randomBytes(LIMITS.ivBytes);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const file = `${label}-${hash(bytes).slice(0, LIMITS.hashPrefix)}.enc`;
    fs.writeFileSync(
      path.join(this.directory, file),
      Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
      { mode: 0o600 }
    );
    return { file, sha256: hash(bytes), bytes: bytes.length };
  }
  log(event, data = {}) {
    this.logger.info(event, { timestamp: new Date().toISOString(), ...data });
  }
  stop(code) {
    if (!this.stopped) {
      this.stopped = code;
      this.log('stopped', { code });
    }
  }
  async initialize() {
    try {
      this.id = await this.gate.open(this.sample, this.proxyHash);
      this.directory = `${this.root}/evidence/run-${this.id}`;
      fs.mkdirSync(this.directory, { mode: 0o700 });
      this.logger = winston.createLogger({
        format: winston.format.json(),
        transports: [
          new winston.transports.File({
            filename: `${this.directory}/events.jsonl`,
            options: { flags: 'a', mode: 0o600 },
          }),
        ],
      });
      this.started = Date.now();
      this.log('started', { sampleId: this.sample.id, accountHash: this.sample.accountHash });
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }
  async permit(value, type) {
    try {
      const url = permittedUrl(value);
      const permit = await this.gate.permit(value, () => !!this.stopped);
      this.log('permit', { ...permit, host: url.hostname, type });
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }
  track(promise) {
    const handled = promise.catch(error => {
      if (!this.closing) {
        this.log('handler_error', { code: error.code, method: error.method });
        this.stop(error.code || 'HANDLER_FAILED');
      }
    });
    this.pending.add(handled);
    handled.finally(() => this.pending.delete(handled));
  }
  async attach(sessionId, info) {
    try {
      this.sessions.add(sessionId);
      this.log('target', { type: info.type });
      await this.cdp.send('Network.enable', {}, sessionId);
      if (['worker', 'shared_worker'].includes(info.type)) {
        await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        this.log('worker_parent_interception', { type: info.type });
        return;
      }
      await this.cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
      await this.cdp.send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
      await this.cdp.send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: true },
        sessionId
      );
      await this.cdp.send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        sessionId
      );
      await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      this.readyTargets.add(info.targetId);
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }
  async event(item) {
    const { method, params: p, sessionId } = item;
    try {
      if (method === 'Target.detachedFromTarget') {
        this.sessions.delete(p.sessionId);
        return;
      }
      if (method === 'Target.attachedToTarget') return await this.attach(p.sessionId, p.targetInfo);
      if (!sessionId || !this.sessions.has(sessionId)) return;
      if (method === 'Fetch.authRequired') {
        const authKey = `${sessionId}:${p.requestId}`;
        const proxyAuth =
          this.proxy && p.authChallenge.source === 'Proxy' && !this.authChallenges.has(authKey);
        this.authChallenges.add(authKey);
        let authChallengeResponse = { response: 'CancelAuth' };
        if (proxyAuth) {
          authChallengeResponse = {
            response: 'ProvideCredentials',
            username: this.proxy.username,
            password: this.proxy.password,
          };
        }
        await this.cdp.send(
          'Fetch.continueWithAuth',
          {
            requestId: p.requestId,
            authChallengeResponse,
          },
          sessionId
        );
        if (!proxyAuth) this.stop('HTTP_AUTH_FAILED');
      }
      if (method === 'Fetch.requestPaused') {
        try {
          if (this.stopped || ['Media', 'WebSocket'].includes(p.resourceType))
            throw fail('REQUEST_STOPPED');
          await this.permit(p.request.url, p.resourceType);
          if (this.stopped || !this.sessions.has(sessionId)) throw fail('REQUEST_STOPPED');
          await this.cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId);
        } catch (error) {
          if (isCanceledInterception(error)) {
            this.log('navigation_request_cancelled', { type: p.resourceType });
            return;
          }
          await this.cdp
            .send(
              'Fetch.failRequest',
              { requestId: p.requestId, errorReason: 'Aborted' },
              sessionId
            )
            .catch(() => {});
          if (!['DESTINATION_DENIED', 'REQUEST_STOPPED'].includes(error.code)) {
            this.seal(
              { code: error.code, method: error.method, detail: error.detail },
              'runtime-error'
            );
            this.log('permit_error', {
              code: error.code,
              method: error.method,
              errorType: error.name,
            });
            this.stop(error.code || 'PERMIT_FAILED');
          } else this.log('request_blocked', { code: error.code, type: p.resourceType });
        }
      }
      const requestKey = `${sessionId}:${p.requestId}`;
      if (method === 'Network.responseReceived') {
        const u = new URL(p.response.url);
        if (!['http:', 'https:'].includes(u.protocol)) return;
        const meta = {
          status: p.response.status,
          type: p.type,
          host: u.hostname,
          path: safePath(u.pathname),
          action: u.searchParams.get('_a'),
          urlHash: hash(p.response.url),
          cached: !!(p.response.fromDiskCache || p.response.fromServiceWorker),
        };
        this.requests.set(requestKey, meta);
        this.log('response', meta);
        if (
          [HTTP_STATUS.proxyAuth, HTTP_STATUS.rateLimited, HTTP_STATUS.risk].includes(meta.status)
        ) {
          this.retryAfter =
            p.response.headers?.['Retry-After'] || p.response.headers?.['retry-after'];
          this.stop(`HTTP_${meta.status}`);
        }
        if (meta.path === '/appleauth/auth/signin/complete' && meta.status !== HTTP_STATUS.ok) {
          this.stop(
            meta.status === HTTP_STATUS.conflict ? 'HUMAN_VERIFICATION_REQUIRED' : 'AUTH_REJECTED'
          );
        }
        if (/\/appleauth\/auth\/(?:verify|repair|upgrade)/.test(meta.path)) {
          this.stop('HUMAN_VERIFICATION_REQUIRED');
        }
      }
      if (method === 'Network.loadingFinished') {
        const meta = this.requests.get(requestKey);
        this.requests.delete(requestKey);
        if (!meta || !['Document', 'XHR', 'Fetch'].includes(meta.type) || meta.cached) return;
        if (p.encodedDataLength > LIMITS.bodyBytes) return this.stop('BODY_TOO_LARGE');
        let body;
        try {
          body = await this.cdp.send(
            'Network.getResponseBody',
            { requestId: p.requestId },
            sessionId
          );
        } catch (_) {
          this.log('body_unavailable', meta);
          return;
        }
        const bytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
        if (bytes.length > LIMITS.bodyBytes) return this.stop('BODY_TOO_LARGE');
        const sealed = this.seal(bytes, `body-${++this.bodyCount}`);
        this.log('body', { ...meta, ...sealed });
        if (isOfficialOrderResponse(meta)) {
          const result = parseBody(bytes.toString('utf8'), this.sample.orderNumber);
          if (result && !this.stopped) {
            this.result = result;
            this.resultEvidence = { ...meta, ...sealed, observedAt: new Date().toISOString() };
            this.stop('SUCCEEDED');
          }
          if (meta.path === '/shop/order/list') {
            const model = JSON.parse(
              require('cheerio').load(bytes.toString('utf8'))('#init_data').text() || '{}'
            );
            this.orderListSeen = !!model.orderList;
            const list = parseOrderList(bytes.toString('utf8'), this.sample.orderNumber);
            if (list) {
              this.listResult = list;
              this.seal(list, 'order-list-result');
              const urls = [...new Set(list.products.map(product => product.detailUrl))];
              for (const value of urls) {
                const url = detailUrl(value, meta.host, this.sample.orderNumber);
                if (!this.targetDetailUrl) this.targetDetailUrl = url;
              }
              this.log('official_list_observed', {
                completeItemCount: list.completeItemCount,
                identityMatched: true,
                statusTexts: list.products.map(product => product.rawStatusText),
              });
            }
          }
        }
      }
      if (method === 'Network.loadingFailed') {
        this.log('request_failed', {
          type: p.type,
          canceled: !!p.canceled,
          code: p.errorText?.replace(/https?:\/\/\S+/g, '[URL]'),
        });
        if (
          [
            'net::ERR_TUNNEL_CONNECTION_FAILED',
            'net::ERR_PROXY_CONNECTION_FAILED',
            'net::ERR_PROXY_AUTH_UNSUPPORTED',
          ].includes(p.errorText)
        )
          this.stop('PROXY_CONNECTION_FAILED');
      }
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }
  async launch() {
    try {
      const profile = `/tmp/official-order-${this.id}`;
      const headed = true;
      const args = [
        '--no-sandbox',
        '--disable-background-networking',
        '--disable-component-update',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
        `--remote-debugging-port=${headed ? '9222' : '0'}`,
        '--remote-debugging-address=127.0.0.1',
        '--lang=zh-CN',
        '--window-size=1365,900',
        `--user-data-dir=${profile}`,
        'about:blank',
      ];
      if (!headed) args.splice(1, 0, '--headless=new');
      args.splice(
        args.length - 1,
        0,
        `--proxy-server=http://${this.proxy.host}:${this.proxy.port}`
      );
      this.child = spawn(chromium.executablePath(), args, {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const started = Date.now();
      let ws;
      while (!ws) {
        if (Date.now() - started > LIMITS.attachTimeoutMs || this.child.exitCode !== null)
          throw fail('BROWSER_START_FAILED');
        if (headed) {
          ws = await new Promise(resolve => {
            http
              .get('http://127.0.0.1:9222/json/version', response => {
                let value = '';
                response.on('data', b => {
                  value += b;
                });
                response.on('end', () => {
                  try {
                    resolve(JSON.parse(value).webSocketDebuggerUrl);
                  } catch (_) {
                    resolve(null);
                  }
                });
              })
              .on('error', () => resolve(null));
          });
        } else if (fs.existsSync(`${profile}/DevToolsActivePort`)) {
          const [port, endpoint] = fs
            .readFileSync(`${profile}/DevToolsActivePort`, 'utf8')
            .trim()
            .split('\n');
          ws = `ws://127.0.0.1:${port}${endpoint}`;
        }
        await delay(LIMITS.browserPollMs);
      }
      this.cdp = new Cdp();
      await this.cdp.open(ws);
      this.cdp.on('event', item => this.track(this.event(item)));
      this.cdp.on('fault', error => this.stop(error.code));
      await this.cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      this.browser = await chromium.connectOverCDP(ws);
      this.context = this.browser.contexts()[0];
      this.page = this.context.pages()[0];
      const pageSession = await this.context.newCDPSession(this.page);
      const { targetInfo } = await pageSession.send('Target.getTargetInfo');
      const attachStart = Date.now();
      while (!this.readyTargets.has(targetInfo.targetId)) {
        if (this.stopped || Date.now() - attachStart > LIMITS.attachTimeoutMs)
          throw fail('INTERCEPTION_NOT_READY');
        await delay(LIMITS.attachPollMs);
      }
      await pageSession.detach();
      await this.restoreSession();
      await this.context.routeWebSocket('**/*', socket => socket.close());
      this.log('browser', { version: this.browser.version(), proxy: !!this.proxy, headed });
      this.log(
        'runtime_properties',
        await this.page.evaluate(() => ({
          webdriver: navigator.webdriver,
          language: navigator.language,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency,
          screen: { width: screen.width, height: screen.height },
        }))
      );
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }
  async restoreSession() {
    try {
      let state;
      if (this.resumeRun) {
        const run = String(this.resumeRun);
        if (!/^\d+$/.test(run)) throw fail('RESUME_RUN_INVALID');
        const record = (
          await this.gate.lockClient.query('SELECT sample_id,started_at FROM runs WHERE id=$1', [
            run,
          ])
        ).rows[0];
        const researchSample = readPrivate(`${this.root}/private/inputs.json`).samples.find(
          sample => sample.id === this.sample.id
        );
        if (
          record?.sample_id !== this.sample.id ||
          researchSample?.accountHash !== this.sample.accountHash
        ) {
          throw fail('SESSION_IDENTITY_MISMATCH');
        }
        const directory = `${this.root}/evidence/run-${run}`;
        const file = fs.readdirSync(directory).find(name => /^session-[a-f0-9]+\.enc$/.test(name));
        if (!file) throw fail('SESSION_MISSING');
        const decoded = JSON.parse(decrypt(readPrivate(`${directory}/${file}`, false), this.key));
        state = {
          accountHash: this.sample.accountHash,
          createdAt: record.started_at,
          cookies: decoded.cookies,
        };
      } else if (fs.existsSync(this.sessionFile)) {
        state = JSON.parse(decrypt(readPrivate(this.sessionFile, false), this.key));
      }
      if (!state) return;
      try {
        const cookies = validateSession(state, this.sample.accountHash);
        await this.context.addCookies(cookies);
        this.sessionRestored = true;
        this.sessionCreatedAt = state.createdAt;
        this.log('server_session_restored', { cookieCount: cookies.length });
      } catch (error) {
        if (error.code !== 'SESSION_EXPIRED') throw error;
        this.log('server_session_expired');
      }
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }
  async saveSession() {
    try {
      const state = await this.context.storageState();
      this.seal(state, 'session');
      const envelope = {
        accountHash: this.sample.accountHash,
        createdAt: this.passwordSubmitted
          ? new Date().toISOString()
          : this.sessionCreatedAt || new Date().toISOString(),
        cookies: state.cookies,
      };
      writePrivate(this.sessionFile, encrypt(envelope, this.key));
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }
  async navigateAccount() {
    try {
      if (/\/shop\/account(?:\/|$)/.test(new URL(this.page.url()).pathname)) {
        const links = await this.page
          .locator('a[href]')
          .evaluateAll(nodes => nodes.map(node => node.href));
        const signInUrl = links.find(href =>
          /^\/shop\/signIn(?:\/|$)/.test(new URL(href).pathname)
        );
        const ordersUrl = links.find(href =>
          /\/shop\/(?:goto\/)?order\/list$/.test(new URL(href).pathname)
        );
        const selected = this.passwordSubmitted || this.sessionRestored ? ordersUrl : signInUrl;
        if (selected && !this.accountNavigated) {
          permittedUrl(selected);
          this.accountNavigated = true;
          await this.page.goto(selected, { waitUntil: 'domcontentloaded', timeout: 45000 });
        }
      }
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }
  async loginStep() {
    try {
      await this.navigateAccount();
      for (const frame of this.page.frames()) {
        if (!/^https:\/\/(?:idmsa|idmsauth)\.apple\.com(?:\.cn)?\//.test(frame.url())) continue;
        const password = frame.locator('#password_text_field');
        const email = frame.locator('#account_name_text_field');
        const signIn = frame.locator('#sign-in');
        if (!(await signIn.isVisible())) continue;
        const action = await signIn.getAttribute('aria-label');
        if (
          !this.passwordSubmitted &&
          ['登录', 'Sign In'].includes(action) &&
          (await password.isVisible())
        ) {
          if (await email.isVisible()) await email.fill(this.sample.email);
          await password.fill(this.sample.password);
          await this.gate.claimLogin();
          this.passwordSubmitted = true;
          this.passwordSubmittedAt = Date.now();
          this.log('password_submitted', { accountHash: this.sample.accountHash });
          await signIn.click({ timeout: 5000 });
        } else if (
          !this.emailSubmitted &&
          !this.passwordSubmitted &&
          ['继续', 'Continue'].includes(action) &&
          (await email.isVisible())
        ) {
          await email.fill(this.sample.email);
          this.emailSubmitted = true;
          await signIn.click({ timeout: 5000 });
          this.log('identifier_submitted');
        }
      }
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }
  async waitForSiteReady() {
    try {
      if (this.browserReady) return true;
      const cookies = await this.context.cookies('https://www.apple.com.cn');
      if (
        cookies.some(
          cookie => cookie.name === 'shld_bt_ck' && cookie.value.length > LIMITS.cookieMinimumLength
        )
      ) {
        this.browserReady = true;
        this.log('site_ready', { elapsedMs: Date.now() - this.started });
        return true;
      }
      return false;
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }
  async run() {
    let summary;
    try {
      await this.initialize();
      await this.launch();
      const url = this.sessionRestored
        ? this.sample.url
        : 'https://www.apple.com.cn/shop/goto/account';
      await this.page
        .goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(() => this.log('navigation_pending'));
      const observeFrom = Date.now();
      while (!this.stopped && Date.now() - this.started < LIMITS.observationMs) {
        const ready = await this.waitForSiteReady();
        if (!ready && Date.now() - observeFrom > LIMITS.siteReadyMs)
          throw fail('SITE_READINESS_TIMEOUT');
        if (ready) await this.loginStep();
        if (this.targetDetailUrl && !this.detailOpened) {
          this.detailOpened = true;
          this.log('target_order_opened');
          await this.page.goto(this.targetDetailUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
        }
        if (this.orderListSeen && !this.targetDetailUrl && !this.guestOpened) {
          this.guestOpened = true;
          this.log('target_missing_from_account_list');
          await this.page.goto(this.sample.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        }
        await delay(LIMITS.loopPollMs);
      }
      if (!this.stopped) this.stop('NO_VALID_ORDER_DATA');
      // 会话保存不将旧数据改成新观测；失败结果单列，旧成功文件保持。
      if (!['AUTH_REJECTED', 'HUMAN_VERIFICATION_REQUIRED'].includes(this.stopped)) {
        await this.saveSession();
      }
      if (this.result && this.stopped === 'SUCCEEDED') {
        const output = {
          systemOrderId: this.sample.id,
          ...this.result,
          source: {
            provider: 'Apple official website',
            runId: Number(this.id),
            ...this.resultEvidence,
          },
        };
        this.seal(output, 'official-result');
        const resultName = `order-${this.sample.id}-run-${this.id}.json`;
        this.resultFile = path.join(this.root, 'private/results', resultName);
        writePrivate(this.resultFile, JSON.stringify(output, null, LIMITS.jsonIndent));
      }
    } catch (error) {
      if (this.logger) {
        this.seal(
          { name: error.name, message: error.message, stack: error.stack },
          'runtime-error'
        );
        this.log('run_error', { code: error.code, method: error.method, name: error.name });
      }
      const code = /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'COLLECTOR_ERROR';
      if (!this.stopped || this.stopped === 'SUCCEEDED') this.stopped = code;
    } finally {
      this.closing = true;
      if (this.browser) await this.browser.close().catch(() => {});
      if (this.child && this.child.exitCode === null) {
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            this.child.kill('SIGKILL');
            resolve();
          }, LIMITS.childShutdownMs);
          this.child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          this.child.kill('SIGTERM');
        });
      }
      this.cdp?.close();
      await Promise.allSettled([...this.pending]);
      if (this.gate.id) {
        await this.gate.recordFailure(this.stopped, this.retryAfter).catch(() => {
          this.stopped = 'STATE_WRITE_FAILED';
        });
      }
      await this.gate.close(this.stopped || 'INITIALIZATION_FAILED').catch(() => {
        this.stopped = 'STATE_WRITE_FAILED';
      });
      summary = {
        runId: this.id,
        systemOrderId: this.sample.id,
        outcome: this.stopped || 'INITIALIZATION_FAILED',
        requests: this.gate.requests,
        passwordSubmitted: this.passwordSubmitted,
        serverSessionRestored: !!this.sessionRestored,
        resultFile: this.resultFile,
        result:
          this.result && this.stopped === 'SUCCEEDED'
            ? { ...this.result, orderNumber: undefined }
            : undefined,
      };
      if (this.logger) {
        this.log('finished', summary);
        writePrivate(
          `${this.directory}/state.json`,
          JSON.stringify(summary, null, LIMITS.jsonIndent)
        );
        await new Promise(resolve => {
          this.logger.on('finish', resolve);
          this.logger.end();
        });
      }
    }
    return summary;
  }
}

module.exports = OfficialOrderCollector;
