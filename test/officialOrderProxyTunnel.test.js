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
      socket.once('close', () => resolve(output));
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

async function waitUntil(predicate) {
  try {
    const deadline = Date.now() + 1500;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('TEST_CONDITION_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } catch (error) {
    error.component = 'proxyTunnelWaitTest';
    throw error;
  }
}

async function openClient(authority, payload = '') {
  try {
    const socket = net.connect(tunnelPort, '127.0.0.1');
    let output = '';
    socket.on('error', () => {});
    socket.on('data', bytes => {
      output += bytes.toString();
    });
    const closed = new Promise(resolve => socket.once('close', resolve));
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n${payload}`);
    return { socket, closed, output: () => output };
  } catch (error) {
    error.component = 'proxyTunnelClientTest';
    throw error;
  }
}

function delayedProxy() {
  const connections = [];
  server.removeAllListeners('connect');
  server.on('connect', (request, socket, head) => {
    received.push({ url: request.url, headers: request.headers });
    const connection = { socket, payloadBytes: head.length };
    socket.on('data', bytes => {
      connection.payloadBytes += bytes.length;
    });
    connections.push(connection);
  });
  return connections;
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
  jest.restoreAllMocks();
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

test.each([407, 410, 429, 541, 502])('上游 %i 明确失败，不重试、不暴露认证', async status => {
  responseStatus = status;
  const output = await exchange('idmsa.apple.com.cn:443');
  expect(output).toContain('502');
  expect(received).toHaveLength(1);
  expect(onFailure).toHaveBeenCalledWith(
    [410, 502].includes(status) ? 'PROXY_CONNECTION_FAILED' : `HTTP_${status}`,
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

test('同一槽最多建立指定数量的上游连接，释放后排队继续', async () => {
  tunnel.connectionLimit = 1;
  const first = net.connect(tunnelPort, '127.0.0.1');
  await new Promise(resolve => first.once('connect', resolve));
  first.write('CONNECT www.apple.com.cn:443 HTTP/1.1\r\nHost: www.apple.com.cn\r\n\r\n');
  await new Promise(resolve => first.once('data', resolve));
  const second = exchange('idmsa.apple.com.cn:443', 'second');
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(received).toHaveLength(1);
  expect(tunnel.activeConnections).toBe(1);
  expect(tunnel.waiting).toHaveLength(1);
  first.destroy();
  expect(await second).toContain('second');
  expect(received).toHaveLength(2);
});

test('非法连接上限拒绝，不默默恢复无限并发', () => {
  for (const maxConnections of [0, 65, 1.5, '4']) {
    expect(() => new OfficialOrderProxyTunnel({ maxConnections })).toThrow(
      'PROXY_CONNECTION_LIMIT_INVALID'
    );
  }
});

test('容量占满只回收无在途请求的空闲主机连接，其他主机可继续', async () => {
  tunnel.connectionLimit = 1;
  let idle = false;
  tunnel.canReleaseHost = host => idle && host === 'www.apple.com.cn';
  const first = net.connect(tunnelPort, '127.0.0.1');
  await new Promise(resolve => first.once('connect', resolve));
  first.write('CONNECT www.apple.com.cn:443 HTTP/1.1\r\nHost: www.apple.com.cn\r\n\r\n');
  await new Promise(resolve => first.once('data', resolve));
  const second = exchange('idmsa.apple.com.cn:443', 'continued');
  await new Promise(resolve => setTimeout(resolve, 25));
  for (const state of tunnel.established.values()) state.lastActivity -= 2000;
  tunnel.releaseIdleConnection();
  expect(received).toHaveLength(1);
  expect(first.destroyed).toBe(false);
  idle = true;
  tunnel.releaseIdleConnection();
  expect(await second).toContain('continued');
  expect(received).toHaveLength(2);
  expect(onFailure).not.toHaveBeenCalled();
  first.destroy();
});

test.each([410, 407, 429, 541, 502])(
  '上游 %i 失败先同步终止全部连接，排队项不再 CONNECT',
  async status => {
    tunnel.connectionLimit = 1;
    const connections = delayedProxy();
    const first = await openClient('www.apple.com.cn:443', 'first-secret-payload');
    await waitUntil(() => connections.length === 1);
    const second = await openClient('idmsa.apple.com.cn:443', 'queued-secret-payload');
    await waitUntil(() => tunnel.waiting.length === 1);
    let stoppedState;
    onFailure.mockImplementation(() => {
      stoppedState = {
        closing: tunnel.closing,
        waiting: tunnel.waiting.length,
        socketsDestroyed: [...tunnel.sockets].every(socket => socket.destroyed),
        requestsDestroyed: [...tunnel.requests].every(request => request.destroyed),
        listening: tunnel.server.listening,
      };
    });
    connections[0].socket.write(`HTTP/1.1 ${status} Failed\r\nRetry-After: 3600\r\n\r\n`);
    await Promise.all([first.closed, second.closed, tunnel.closePromise]);
    await tunnel.close();
    await waitUntil(() => tunnel.activeConnections === 0 && tunnel.requests.size === 0);
    expect(stoppedState).toEqual({
      closing: true,
      waiting: 0,
      socketsDestroyed: true,
      requestsDestroyed: true,
      listening: false,
    });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(
      [410, 502].includes(status) ? 'PROXY_CONNECTION_FAILED' : `HTTP_${status}`,
      '3600'
    );
    expect(received).toHaveLength(1);
    expect(connections[0].payloadBytes).toBe(0);
    expect(second.output()).not.toContain('200 Connection Established');
    await expect(tunnel.start()).rejects.toThrow('PROXY_TUNNEL_START_FAILED');
    expect(received).toHaveLength(1);
  }
);

test('单路失败同步关闭其他已建立通道并取消等待队列', async () => {
  tunnel.connectionLimit = 2;
  const connections = delayedProxy();
  const first = await openClient('www.apple.com.cn:443');
  await waitUntil(() => connections.length === 1);
  connections[0].socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  await waitUntil(() => tunnel.established.size === 1);
  const second = await openClient('idmsa.apple.com.cn:443');
  await waitUntil(() => connections.length === 2);
  const third = await openClient('secure7.www.apple.com.cn:443', 'never-forward');
  await waitUntil(() => tunnel.waiting.length === 1);
  const established = [...tunnel.established.keys()];
  onFailure.mockImplementation(() => {
    expect(established.every(socket => socket.destroyed)).toBe(true);
    expect(tunnel.waiting).toHaveLength(0);
  });
  connections[1].socket.write('HTTP/1.1 410 Gone\r\n\r\n');
  await Promise.all([first.closed, second.closed, third.closed]);
  await tunnel.close();
  await waitUntil(() => tunnel.activeConnections === 0 && tunnel.established.size === 0);
  expect(received).toHaveLength(2);
  expect(connections.every(connection => connection.payloadBytes === 0)).toBe(true);
  expect(onFailure).toHaveBeenCalledTimes(1);
});

test('并发两路错误只通知一次，迟到的 200 不恢复转发或发送 head', async () => {
  tunnel.connectionLimit = 2;
  const connections = delayedProxy();
  const first = await openClient('www.apple.com.cn:443');
  const second = await openClient('idmsa.apple.com.cn:443', 'late-head-secret');
  await waitUntil(() => connections.length === 2 && tunnel.requests.size === 2);
  const requests = [...tunnel.requests];
  connections[0].socket.write('HTTP/1.1 410 Gone\r\n\r\n');
  await waitUntil(() => onFailure.mock.calls.length === 1);
  requests[1].emit('error', new Error('SYNTHETIC_LATE_ERROR'));
  const lateSocket = new net.Socket();
  const write = jest.spyOn(lateSocket, 'write');
  const pipe = jest.spyOn(lateSocket, 'pipe');
  requests[1].emit('connect', { statusCode: 200, headers: {} }, lateSocket, Buffer.from('late'));
  await Promise.all([first.closed, second.closed, tunnel.close(), tunnel.close()]);
  expect(lateSocket.destroyed).toBe(true);
  expect(write).not.toHaveBeenCalled();
  expect(pipe).not.toHaveBeenCalled();
  expect(second.output()).not.toContain('200 Connection Established');
  expect(received).toHaveLength(2);
  expect(connections.every(connection => connection.payloadBytes === 0)).toBe(true);
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect(tunnel.server.listening).toBe(false);
});

test.each(['connect', 'capacity'])('%s 超时同步终止通道，关闭取消定时器且不出队', async kind => {
  tunnel.connectionLimit = 1;
  const connections = delayedProxy();
  const timers = [];
  const nativeTimeout = global.setTimeout;
  jest.spyOn(global, 'setTimeout').mockImplementation((callback, ms, ...args) => {
    if (ms === 15000) timers.push(callback);
    return nativeTimeout(callback, ms, ...args);
  });
  const first = await openClient('www.apple.com.cn:443');
  await waitUntil(() => connections.length === 1);
  if (kind === 'capacity') {
    connections[0].socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    await waitUntil(() => tunnel.established.size === 1);
  }
  const second = await openClient('idmsa.apple.com.cn:443', 'timeout-never-forward');
  await waitUntil(() => tunnel.waiting.length === 1);
  timers[kind === 'connect' ? 0 : timers.length - 1]();
  expect(tunnel.closing).toBe(true);
  expect(tunnel.waiting).toHaveLength(0);
  expect([...tunnel.sockets].every(socket => socket.destroyed)).toBe(true);
  await Promise.all([first.closed, second.closed, tunnel.close()]);
  expect(received).toHaveLength(1);
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect(onFailure).toHaveBeenCalledWith(
    kind === 'connect' ? 'PROXY_CONNECTION_FAILED' : 'PROXY_CAPACITY_WAIT_TIMEOUT',
    undefined
  );
  expect(tunnel.server.listening).toBe(false);
});

test('listen 尚未完成即关闭，也不留下迟到监听或允许重新启动', async () => {
  await tunnel.close();
  tunnel = new OfficialOrderProxyTunnel({
    host: '127.0.0.1',
    port: server.address().port,
    username: 'test-user',
    password: 'test-password',
  });
  const started = tunnel.start();
  const closed = tunnel.close();
  await expect(started).rejects.toThrow('PROXY_TUNNEL_START_FAILED');
  await closed;
  await tunnel.close();
  expect(tunnel.server.listening).toBe(false);
  expect(received).toHaveLength(0);
});

test('失败时关闭错误不产生未处理拒绝，显式 close 仍报告固定错误', async () => {
  const failed = new OfficialOrderProxyTunnel({}, onFailure);
  failed.server = {
    listening: true,
    close(callback) {
      process.nextTick(() => callback(new Error('SYNTHETIC_CLOSE_ERROR')));
    },
  };
  failed.fail('PROXY_CONNECTION_FAILED');
  await new Promise(resolve => setImmediate(resolve));
  await expect(failed.close()).rejects.toThrow('PROXY_TUNNEL_CLOSE_FAILED');
  await expect(failed.close()).rejects.toThrow('PROXY_TUNNEL_CLOSE_FAILED');
  expect(onFailure).toHaveBeenCalledTimes(1);
});
