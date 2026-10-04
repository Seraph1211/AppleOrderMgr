/* eslint-disable no-magic-numbers -- 协议回归使用显式端口与状态码。 */
const http = require('http');
const net = require('net');
const OfficialOrderProxyTunnel = require('../src/services/officialOrderProxyTunnel');

let server;
let tunnel;
let sockets;
let received;
let onFailure;
let responseStatus;
let tunnelPort;

async function exchange(authority, payload = '') {
  try {
    return await new Promise((resolve, reject) => {
      const socket = net.connect(tunnelPort, '127.0.0.1');
      let output = '';
      socket.setTimeout(1500, () => socket.destroy(new Error('TEST_TIMEOUT')));
      socket.on('error', reject);
      socket.on('data', bytes => {
        output += bytes.toString();
        if (output.includes('\r\n\r\n') && (!payload || output.endsWith(payload))) {
          socket.destroy();
          resolve(output);
        }
      });
      socket.once('connect', () => {
        socket.write(
          `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
            `Proxy-Authorization: Basic client-secret\r\n\r\n${payload}`
        );
      });
    });
  } catch (error) {
    error.component = 'proxyTunnelTest';
    throw error;
  }
}

beforeEach(async () => {
  sockets = new Set();
  received = [];
  responseStatus = 200;
  onFailure = jest.fn();
  server = http.createServer();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, socket, head) => {
    received.push({ url: request.url, headers: request.headers });
    socket.write(`HTTP/1.1 ${responseStatus} Test\r\nRetry-After: 3600\r\n\r\n`);
    if (responseStatus !== 200) return socket.end();
    if (head.length) socket.write(head);
    socket.on('data', chunk => socket.write(chunk));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  tunnel = new OfficialOrderProxyTunnel(
    {
      host: '127.0.0.1',
      port: server.address().port,
      username: 'test-user',
      password: 'test-password',
    },
    onFailure
  );
  tunnelPort = Number(new URL(await tunnel.start()).port);
});

afterEach(async () => {
  await tunnel.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
});

test('回环通道预先提供上游认证，TLS 数据原样通过且不转发客户端认证', async () => {
  const result = await exchange('www.apple.com.cn:443', 'opaque-tls-test-bytes');
  expect(tunnel.server.address().address).toBe('127.0.0.1');
  expect(result).toBe('HTTP/1.1 200 Connection Established\r\n\r\nopaque-tls-test-bytes');
  expect(received).toHaveLength(1);
  expect(received[0].url).toBe('www.apple.com.cn:443');
  expect(received[0].headers['proxy-authorization']).toBe(
    `Basic ${Buffer.from('test-user:test-password').toString('base64')}`
  );
  expect(JSON.stringify(received)).not.toContain('client-secret');
  expect(result).not.toContain('test-password');
  expect(onFailure).not.toHaveBeenCalled();
});

test.each([
  'example.test:443',
  'apple.com.cn.evil.test:443',
  '127.0.0.1:443',
  'www.apple.com.cn:80',
  'user@www.apple.com.cn:443',
  'www.apple.com.cn:443/path',
])('拒绝非官方 HTTPS authority：%s', async authority => {
  expect(await exchange(authority)).toContain('403');
  expect(received).toHaveLength(0);
  expect(onFailure).not.toHaveBeenCalled();
});

test.each([407, 429, 541, 502])('上游 %i 明确失败，不重试、不暴露认证', async status => {
  responseStatus = status;
  const output = await exchange('idmsa.apple.com.cn:443');
  expect(output).toContain('502');
  expect(received).toHaveLength(1);
  expect(onFailure).toHaveBeenCalledWith(
    status === 502 ? 'PROXY_CONNECTION_FAILED' : `HTTP_${status}`,
    '3600'
  );
  expect(output).not.toContain('test-user');
});

test('拒绝普通 HTTP 转发', async () => {
  const status = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: tunnelPort, path: 'http://www.apple.com.cn/' }, response => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject);
  });
  expect(status).toBe(403);
  expect(received).toHaveLength(0);
});

test('上游连接断开终止，不泄露内部异常或再次连接', async () => {
  await new Promise(resolve => server.close(resolve));
  expect(await exchange('www.apple.com.cn:443')).toContain('502');
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect(onFailure).toHaveBeenCalledWith('PROXY_CONNECTION_FAILED', undefined);
});

test('关闭销毁活跃连接，重复关闭无后台进程', async () => {
  const socket = net.connect(tunnelPort, '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  await tunnel.close();
  await closed;
  await tunnel.close();
  expect(tunnel.server.listening).toBe(false);
});
