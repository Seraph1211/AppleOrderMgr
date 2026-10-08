/* global navigator, screen, document */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const { chromium } = require('playwright-core');
const winston = require('winston');
const Cdp = require('./officialOrderCdp');
const { collectBrowserReceipt } = require('./officialOrderBrowserReceipt');
const { extractOfficialReceiptUrl } = require('./officialOrderReceipt');
const { assertReceiptCandidate, observeReceiptDom } = require('./officialOrderReceiptDom');
const { bootstrapOfficialOrderHttp } = require('./officialOrderHttpBootstrap');
const { OfficialOrderHttpTransport } = require('./officialOrderHttpTransport');
const { inspectShieldCookie } = require('./officialOrderShield');
const OfficialOrderGate = require('./officialOrderGate');
const OfficialOrderProxyTunnel = require('./officialOrderProxyTunnel');
const {
  parseOfficialOrderDetail: parseBody,
  parseOfficialOrderList: parseOrderList,
  isOfficialOrderResponse,
} = require('./officialOrderParser');
const {
  fault: fail,
  hash,
  proxyFingerprint,
  proxyLeaseWindowMs,
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
  observationMs: 170000,
  siteReadyMs: 45000,
  loopPollMs: 750,
  childShutdownMs: 5000,
  jsonIndent: 2,
  authSettleMs: 500,
  authSnapshotMs: 1000,
  authDiagnosticMs: 3000,
  authFrames: 8,
  authTextLength: 12000,
  retryAfterLength: 128,
  receiptRedirectDiagnostics: 4,
  receiptDiagnosticText: 8192,
  receiptDiagnosticBytes: 65536,
});
const RECEIPT_DIAGNOSTIC_HEADERS = new Set([
  'referer',
  'origin',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
]);
const RECEIPT_DIAGNOSTIC_PATHS = new Set([
  '/shop/goto/account',
  '/shop/account/home',
  '/shop/signIn',
  '/shop/signIn/account',
  '/shop/signIn/idms/authx',
  '/shop/order/list',
  '/appleauth/auth/authorize',
  '/appleauth/auth/signin',
  '/appleauth/auth/signin/complete',
]);
const HTTP_STATUS = Object.freeze({
  ok: 200,
  proxyAuth: 407,
  conflict: 409,
  precondition: 412,
  rateLimited: 429,
  risk: 541,
  badGateway: 502,
  unavailable: 503,
  gatewayTimeout: 504,
});

function withinDeadline(promise, milliseconds, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 未知路径只输出固定占位符，完整目标与 Location 仅进入加密证据。 */
function receiptDiagnosticUrl(value) {
  if (typeof value !== 'string') return { host: null, path: null, urlHash: null };
  const urlHash = hash(value);
  try {
    const url = permittedUrl(value);
    let pathname = '[REDACTED]';
    if (RECEIPT_DIAGNOSTIC_PATHS.has(url.pathname)) pathname = url.pathname;
    if (/^\/shop\/order\/print\/invoice\/[^/]+\/[^/]+$/.test(url.pathname))
      pathname = '/shop/order/print/invoice/[INVOICE]/[TOKEN]';
    if (/^\/shop\/order\/detail\/[^/]+\/[^/]+$/.test(url.pathname))
      pathname = '/shop/order/detail/[ID]/[ORDER]';
    return { host: url.hostname, path: pathname, urlHash };
  } catch (_error) {
    return { host: '[NON_OFFICIAL]', path: '[REDACTED]', urlHash };
  }
}

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
    accountMode = false,
    captureReceipt = false,
    browserMode = 'headed',
    leaseContext,
    batchPolicy = {},
    httpBootstrap = false,
    httpPythonPath,
    persistSessions = true,
  }) {
    if (
      !['headed', 'headless-shell', 'chromium'].includes(browserMode) ||
      (browserMode === 'headless-shell' && !captureReceipt)
    )
      throw fail('BROWSER_MODE_INVALID');
    if (typeof persistSessions !== 'boolean') throw fail('SESSION_PERSISTENCE_INVALID');
    this.root = path.resolve(root);
    const inputs = readPrivate(inputFile);
    this.accountMode = accountMode;
    this.captureReceipt = captureReceipt;
    this.browserMode = browserMode;
    this.leaseContext = leaseContext;
    this.httpBootstrap = httpBootstrap === true;
    this.httpPythonPath = httpPythonPath;
    this.persistSessions = persistSessions;
    this.samples = accountMode
      ? inputs.samples.map(validateSample)
      : [validateSample(inputs.samples.find(sample => sample.id === orderId))];
    this.sample = this.samples[0];
    if (
      !this.sample ||
      this.samples.some(
        sample =>
          sample.accountHash !== this.sample.accountHash || sample.password !== this.sample.password
      ) ||
      new Set(this.samples.map(sample => sample.id)).size !== this.samples.length
    )
      throw fail('ACCOUNT_MISMATCH');
    this.accountResults = accountMode ? [...(inputs.failures || [])] : null;
    this.gate = new OfficialOrderGate(
      readPrivate(`${this.root}/private/db.json`),
      totalRequestLimit,
      runRequestLimit,
      batchPolicy
    );
    this.key = readPrivate(`${this.root}/private/evidence.key`, false);
    this.proxy = readPrivate(proxyFile);
    if (
      !/^[a-z0-9.-]+$/i.test(this.proxy.host) ||
      !Number.isInteger(Number(this.proxy.port)) ||
      Number(this.proxy.port) < 1 ||
      Number(this.proxy.port) > LIMITS.maximumPort ||
      !this.proxy.username ||
      !this.proxy.password ||
      (this.proxy.preemptiveAuth !== undefined && typeof this.proxy.preemptiveAuth !== 'boolean')
    )
      throw fail('PROXY_INVALID');
    this.proxyHash = proxyFingerprint(this.proxy);
    if (
      leaseContext &&
      (leaseContext.proxyHash !== this.proxyHash ||
        (leaseContext.provider || 'fanproxy') !== (this.proxy.provider || 'fanproxy') ||
        !/^[a-f0-9]{64}$/.test(leaseContext.egressHash || '') ||
        !Number.isFinite(Date.parse(leaseContext.startedAt)) ||
        Date.parse(leaseContext.startedAt) > Date.now() ||
        Date.now() - Date.parse(leaseContext.startedAt) > proxyLeaseWindowMs(leaseContext))
    )
      throw fail('PROXY_LEASE_INVALID');
    if (captureReceipt && !leaseContext) throw fail('PROXY_LEASE_REQUIRED');
    this.resumeRun = resumeRun;
    this.sessionFile = `${this.root}/private/sessions/${this.sample.accountHash}.enc`;
    this.requests = new Map();
    this.inFlightHosts = new Map();
    this.sessions = new Set();
    this.pending = new Set();
    this.readyTargets = new Set();
    this.authChallenges = new Set();
    this.documentLoaders = new Map();
    this.detailCandidate = null;
    this.detailCandidateState = null;
    this.ignoredDetailCandidates = 0;
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
  /** 只记录现有 CDP 事件；不发请求、不放宽收据守卫，也不保存 Cookie 或认证头。 */
  recordReceiptDiagnostic(kind, params, sessionId) {
    const phase = this.receiptPhase;
    if (!phase || !['initial-request', 'redirect-response', 'blocked-document'].includes(kind))
      return;
    const counts = (phase.diagnosticCounts ||= {});
    const limit = kind === 'redirect-response' ? LIMITS.receiptRedirectDiagnostics : 1;
    if ((counts[kind] || 0) >= limit) return;
    counts[kind] = (counts[kind] || 0) + 1;
    try {
      let truncated = false;
      const text = value => {
        if (typeof value !== 'string') return null;
        if (value.length > LIMITS.receiptDiagnosticText) truncated = true;
        return value.slice(0, LIMITS.receiptDiagnosticText);
      };
      const request = params.request || {};
      const headers = {};
      for (const [name, value] of Object.entries(request.headers || {})) {
        if (RECEIPT_DIAGNOSTIC_HEADERS.has(name.toLowerCase()))
          headers[name.toLowerCase()] = text(value);
      }
      const response = params.redirectResponse;
      const payload = {
        version: 1,
        kind,
        systemOrderId: this.sample.id,
        detailRunId: Number(this.id),
        receiptRunId: Number(phase.runId),
        observedAt: new Date().toISOString(),
        originalUrl: text(phase.url),
        originalUrlHash: phase.urlHash,
        sessionId: text(sessionId),
        frameId: text(params.frameId),
        requestId: text(params.requestId),
        networkId: text(params.networkId),
        request: {
          url: text(request.url),
          urlHash: hash(request.url || ''),
          method: text(request.method),
          headers,
        },
        redirectResponse: null,
        initiator: null,
      };
      if (response) {
        const location = Object.entries(response.headers || {}).find(
          ([name]) => name.toLowerCase() === 'location'
        )?.[1];
        payload.redirectResponse = {
          url: text(response.url),
          urlHash: hash(response.url || ''),
          status: Number.isInteger(response.status) ? response.status : null,
          location: text(location),
        };
      }
      if (params.initiator) {
        const initiator = params.initiator;
        payload.initiator = {
          type: text(initiator.type),
          url: text(initiator.url),
          lineNumber: Number.isSafeInteger(initiator.lineNumber) ? initiator.lineNumber : null,
          columnNumber: Number.isSafeInteger(initiator.columnNumber)
            ? initiator.columnNumber
            : null,
        };
      }
      payload.truncated = truncated;
      const bytes = Buffer.from(JSON.stringify(payload));
      if (bytes.length > LIMITS.receiptDiagnosticBytes) throw fail('RECEIPT_DIAGNOSTIC_TOO_LARGE');
      const sealed = this.seal(bytes, `receipt-${kind}-${counts[kind]}`);
      this.log('receipt_diagnostic', {
        kind,
        detailRunId: Number(this.id),
        receiptRunId: Number(phase.runId),
        ...receiptDiagnosticUrl(request.url),
        ...sealed,
        truncated,
      });
    } catch (_error) {
      this.log('receipt_diagnostic_unavailable', { kind });
    }
  }
  /** 同步检查人工停止；已取得详情也不能授权后续登录、收据或新目标请求。 */
  isStopRequested() {
    const requested = fs.existsSync(`${this.root}/private/STOP`);
    if (
      requested &&
      (!this.stopped ||
        ['SUCCEEDED', 'NO_VALID_ORDER_DATA', 'ORDER_ATTEMPT_LIMIT'].includes(this.stopped))
    ) {
      this.stopped = 'REQUEST_STOPPED';
      if (this.logger) this.log('stopped', { code: this.stopped });
    }
    return requested;
  }
  stop(code) {
    if (
      !this.stopped ||
      (this.accountMode && this.stopped === 'SUCCEEDED' && code !== 'SUCCEEDED')
    ) {
      this.stopped = code;
      this.log('stopped', { code });
    }
  }
  beginAuthDiagnostic(response) {
    // 先停止外部请求，再保存诊断；证据写入异常也不能恢复登录。
    this.stop('AUTH_PRECONDITION_REQUIRED');
    if (this.authDiagnostic) return;
    const location = Object.entries(response.headers || {}).find(
      ([name]) => name.toLowerCase() === 'location'
    )?.[1];
    this.authDiagnostic = { status: HTTP_STATUS.precondition, hasLocation: !!location };
    this.seal({ status: response.status, location: location || null }, 'auth-response');
    this.log('auth_precondition', this.authDiagnostic);
  }
  async captureAuthDiagnostic() {
    try {
      if (!this.authDiagnostic || !this.page) return;
      // 不加载修复入口，只读取终止请求后现有页面可见文本；整体有硬超时。
      const capture = async () => {
        try {
          await delay(LIMITS.authSettleMs);
          const frames = this.page.frames().slice(0, LIMITS.authFrames);
          const snapshots = await Promise.all(
            frames.map(async frame => {
              try {
                const url = frame.url();
                permittedUrl(url);
                const text = await withinDeadline(
                  frame.evaluate(
                    limit => (document.body?.innerText || '').slice(0, limit),
                    LIMITS.authTextLength
                  ),
                  LIMITS.authSnapshotMs,
                  null
                );
                return text === null ? null : { url, text };
              } catch (_error) {
                return null;
              }
            })
          );
          return snapshots.filter(Boolean);
        } catch (_error) {
          return [];
        }
      };
      const snapshots = await withinDeadline(capture(), LIMITS.authDiagnosticMs, []);
      this.seal({ networkStopped: true, snapshots }, 'auth-page');
      this.authDiagnostic.visibleFrameCount = snapshots.length;
      this.log('auth_diagnostic_saved', this.authDiagnostic);
    } catch (_error) {
      this.log('auth_diagnostic_unavailable');
    }
  }
  async initialize() {
    try {
      if (this.isStopRequested()) throw fail('REQUEST_STOPPED');
      if (this.accountMode) {
        await this.gate.openAccount(this.sample, this.proxyHash);
        this.started = Date.now();
        for (const sample of this.samples) {
          try {
            if (this.isStopRequested()) throw fail('REQUEST_STOPPED');
            this.id = await this.gate.startOrder(sample);
            this.sample = sample;
            break;
          } catch (error) {
            if (error.code !== 'ORDER_ATTEMPT_LIMIT') throw error;
            this.accountResults.push({ orderId: sample.id, outcome: error.code });
          }
        }
        if (!this.id) throw fail('ORDER_ATTEMPT_LIMIT');
      } else this.id = await this.gate.open(this.sample, this.proxyHash);
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
      if (this.isStopRequested()) throw fail('REQUEST_STOPPED');
      const url = permittedUrl(value);
      if (
        this.leaseContext &&
        Date.now() - Date.parse(this.leaseContext.startedAt) >
          proxyLeaseWindowMs(this.leaseContext, true)
      )
        throw fail('PROXY_LEASE_EXPIRED');
      const permit = await this.gate.permit(value, () => this.isStopRequested() || !!this.stopped);
      if (this.isStopRequested()) throw fail('REQUEST_STOPPED');
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
        for (const key of this.inFlightHosts.keys()) {
          if (key.startsWith(`${p.sessionId}:`)) this.inFlightHosts.delete(key);
        }
        return;
      }
      if (method === 'Target.attachedToTarget') return await this.attach(p.sessionId, p.targetInfo);
      if (!sessionId || !this.sessions.has(sessionId)) return;
      const networkKey = `${sessionId}:${p.requestId}`;
      if (method === 'Network.requestWillBeSent') {
        this.inFlightHosts.set(networkKey, new URL(p.request.url).hostname);
        if (this.captureReceipt && p.type === 'Document' && p.frameId && p.loaderId)
          this.documentLoaders.set(p.frameId, p.loaderId);
        if (this.receiptPhase && p.type === 'Document' && p.redirectResponse)
          this.recordReceiptDiagnostic('redirect-response', p, sessionId);
      }
      if (['Network.loadingFinished', 'Network.loadingFailed'].includes(method)) {
        this.inFlightHosts.delete(networkKey);
      }
      if (method === 'Fetch.authRequired') {
        const authKey = `${sessionId}:${p.requestId}`;
        const proxyAuth =
          !this.stopped &&
          this.proxy &&
          !this.proxy.preemptiveAuth &&
          p.authChallenge.source === 'Proxy' &&
          !this.authChallenges.has(authKey);
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
          if (this.receiptPhase && p.request.url !== this.receiptPhase.url) {
            if (p.resourceType === 'Document') {
              this.receiptPhase.outcome = 'RECEIPT_SESSION_REDIRECT';
              this.stop('RECEIPT_SESSION_REDIRECT');
              this.recordReceiptDiagnostic('blocked-document', p, sessionId);
            }
            throw fail('REQUEST_STOPPED');
          }
          if (
            this.isStopRequested() ||
            this.stopped ||
            ['Media', 'WebSocket'].includes(p.resourceType)
          )
            throw fail('REQUEST_STOPPED');
          if (this.receiptPhase && p.resourceType === 'Document')
            this.recordReceiptDiagnostic('initial-request', p, sessionId);
          if (
            this.captureReceipt &&
            this.browserMode !== 'chromium' &&
            ['Image', 'Font'].includes(p.resourceType)
          )
            throw fail('REQUEST_STOPPED');
          await this.permit(p.request.url, p.resourceType);
          if (this.isStopRequested() || this.stopped || !this.sessions.has(sessionId))
            throw fail('REQUEST_STOPPED');
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
          } else
            this.log('request_blocked', {
              code: error.code,
              type: p.resourceType,
              urlHash: hash(p.request.url),
              phase: this.passwordSubmitted ? 'post-login' : 'pre-login',
            });
        }
      }
      const requestKey = `${sessionId}:${p.requestId}`;
      if (method === 'Network.responseReceived') {
        const u = new URL(p.response.url);
        if (!['http:', 'https:'].includes(u.protocol)) return;
        const meta = {
          sampleId: this.sample.id,
          status: p.response.status,
          type: p.type,
          host: u.hostname,
          path: safePath(u.pathname),
          action: u.searchParams.get('_a'),
          urlHash: hash(p.response.url),
          cached: !!(p.response.fromDiskCache || p.response.fromServiceWorker),
          contentType: p.response.mimeType || p.response.headers?.['content-type'],
          protocol: p.response.protocol,
          tlsVersion: p.response.securityDetails?.protocol,
          phase: this.receiptPhase
            ? 'receipt'
            : this.passwordSubmitted
              ? 'post-login'
              : 'pre-login',
        };
        if (this.captureReceipt)
          Object.assign(meta, {
            collectorRunId: Number(this.id),
            frameId: p.frameId,
            loaderId: p.loaderId,
            sessionId,
          });
        this.requests.set(requestKey, meta);
        if (this.captureReceipt && p.type === 'Document' && p.frameId && p.loaderId)
          this.documentLoaders.set(p.frameId, p.loaderId);
        this.log('response', meta);
        if (
          [HTTP_STATUS.proxyAuth, HTTP_STATUS.rateLimited, HTTP_STATUS.risk].includes(meta.status)
        ) {
          this.retryAfter =
            p.response.headers?.['Retry-After'] || p.response.headers?.['retry-after'];
          this.stop(`HTTP_${meta.status}`);
        }
        if (meta.path === '/appleauth/auth/signin/complete' && meta.status !== HTTP_STATUS.ok) {
          if (meta.status === HTTP_STATUS.precondition) this.beginAuthDiagnostic(p.response);
          else if (
            [HTTP_STATUS.badGateway, HTTP_STATUS.unavailable, HTTP_STATUS.gatewayTimeout].includes(
              meta.status
            )
          )
            this.stop(`HTTP_${meta.status}`);
          else
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
        if (
          meta.path === '/appleauth/auth/signin/complete' &&
          meta.status === HTTP_STATUS.precondition
        ) {
          try {
            const { authType } = JSON.parse(bytes.toString('utf8'));
            if (this.authDiagnostic && ['sa', 'hsa', 'hsa2', 'non-sa'].includes(authType))
              this.authDiagnostic.authType = authType;
          } catch (_error) {
            this.log('auth_diagnostic_body_unparsed');
          }
        }
        if (this.receiptPhase && meta.urlHash === this.receiptPhase.urlHash) {
          if (
            (this.stopped && this.stopped !== 'RECEIPT_CAPTURED') ||
            (this.receiptPhase.outcome && this.receiptPhase.outcome !== 'RECEIPT_CAPTURED')
          ) {
            this.log('receipt_body_ignored_after_stop');
            return;
          }
          this.receiptPhase.captured = {
            bytes,
            status: meta.status,
            contentType: meta.contentType,
          };
          this.receiptPhase.outcome =
            meta.status === HTTP_STATUS.ok ? 'RECEIPT_CAPTURED' : `HTTP_${meta.status}`;
          this.stop(this.receiptPhase.outcome);
          return;
        }
        if (!this.receiptPhase && isOfficialOrderResponse(meta)) {
          if (this.accountMode && meta.sampleId !== this.sample.id) return;
          if (this.captureReceipt && meta.collectorRunId !== Number(this.id)) return;
          if (this.captureReceipt && (this.stopped || this.detailCandidate)) {
            this.ignoredDetailCandidates += 1;
            this.log('detail_candidate_ignored', { count: this.ignoredDetailCandidates });
            return;
          }
          let result;
          try {
            result = parseBody(bytes.toString('utf8'), this.sample.orderNumber);
          } catch (error) {
            // 账号模式切换订单后的迟到响应不能终止新单，更不能回写到新单。
            if (this.accountMode && error.code === 'IDENTITY_MISMATCH') return;
            throw error;
          }
          if (result && !this.stopped) {
            const source = { ...meta, ...sealed, observedAt: new Date().toISOString() };
            if (this.captureReceipt) this.freezeDetailCandidate(result, source, bytes);
            else {
              this.result = result;
              this.resultEvidence = source;
              this.stop('SUCCEEDED');
            }
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
  browserExecutable() {
    const executable = chromium.executablePath();
    if (this.browserMode !== 'headless-shell') return executable;
    const revisionDirectory = path.dirname(path.dirname(executable));
    const revision = path.basename(revisionDirectory);
    if (!/^chromium-\d+$/.test(revision)) throw fail('BROWSER_EXECUTABLE_UNAVAILABLE');
    const shell = path.join(
      path.dirname(revisionDirectory),
      revision.replace('chromium-', 'chromium_headless_shell-'),
      'chrome-headless-shell-linux64',
      'chrome-headless-shell'
    );
    if (!fs.existsSync(shell)) throw fail('BROWSER_EXECUTABLE_UNAVAILABLE');
    return shell;
  }
  async launch() {
    try {
      const profile = `/tmp/official-order-${this.id}`;
      const headed = this.browserMode === 'headed';
      const args = [
        '--no-sandbox',
        '--disable-background-networking',
        '--disable-component-update',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
        '--remote-debugging-port=9222',
        '--remote-debugging-address=127.0.0.1',
        '--lang=zh-CN',
        '--window-size=1365,900',
        `--user-data-dir=${profile}`,
        'about:blank',
      ];
      if (!headed) args.splice(1, 0, '--headless=new');
      if (this.captureReceipt && this.browserMode !== 'chromium') {
        args.splice(
          1,
          0,
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--renderer-process-limit=2',
          '--num-raster-threads=1'
        );
      }
      if (this.browserMode === 'chromium')
        args.splice(1, 0, '--renderer-process-limit=2', '--num-raster-threads=1');
      let proxyServer = `http://${this.proxy.host}:${this.proxy.port}`;
      if (this.proxy.preemptiveAuth) {
        this.proxyTunnel = new OfficialOrderProxyTunnel(
          this.proxy,
          (code, retryAfter) => {
            this.retryAfter = retryAfter;
            this.stop(code);
          },
          host => this.captureReceipt && ![...this.inFlightHosts.values()].includes(host)
        );
        proxyServer = await this.proxyTunnel.start();
        this.log('proxy_preemptive_auth', { loopbackOnly: true });
      }
      args.splice(args.length - 1, 0, `--proxy-server=${proxyServer}`);
      this.child = spawn(this.browserExecutable(), args, {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const started = Date.now();
      let ws;
      while (!ws) {
        if (Date.now() - started > LIMITS.attachTimeoutMs || this.child.exitCode !== null)
          throw fail('BROWSER_START_FAILED');
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
      this.pageControl = pageSession;
      await this.restoreSession();
      await this.context.routeWebSocket('**/*', socket => socket.close());
      this.log('browser', {
        version: this.browser.version(),
        mode: this.browserMode,
        proxy: !!this.proxy,
        headed,
        networkStack: 'native-chromium',
        userAgentOverridden: false,
      });
      this.log(
        'runtime_properties',
        await this.page.evaluate(() => ({
          webdriver: navigator.webdriver,
          language: navigator.language,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency,
          userAgent: navigator.userAgent,
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
      // 对照采样仅使用本进程上下文；同时阻止账户会话和 resumeRun 历史证据导入。
      if (this.persistSessions === false || this.httpBootstrap) return;
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
          origins: decoded.origins,
        };
      } else if (fs.existsSync(this.sessionFile)) {
        state = JSON.parse(decrypt(readPrivate(this.sessionFile, false), this.key));
      }
      if (!state) return;
      try {
        if (
          this.leaseContext &&
          (state.lease?.proxyHash !== this.proxyHash ||
            state.lease?.egressHash !== this.leaseContext.egressHash ||
            state.lease?.startedAt !== this.leaseContext.startedAt)
        )
          throw fail('SESSION_EXPIRED');
        const cookies = validateSession(state, this.sample.accountHash);
        if (state.origins?.length) {
          await this.context.setStorageState({
            cookies,
            origins: state.origins.map(item => ({
              origin: item.origin,
              localStorage: item.localStorage,
            })),
          });
        } else await this.context.addCookies(cookies);
        this.sessionRestored = true;
        this.sessionCreatedAt = state.createdAt;
        this.log('server_session_restored', {
          cookieCount: cookies.length,
          originCount: state.origins?.length || 0,
        });
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
      if (this.persistSessions === false) {
        this.log('session_persistence_disabled');
        return;
      }
      if (this.httpBootstrap) {
        this.log('http_bootstrap_session_not_persisted');
        return;
      }
      const state = await this.context.storageState();
      this.seal(state, 'session');
      const envelope = {
        accountHash: this.sample.accountHash,
        createdAt: this.passwordSubmitted
          ? new Date(this.passwordSubmittedAt || Date.now()).toISOString()
          : this.sessionCreatedAt || new Date().toISOString(),
        cookies: state.cookies,
        origins: state.origins || [],
        ...(this.leaseContext ? { lease: this.leaseContext } : {}),
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
          if (this.isStopRequested()) return;
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
      if (this.isStopRequested() || this.stopped) return;
      await this.navigateAccount();
      for (const frame of this.page.frames()) {
        if (this.isStopRequested() || this.stopped) return;
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
          if (await email.isVisible()) {
            if (this.isStopRequested() || this.stopped) return;
            await email.fill(this.sample.email);
          }
          if (this.isStopRequested() || this.stopped) return;
          await password.fill(this.sample.password);
          if (this.isStopRequested() || this.stopped) return;
          await this.gate.claimLogin();
          if (this.isStopRequested() || this.stopped) return;
          this.passwordSubmitted = true;
          this.passwordSubmittedAt = Date.now();
          this.log('password_submitted', { accountHash: this.sample.accountHash });
          if (this.isStopRequested() || this.stopped) return;
          await signIn.click({ timeout: 5000 });
        } else if (
          !this.emailSubmitted &&
          !this.passwordSubmitted &&
          ['继续', 'Continue'].includes(action) &&
          (await email.isVisible())
        ) {
          if (this.isStopRequested() || this.stopped) return;
          await email.fill(this.sample.email);
          if (this.isStopRequested() || this.stopped) return;
          this.emailSubmitted = true;
          if (this.isStopRequested() || this.stopped) return;
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
      const current = this.page?.url?.() || 'https://www.apple.com.cn';
      const cookies = await this.context.cookies(permittedUrl(current).href);
      if (
        cookies.some(
          cookie => cookie.name === 'shld_bt_ck' && inspectShieldCookie(cookie).valid === true
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
  async prepareHttpLogin() {
    let transport;
    try {
      if (!this.httpBootstrap || this.sessionRestored) return;
      if (!this.leaseContext || !this.httpPythonPath) throw fail('HTTP_BOOTSTRAP_CONFIG_INVALID');
      transport = new OfficialOrderHttpTransport({
        gate: this.gate,
        proxy: this.proxy,
        pythonPath: this.httpPythonPath,
        isStopped: () => {
          if (
            !Number.isFinite(Date.parse(this.leaseContext.startedAt)) ||
            Date.now() - Date.parse(this.leaseContext.startedAt) >
              proxyLeaseWindowMs(this.leaseContext, true)
          )
            throw fail('PROXY_LEASE_EXPIRED');
          return this.isStopRequested() || !!this.stopped;
        },
      });
      await transport.start();
      const bootstrap = await bootstrapOfficialOrderHttp({
        transport,
        sample: this.sample,
        root: this.root,
        key: this.key,
        runId: Number(this.id),
      });
      await this.context.addCookies(bootstrap.cookies);
      this.bootstrapLoginUrl = bootstrap.loginPageUrl;
      this.log('http_login_bootstrap_ready', { cookieCount: bootstrap.cookies.length });
    } catch (error) {
      if (typeof error.retryAfter === 'string')
        this.retryAfter = error.retryAfter.slice(0, LIMITS.retryAfterLength);
      error.component = 'officialOrderCollector';
      throw error;
    } finally {
      if (transport) await transport.close();
    }
  }
  freezeDetailCandidate(result, source, body) {
    if (this.stopped || this.isStopRequested() || this.detailCandidate) return;
    let invoiceUrl = null;
    let linkOutcome = null;
    try {
      invoiceUrl = extractOfficialReceiptUrl(
        body.toString('utf8'),
        this.sample.orderNumber,
        source.host
      ).href;
    } catch (error) {
      if (!['RECEIPT_LINK_MISSING', 'RECEIPT_LINK_INVALID'].includes(error.code)) throw error;
      linkOutcome = error.code;
    }
    this.detailCandidate = Object.freeze({
      runId: Number(this.id),
      orderId: this.sample.id,
      orderNumber: this.sample.orderNumber,
      result,
      source: Object.freeze({ ...source }),
      createdAt: Date.now(),
      invoiceUrl,
      linkOutcome,
      page: this.page,
      frame: this.page.mainFrame(),
    });
    this.detailCandidateState = 'pending';
  }
  async observeDetailCandidate() {
    const candidate = this.detailCandidate;
    try {
      if (!candidate || this.detailCandidateState !== 'pending') return;
      this.detailCandidateState = 'observing';
      const observation = await observeReceiptDom(this, candidate, LIMITS.observationMs);
      assertReceiptCandidate(this, candidate, LIMITS.observationMs);
      try {
        this.seal(observation, 'receipt-dom');
      } catch (_error) {
        throw fail('STATE_WRITE_FAILED');
      }
      this.log('receipt_dom_observed', {
        matchingCount: observation.snapshot?.matchingCount || 0,
        visibleCount: observation.snapshot?.visibleCount || 0,
        truncatedCount: observation.snapshot?.truncatedCount || 0,
      });
      assertReceiptCandidate(this, candidate, LIMITS.observationMs);
      this.result = candidate.result;
      this.resultEvidence = candidate.source;
      this.detailCandidateState = 'promoted';
      this.stop('SUCCEEDED');
    } catch (error) {
      this.detailCandidateState = 'failed';
      if (!this.stopped) this.stop(error.code || 'RECEIPT_DOM_OBSERVATION_FAILED');
    }
  }
  async collectCurrent(first = true) {
    try {
      if (this.isStopRequested()) return;
      const url =
        this.sessionRestored || !first
          ? this.sample.url
          : this.bootstrapLoginUrl || 'https://www.apple.com.cn/shop/goto/account';
      await this.page
        .goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(() => this.log('navigation_pending'));
      const observeFrom = Date.now();
      while (
        !this.isStopRequested() &&
        !this.stopped &&
        Date.now() - this.started < LIMITS.observationMs
      ) {
        if (this.detailCandidate) {
          await this.observeDetailCandidate();
          break;
        }
        const ready = await this.waitForSiteReady();
        if (this.isStopRequested()) break;
        if (this.detailCandidate) continue;
        if (!ready && Date.now() - observeFrom > LIMITS.siteReadyMs)
          throw fail('SITE_READINESS_TIMEOUT');
        if (ready) await this.loginStep();
        if (this.isStopRequested() || this.stopped) break;
        if (this.detailCandidate) continue;
        if (this.targetDetailUrl && !this.detailOpened) {
          this.detailOpened = true;
          this.log('target_order_opened');
          await this.page.goto(this.targetDetailUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
        }
        if (this.orderListSeen && !this.targetDetailUrl && !this.guestOpened) {
          if (this.isStopRequested()) break;
          this.guestOpened = true;
          this.log('target_missing_from_account_list');
          await this.page.goto(this.sample.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        }
        await delay(LIMITS.loopPollMs);
      }
      if (!this.stopped)
        this.stop(
          this.captureReceipt &&
            this.detailCandidate &&
            Date.now() - this.started >= LIMITS.observationMs
            ? 'TIME_BUDGET'
            : 'NO_VALID_ORDER_DATA'
        );
    } catch (error) {
      error.component = 'officialOrderCollector';
      throw error;
    }
  }

  saveOrderResult() {
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
    const resultFile = path.join(
      this.root,
      'private/results',
      `order-${this.sample.id}-run-${this.id}.json`
    );
    writePrivate(resultFile, JSON.stringify(output, null, LIMITS.jsonIndent));
    return resultFile;
  }

  async collectAccount() {
    try {
      let first = true;
      for (const sample of this.samples) {
        if (this.isStopRequested()) break;
        if (this.accountResults.some(result => result.orderId === sample.id)) continue;
        if (!first) {
          if (
            this.stopped &&
            !['SUCCEEDED', 'NO_VALID_ORDER_DATA', 'ORDER_ATTEMPT_LIMIT'].includes(this.stopped)
          )
            break;
          if (Date.now() - this.started >= LIMITS.observationMs) {
            this.stopped = 'TIME_BUDGET';
            break;
          }
          // 停止旧文档加载并清空旧请求归属，再改变目标订单；全局预算和登录标记不重置。
          await this.pageControl.send('Page.stopLoading');
          await Promise.allSettled([...this.pending]);
          this.requests.clear();
          if (this.isStopRequested()) break;
          if (this.stopped && !['SUCCEEDED', 'NO_VALID_ORDER_DATA'].includes(this.stopped)) break;
          try {
            this.id = await this.gate.startOrder(sample);
          } catch (error) {
            if (error.code !== 'ORDER_ATTEMPT_LIMIT') throw error;
            this.accountResults.push({ orderId: sample.id, outcome: error.code });
            continue;
          }
          if (this.stopped && !['SUCCEEDED', 'NO_VALID_ORDER_DATA'].includes(this.stopped)) break;
          this.directory = `${this.root}/evidence/run-${this.id}`;
          fs.mkdirSync(this.directory, { mode: 0o700 });
          this.sample = sample;
          this.stopped = null;
          this.result = undefined;
          this.resultEvidence = undefined;
          this.detailCandidate = null;
          this.detailCandidateState = null;
          this.ignoredDetailCandidates = 0;
          this.targetDetailUrl = undefined;
          this.detailOpened = false;
          this.guestOpened = true;
          this.orderListSeen = false;
          this.accountNavigated = false;
        }
        await this.collectCurrent(first);
        const result = {
          orderId: sample.id,
          outcome: this.stopped,
          runId: Number(this.id),
          attempted: true,
        };
        if (this.stopped === 'SUCCEEDED' && this.result) result.resultFile = this.saveOrderResult();
        if (this.captureReceipt && result.outcome === 'SUCCEEDED') {
          if (!this.isStopRequested()) result.receipt = await collectBrowserReceipt(this);
        }
        this.isStopRequested();
        this.accountResults.push(result);
        // 详情运行已由 collectBrowserReceipt 关闭；当前 gate 可能已指向独立收据运行。
        // 不能用为保留详情而重置的 this.stopped='SUCCEEDED' 覆盖收据的真实结果。
        let runOutcome = this.stopped;
        const receiptRunId = Number(result.receipt?.runId);
        const activeRunId = Number(this.gate.id);
        if ((activeRunId && activeRunId !== Number(this.id)) || receiptRunId) {
          if (
            !Number.isSafeInteger(receiptRunId) ||
            receiptRunId <= 0 ||
            receiptRunId !== activeRunId
          )
            throw fail('RECEIPT_RUN_MISMATCH');
          if (!this.stopped || this.stopped === 'SUCCEEDED') {
            const receiptOutcome = result.receipt?.outcome;
            runOutcome =
              receiptOutcome === 'RECEIPT_CAPTURED'
                ? 'SUCCEEDED'
                : receiptOutcome !== 'SUCCEEDED' && /^[A-Z][A-Z0-9_]+$/.test(receiptOutcome || '')
                  ? receiptOutcome
                  : 'RECEIPT_CAPTURE_FAILED';
          }
        }
        await this.gate.recordFailure(runOutcome, this.retryAfter);
        await this.gate.finishOrder(runOutcome);
        if (
          result.receipt &&
          [
            'HTTP_407',
            'HTTP_429',
            'HTTP_541',
            'PROXY_CONNECTION_FAILED',
            'PROXY_LEASE_EXPIRED',
            'RECEIPT_SESSION_REDIRECT',
            'REQUEST_BUDGET',
            'STATE_WRITE_FAILED',
            'TIME_BUDGET',
          ].includes(result.receipt.outcome)
        ) {
          this.stopped = result.receipt.outcome;
          break;
        }
        first = false;
      }
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
      await this.prepareHttpLogin();
      if (this.accountMode) await this.collectAccount();
      else await this.collectCurrent();
      await this.captureAuthDiagnostic();
      // 会话保存不将旧数据改成新观测；失败结果单列，旧成功文件保持。
      if (
        !['AUTH_REJECTED', 'AUTH_PRECONDITION_REQUIRED', 'HUMAN_VERIFICATION_REQUIRED'].includes(
          this.stopped
        )
      ) {
        await this.saveSession();
      }
      if (!this.accountMode && this.result && this.stopped === 'SUCCEEDED') {
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
        if (this.captureReceipt) this.receiptResult = await collectBrowserReceipt(this);
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
      if (
        this.accountMode &&
        this.gate.id &&
        !this.accountResults.some(item => item.orderId === this.sample.id)
      ) {
        this.accountResults.push({
          orderId: this.sample.id,
          outcome: this.stopped,
          runId: Number(this.gate.id),
          attempted: true,
        });
      }
    } finally {
      this.isStopRequested();
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
      if (this.proxyTunnel) {
        await this.proxyTunnel.close().catch(() => {
          this.stopped = 'PROXY_TUNNEL_CLOSE_FAILED';
        });
      }
      await Promise.allSettled([...this.pending]);
      if (this.id) {
        await this.gate.recordFailure(this.stopped, this.retryAfter).catch(() => {
          this.stopped = 'STATE_WRITE_FAILED';
        });
      }
      await this.gate.close(this.stopped || 'INITIALIZATION_FAILED').catch(() => {
        this.stopped = 'STATE_WRITE_FAILED';
      });
      if (this.accountMode) {
        for (const sample of this.samples) {
          if (!this.accountResults.some(result => result.orderId === sample.id))
            this.accountResults.push({
              orderId: sample.id,
              outcome:
                this.stopped === 'SUCCEEDED' ? 'TIME_BUDGET' : this.stopped || 'COLLECTOR_FAILED',
            });
        }
      }
      const summaryRunId = Number(this.id);
      const validSummaryRunId = Number.isSafeInteger(summaryRunId) && summaryRunId > 0;
      if (!validSummaryRunId && this.stopped === 'SUCCEEDED')
        this.stopped = 'COLLECTOR_IDENTITY_INVALID';
      summary = {
        runId: validSummaryRunId ? summaryRunId : null,
        systemOrderId: this.sample.id,
        outcome:
          this.stopped && this.stopped !== 'SUCCEEDED'
            ? this.stopped
            : this.accountMode
              ? this.accountResults.every(result => result.outcome === 'SUCCEEDED')
                ? 'SUCCEEDED'
                : 'PARTIAL'
              : this.stopped || 'INITIALIZATION_FAILED',
        ...(this.accountMode ? { results: this.accountResults } : {}),
        requests: this.gate.requests,
        passwordSubmitted: this.passwordSubmitted,
        serverSessionRestored: !!this.sessionRestored,
        authDiagnostic: this.authDiagnostic,
        ...(this.receiptResult ? { receipt: this.receiptResult } : {}),
        resultFile: this.resultFile,
        result:
          !this.accountMode && this.result && this.stopped === 'SUCCEEDED'
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
