const path = require('path');
const { spawn } = require('child_process');
const { fault, permittedUrl } = require('./officialOrderSupport');

const CURL_CFFI_VERSION = '0.16.3';
const DEFAULT_IMPERSONATE = 'chrome150';
const LIMITS = Object.freeze({
  timeoutMs: 30000,
  startupMs: 10000,
  closeMs: 2000,
  responseBytes: 4194304,
  protocolBytes: 5767168,
  requestBytes: 1048576,
  headers: 100,
  headerBytes: 8192,
  urlBytes: 16384,
  port: 65535,
  proxyTextBytes: 4096,
  maximumBase64Bytes: 2097152,
  minimumStatus: 100,
  maximumStatus: 599,
  headerPairLength: 2,
});
const RESERVED_HEADERS = new Set([
  'host',
  'proxy-authorization',
  'proxy-connection',
  'connection',
  'content-length',
  'transfer-encoding',
  'user-agent',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
]);
const ERROR_CODES = new Set([
  'DESTINATION_DENIED',
  'HTTP_PROXY_INVALID',
  'HTTP_INIT_INVALID',
  'HTTP_PROFILE_UNSUPPORTED',
  'HTTP_DEPENDENCY_MISSING',
  'HTTP_DEPENDENCY_VERSION',
  'HTTP_REQUEST_INVALID',
  'HTTP_HEADERS_INVALID',
  'HTTP_REQUEST_BODY_INVALID',
  'HTTP_NOT_INITIALIZED',
  'HTTP_RESPONSE_TOO_LARGE',
  'HTTP_RESPONSE_METADATA_TOO_LARGE',
  'HTTP_COOKIE_METADATA_INVALID',
  'HTTP_UNEXPECTED_REDIRECT',
  'HTTP_TIMEOUT',
  'HTTP_TLS_FAILED',
  'PROXY_CONNECTION_FAILED',
  'HTTP_TRANSPORT_FAILED',
  'HTTP_PROTOCOL_INVALID',
  'HTTP_PROTOCOL_FAILED',
  'HTTP_407',
  'HTTP_429',
  'HTTP_541',
  'HTTP_TRANSPORT_CLOSED',
  'HTTP_TRANSPORT_STOPPED',
  'HTTP_REQUEST_IN_PROGRESS',
  'HTTP_PROCESS_FAILED',
  'HTTP_PROCESS_EXITED',
  'REQUEST_STOPPED',
  'REQUEST_BUDGET',
  'TIME_BUDGET',
  'ACCOUNT_BUSY',
  'ACCOUNT_COOLDOWN',
  'LOGIN_COOLDOWN',
  'PROXY_COOLDOWN',
  'PROXY_LEASE_EXPIRED',
  'ORDER_ATTEMPT_LIMIT',
]);
// 协议字段中的控制字符不属于业务文本。
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function validateUrl(value) {
  if (
    typeof value !== 'string' ||
    value.length > LIMITS.urlBytes ||
    CONTROL.test(value) ||
    /[\s\\]/.test(value)
  )
    throw fault('DESTINATION_DENIED');
  const url = permittedUrl(value);
  if (url.hash) throw fault('DESTINATION_DENIED');
  return url.href;
}

function validateProxy(proxy) {
  if (
    !proxy ||
    typeof proxy.host !== 'string' ||
    !/^[a-z0-9.-]{1,253}$/i.test(proxy.host) ||
    !Number.isInteger(Number(proxy.port)) ||
    Number(proxy.port) < 1 ||
    Number(proxy.port) > LIMITS.port ||
    ['username', 'password'].some(
      key =>
        typeof proxy[key] !== 'string' ||
        !proxy[key] ||
        proxy[key].length > LIMITS.proxyTextBytes ||
        CONTROL.test(proxy[key])
    )
  )
    throw fault('HTTP_PROXY_INVALID');
  return {
    host: proxy.host,
    port: Number(proxy.port),
    username: proxy.username,
    password: proxy.password,
  };
}

function requestInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw fault('HTTP_REQUEST_INVALID');
  const url = validateUrl(input.url);
  const { method = 'GET', headers = {}, timeoutMs = LIMITS.timeoutMs } = input;
  if (
    !['GET', 'HEAD', 'POST'].includes(method) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > LIMITS.timeoutMs
  )
    throw fault('HTTP_REQUEST_INVALID');
  const names = new Set();
  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    throw fault('HTTP_HEADERS_INVALID');
  const entries = Object.entries(headers);
  if (entries.length > LIMITS.headers) throw fault('HTTP_HEADERS_INVALID');
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
      RESERVED_HEADERS.has(lower) ||
      names.has(lower) ||
      typeof value !== 'string' ||
      value.length > LIMITS.headerBytes ||
      CONTROL.test(value)
    )
      throw fault('HTTP_HEADERS_INVALID');
    names.add(lower);
  }
  if (input.body != null && input.bodyBase64 != null) throw fault('HTTP_REQUEST_BODY_INVALID');
  let bytes;
  if (input.bodyBase64 != null) {
    if (typeof input.bodyBase64 !== 'string' || input.bodyBase64.length > LIMITS.maximumBase64Bytes)
      throw fault('HTTP_REQUEST_BODY_INVALID');
    bytes = Buffer.from(input.bodyBase64, 'base64');
    if (bytes.toString('base64') !== input.bodyBase64) throw fault('HTTP_REQUEST_BODY_INVALID');
  } else if (input.body != null) {
    if (typeof input.body !== 'string' && !Buffer.isBuffer(input.body))
      throw fault('HTTP_REQUEST_BODY_INVALID');
    bytes = Buffer.from(input.body);
  }
  if (bytes && (bytes.length > LIMITS.requestBytes || method !== 'POST'))
    throw fault('HTTP_REQUEST_BODY_INVALID');
  return {
    url,
    method,
    headers: Object.fromEntries(entries),
    bodyBase64: bytes ? bytes.toString('base64') : null,
    timeoutMs,
  };
}

function responseOutput(value, expectedUrl) {
  let actualUrl;
  try {
    actualUrl = validateUrl(value?.url);
  } catch (_error) {
    throw fault('HTTP_PROTOCOL_INVALID');
  }
  if (
    !value ||
    !Number.isInteger(value.status) ||
    value.status < LIMITS.minimumStatus ||
    value.status > LIMITS.maximumStatus ||
    actualUrl !== expectedUrl ||
    !Array.isArray(value.rawHeaders) ||
    !Array.isArray(value.cookies) ||
    typeof value.bodyBase64 !== 'string'
  )
    throw fault('HTTP_PROTOCOL_INVALID');
  const bytes = Buffer.from(value.bodyBase64, 'base64');
  if (bytes.toString('base64') !== value.bodyBase64 || bytes.length > LIMITS.responseBytes)
    throw fault('HTTP_PROTOCOL_INVALID');
  const headers = Object.create(null);
  for (const pair of value.rawHeaders) {
    if (
      !Array.isArray(pair) ||
      pair.length !== LIMITS.headerPairLength ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'string' ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair[0]) ||
      CONTROL.test(pair[1])
    )
      throw fault('HTTP_PROTOCOL_INVALID');
    const key = pair[0].toLowerCase();
    if (key === 'set-cookie') (headers[key] ||= []).push(pair[1]);
    else headers[key] = headers[key] === undefined ? pair[1] : `${headers[key]}, ${pair[1]}`;
  }
  return { ...value, headers };
}

/**
 * 一个实例拥有一个 Python/curl_cffi 会话。所有返回字段均为私密证据，调用者负责密封。
 * 每次请求经过全局 gate；不会重试、自动跳转、伪造 UA 或并行发送。
 */
class OfficialOrderHttpTransport {
  constructor({
    gate,
    proxy,
    pythonPath = 'python3',
    impersonate = DEFAULT_IMPERSONATE,
    isStopped = () => false,
    spawnProcess = spawn,
  } = {}) {
    if (!gate || typeof gate.permit !== 'function' || typeof isStopped !== 'function')
      throw fault('HTTP_GATE_REQUIRED');
    if (impersonate !== DEFAULT_IMPERSONATE) throw fault('HTTP_PROFILE_UNSUPPORTED');
    this.gate = gate;
    this.proxy = validateProxy(proxy);
    this.pythonPath = pythonPath;
    this.impersonate = impersonate;
    this.isStopped = isStopped;
    this.spawnProcess = spawnProcess;
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    this.child = null;
    this.pending = null;
    this.ready = false;
    this.closed = false;
    this.busy = false;
    this.starting = null;
  }

  fail(code) {
    this.closed = true;
    this.ready = false;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(fault(code));
      this.pending = null;
    }
    this.child?.kill('SIGKILL');
  }

  receive(chunk) {
    if (this.closed) return;
    if (this.buffer.length + chunk.length > LIMITS.protocolBytes)
      return this.fail('HTTP_PROTOCOL_INVALID');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let offset;
    while ((offset = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.subarray(0, offset);
      this.buffer = this.buffer.subarray(offset + 1);
      try {
        const value = JSON.parse(line.toString('utf8'));
        if (!this.pending || value.id !== this.pending.id || typeof value.ok !== 'boolean')
          return this.fail('HTTP_PROTOCOL_INVALID');
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        if (value.ok) pending.resolve(value.result);
        else {
          const code = ERROR_CODES.has(value.code) ? value.code : 'HTTP_PROTOCOL_FAILED';
          pending.reject(fault(code));
          this.fail(code);
          return;
        }
      } catch (_error) {
        this.fail('HTTP_PROTOCOL_INVALID');
        return;
      }
    }
  }

  command(value, timeoutMs) {
    if (!this.child || this.closed) return Promise.reject(fault('HTTP_TRANSPORT_CLOSED'));
    if (this.pending) return Promise.reject(fault('HTTP_REQUEST_IN_PROGRESS'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('HTTP_TIMEOUT'), timeoutMs);
      this.pending = { id, resolve, reject, timer };
      try {
        this.child.stdin.write(JSON.stringify({ id, ...value }) + '\n', error => {
          if (error) this.fail('HTTP_PROCESS_FAILED');
        });
      } catch (_error) {
        this.fail('HTTP_PROCESS_FAILED');
      }
    });
  }

  /** 启动无秘密 argv/env 的子进程；代理配置只通过首次 stdin 消息传入。 */
  async start() {
    try {
      if (this.closed) throw fault('HTTP_TRANSPORT_CLOSED');
      if (this.ready) return { version: CURL_CFFI_VERSION, impersonate: this.impersonate };
      if (this.starting) return await this.starting;
      const env = Object.fromEntries(
        ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']
          .filter(key => process.env[key] !== undefined)
          .map(key => [key, process.env[key]])
      );
      this.child = this.spawnProcess(
        this.pythonPath,
        ['-I', '-u', path.resolve(__dirname, '../../scripts/officialOrder/httpTransport.py')],
        { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false }
      );
      this.child.stdout.on('data', chunk => this.receive(chunk));
      this.child.stderr.on('data', () => {});
      this.child.stdin.on('error', () => this.fail('HTTP_PROCESS_FAILED'));
      this.child.on('error', () => this.fail('HTTP_PROCESS_FAILED'));
      this.child.on('exit', () => this.fail('HTTP_PROCESS_EXITED'));
      this.starting = this.command(
        { op: 'init', proxy: this.proxy, impersonate: this.impersonate },
        LIMITS.startupMs
      );
      const result = await this.starting;
      if (this.closed) throw fault('HTTP_PROCESS_EXITED');
      if (result?.version !== CURL_CFFI_VERSION || result?.impersonate !== this.impersonate)
        throw fault('HTTP_DEPENDENCY_VERSION');
      this.ready = true;
      return result;
    } catch (error) {
      this.fail(ERROR_CODES.has(error.code) ? error.code : 'HTTP_PROCESS_FAILED');
      throw fault(ERROR_CODES.has(error.code) ? error.code : 'HTTP_PROCESS_FAILED');
    }
  }

  /** 每次请求先校验，再取得 PostgreSQL 全局许可；许可失败不写入子进程。 */
  async request(input) {
    if (this.busy) throw fault('HTTP_REQUEST_IN_PROGRESS');
    this.busy = true;
    try {
      const value = requestInput(input);
      if (this.closed || this.isStopped()) throw fault('HTTP_TRANSPORT_STOPPED');
      await this.start();
      await this.gate.permit(value.url, this.isStopped);
      if (this.closed || this.isStopped()) throw fault('HTTP_TRANSPORT_STOPPED');
      const response = await this.command({ op: 'request', ...value }, value.timeoutMs);
      if (this.closed) throw fault('HTTP_PROCESS_EXITED');
      return responseOutput(response, value.url);
    } catch (error) {
      if (error.code === 'HTTP_PROTOCOL_INVALID') this.fail(error.code);
      const code = ERROR_CODES.has(error.code) ? error.code : 'HTTP_TRANSPORT_FAILED';
      throw fault(code);
    } finally {
      this.busy = false;
    }
  }

  /** 关闭会话；在途请求立即中止且不重放。 */
  async close() {
    try {
      if (this.closed) return;
      if (this.pending || this.busy || !this.child) {
        this.fail('HTTP_TRANSPORT_CLOSED');
        return;
      }
      await this.command({ op: 'close' }, LIMITS.closeMs);
    } catch (_error) {
      // 结束阶段只保证销毁子进程，不把私密底层错误向外透传。
    } finally {
      this.fail('HTTP_TRANSPORT_CLOSED');
    }
  }
}

module.exports = { OfficialOrderHttpTransport, CURL_CFFI_VERSION, DEFAULT_IMPERSONATE };
