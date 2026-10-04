const http = require('http');
const { fault, permittedUrl } = require('./officialOrderSupport');

const CONNECT_TIMEOUT_MS = 15000;
const SOCKET_TIMEOUT_MS = 190000;
const MAX_CONNECTIONS = 64;
const HTTP_STATUS = Object.freeze({
  ok: 200,
  denied: 403,
  failed: 502,
  proxyAuth: 407,
  rateLimited: 429,
  risk: 541,
});
const RISK_STATUSES = new Set([
  HTTP_STATUS.proxyAuth,
  HTTP_STATUS.rateLimited,
  HTTP_STATUS.risk,
]);

/**
 * 为不返回标准 407 挑战的上游提供预先认证的 CONNECT 通道。
 * 仅绑定容器回环；不解密 TLS、不转发来客认证头、不允许非官方目的域。
 */
class OfficialOrderProxyTunnel {
  constructor(proxy, onFailure = () => {}) {
    this.proxy = proxy;
    this.onFailure = onFailure;
    this.sockets = new Set();
    this.requests = new Set();
    this.closing = false;
  }

  track(socket) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
  }

  reject(socket, status) {
    if (!socket.destroyed) {
      socket.end(`HTTP/1.1 ${status} Connection Failed\r\nConnection: close\r\n\r\n`);
    }
  }

  connect(request, client, head) {
    try {
      if (this.closing || !/^[a-z0-9.-]+:443$/i.test(request.url)) {
        throw fault('DESTINATION_DENIED');
      }
      permittedUrl(`https://${request.url}/`);
    } catch (_error) {
      this.reject(client, HTTP_STATUS.denied);
      return;
    }
    client.pause();
    let upstreamSocket;
    let settled = false;
    const fail = (code, retryAfter) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      upstream.destroy();
      if (!this.closing) this.onFailure(code, retryAfter);
      this.reject(client, HTTP_STATUS.failed);
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
    upstream.once('close', () => this.requests.delete(upstream));
    const timer = setTimeout(() => fail('PROXY_CONNECTION_FAILED'), CONNECT_TIMEOUT_MS);
    upstream.on('error', () => fail('PROXY_CONNECTION_FAILED'));
    client.once('close', () => {
      clearTimeout(timer);
      settled = true;
      upstream.destroy();
      upstreamSocket?.destroy();
    });
    upstream.once('connect', (response, socket, responseHead) => {
      if (settled || client.destroyed || this.closing) {
        socket.destroy();
        return;
      }
      if (response.statusCode !== HTTP_STATUS.ok) {
        socket.destroy();
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
      this.track(socket);
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
      return `http://127.0.0.1:${this.server.address().port}`;
    } catch (_error) {
      await this.close();
      throw fault('PROXY_TUNNEL_START_FAILED');
    }
  }

  /** 销毁本次运行的所有连接，不保留后台转发进程。 */
  async close() {
    try {
      this.closing = true;
      for (const request of this.requests) request.destroy();
      for (const socket of this.sockets) socket.destroy();
      if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
    } catch (_error) {
      throw fault('PROXY_TUNNEL_CLOSE_FAILED');
    }
  }
}

module.exports = OfficialOrderProxyTunnel;
