const http = require('http');
const { fault, permittedUrl } = require('./officialOrderSupport');

const CONNECT_TIMEOUT_MS = 15000;
const SOCKET_TIMEOUT_MS = 190000;
const MAX_CONNECTIONS = 64;
const IDLE_RECHECK_MS = 250;
const IDLE_RELEASE_MS = 1000;
const HTTP_STATUS = Object.freeze({
  ok: 200,
  denied: 403,
  failed: 502,
  proxyAuth: 407,
  rateLimited: 429,
  risk: 541,
});
const RISK_STATUSES = new Set([HTTP_STATUS.proxyAuth, HTTP_STATUS.rateLimited, HTTP_STATUS.risk]);

/**
 * 为不返回标准 407 挑战的上游提供预先认证的 CONNECT 通道。
 * 仅绑定容器回环；不解密 TLS、不转发来客认证头、不允许非官方目的域。
 */
class OfficialOrderProxyTunnel {
  constructor(proxy, onFailure = () => {}, canReleaseHost = () => false) {
    this.proxy = proxy;
    this.onFailure = onFailure;
    this.sockets = new Set();
    this.requests = new Set();
    this.closing = false;
    this.connectionLimit = proxy.maxConnections ?? MAX_CONNECTIONS;
    if (
      !Number.isInteger(this.connectionLimit) ||
      this.connectionLimit < 1 ||
      this.connectionLimit > MAX_CONNECTIONS
    )
      throw fault('PROXY_CONNECTION_LIMIT_INVALID');
    this.activeConnections = 0;
    this.waiting = [];
    this.canReleaseHost = canReleaseHost;
    this.established = new Map();
  }

  track(socket) {
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.once('end', () => socket.destroy());
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
  }

  reject(socket, status) {
    if (!socket.destroyed) {
      socket.end(`HTTP/1.1 ${status} Connection Failed\r\nConnection: close\r\n\r\n`);
    }
  }

  // 先同步锁死转发和释放队列，再通知采集器；通知不能替代连接取消。
  fail(code, retryAfter, client) {
    if (this.closing) return;
    this.closing = true;
    if (client) this.reject(client, HTTP_STATUS.failed);
    this.shutdown();
    this.onFailure(code, retryAfter);
  }

  shutdown() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearInterval(this.idleTimer);
    const waiting = this.waiting.splice(0);
    for (const pending of waiting) {
      clearTimeout(pending.timer);
      pending.client.destroy();
    }
    for (const request of this.requests) request.destroy();
    for (const socket of this.sockets) socket.destroy();
    // 此 Promise 只完成、不拒绝，失败回调可同步调用而不会产生未处理拒绝。
    // 最终 close() 仍会报告服务器关闭错误，并等待同一个关闭过程。
    this.closePromise = new Promise(resolve => {
      if (!this.server?.listening) {
        resolve();
        return;
      }
      try {
        this.server.close(error => {
          this.closeFailed = !!error;
          resolve();
        });
      } catch (_error) {
        this.closeFailed = true;
        resolve();
      }
    });
    return this.closePromise;
  }

  releaseIdleConnection() {
    if (this.closing || !this.waiting.length) return;
    for (const [socket, state] of this.established) {
      if (
        !socket.destroyed &&
        Date.now() - state.lastActivity >= IDLE_RELEASE_MS &&
        this.canReleaseHost(state.host)
      ) {
        socket.destroy();
        return;
      }
    }
  }

  connect(request, client, head) {
    client.pause();
    if (this.closing) return client.destroy();
    if (this.activeConnections >= this.connectionLimit) {
      const pending = { request, client, head };
      this.waiting.push(pending);
      pending.timer = setTimeout(() => {
        this.fail('PROXY_CAPACITY_WAIT_TIMEOUT', undefined, client);
      }, CONNECT_TIMEOUT_MS);
      client.once('close', () => {
        clearTimeout(pending.timer);
        this.waiting = this.waiting.filter(item => item !== pending);
      });
      return;
    }
    this.activeConnections += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeConnections -= 1;
      while (
        !this.closing &&
        this.waiting.length &&
        this.activeConnections < this.connectionLimit
      ) {
        const next = this.waiting.shift();
        clearTimeout(next.timer);
        if (!next.client.destroyed) this.connect(next.request, next.client, next.head);
      }
    };
    this.openConnection(request, client, head, release);
  }

  openConnection(request, client, head, release) {
    try {
      if (this.closing || !/^[a-z0-9.-]+:443$/i.test(request.url)) {
        throw fault('DESTINATION_DENIED');
      }
      permittedUrl(`https://${request.url}/`);
    } catch (_error) {
      this.reject(client, HTTP_STATUS.denied);
      release();
      return;
    }
    client.pause();
    let upstreamSocket;
    let settled = false;
    const fail = (code, retryAfter) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.fail(code, retryAfter, client);
    };
    const upstream = http.request({
      host: this.proxy.host,
      port: this.proxy.port,
      method: 'CONNECT',
      path: request.url,
      agent: false,
      headers: {
        Host: request.url,
        'Proxy-Authorization': `Basic ${Buffer.from(
          `${this.proxy.username}:${this.proxy.password}`
        ).toString('base64')}`,
      },
    });
    this.requests.add(upstream);
    upstream.once('close', () => {
      this.requests.delete(upstream);
      if (!upstreamSocket) release();
    });
    const timer = setTimeout(() => fail('PROXY_CONNECTION_FAILED'), CONNECT_TIMEOUT_MS);
    upstream.on('error', () => fail('PROXY_CONNECTION_FAILED'));
    client.once('close', () => {
      clearTimeout(timer);
      settled = true;
      upstream.destroy();
      upstreamSocket?.destroy();
    });
    upstream.once('connect', (response, socket, responseHead) => {
      upstreamSocket = socket;
      this.track(socket);
      socket.once('close', release);
      if (settled || client.destroyed || this.closing) {
        clearTimeout(timer);
        socket.destroy();
        return;
      }
      if (response.statusCode !== HTTP_STATUS.ok) {
        fail(
          RISK_STATUSES.has(response.statusCode)
            ? `HTTP_${response.statusCode}`
            : 'PROXY_CONNECTION_FAILED',
          response.headers['retry-after']
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      upstreamSocket = socket;
      const state = { host: request.url.replace(/:443$/, ''), lastActivity: Date.now() };
      this.established.set(socket, state);
      const touch = () => {
        state.lastActivity = Date.now();
      };
      socket.on('data', touch);
      client.on('data', touch);
      socket.once('close', () => {
        this.established.delete(socket);
        client.removeListener('data', touch);
      });
      socket.once('error', () => client.destroy());
      socket.once('close', () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (responseHead.length) client.write(responseHead);
      if (head.length) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
      client.resume();
    });
    upstream.end();
  }

  /** 启动一次运行专用的回环监听，返回浏览器代理地址。 */
  async start() {
    try {
      if (this.closing || this.server) throw fault('PROXY_TUNNEL_START_FAILED');
      this.server = http.createServer((_request, response) => {
        response.writeHead(HTTP_STATUS.denied, { Connection: 'close' });
        response.end();
      });
      this.server.maxConnections = MAX_CONNECTIONS;
      this.server.on('connection', socket => this.track(socket));
      this.server.on('connect', (request, socket, head) => this.connect(request, socket, head));
      this.server.on('clientError', (_error, socket) => socket.destroy());
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(0, '127.0.0.1', resolve);
      });
      if (this.closing) {
        // close() 可能早于 listen 回调；刚出现的监听也必须结束，不能复用已完成的关闭。
        if (this.server.listening) this.closePromise = undefined;
        throw fault('PROXY_TUNNEL_START_FAILED');
      }
      this.idleTimer = setInterval(() => this.releaseIdleConnection(), IDLE_RECHECK_MS);
      this.idleTimer.unref();
      return `http://127.0.0.1:${this.server.address().port}`;
    } catch (_error) {
      await this.close();
      throw fault('PROXY_TUNNEL_START_FAILED');
    }
  }

  /** 销毁本次运行的所有连接，不保留后台转发进程。 */
  async close() {
    try {
      await this.shutdown();
      if (this.closeFailed) throw fault('PROXY_TUNNEL_CLOSE_FAILED');
    } catch (_error) {
      throw fault('PROXY_TUNNEL_CLOSE_FAILED');
    }
  }
}

module.exports = OfficialOrderProxyTunnel;
