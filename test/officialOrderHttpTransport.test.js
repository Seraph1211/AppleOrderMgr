/* eslint-disable no-magic-numbers -- 协议边界回归使用明确字节数与状态码。 */
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const {
  OfficialOrderHttpTransport,
  CURL_CFFI_VERSION,
  DEFAULT_IMPERSONATE,
} = require('../src/services/officialOrderHttpTransport');

const URL = 'https://www.apple.com.cn/shop/order/list';
const PROXY = {
  host: 'proxy.example.test',
  port: 12345,
  username: 'private-user',
  password: 'private-password',
};
let transport;
let processStub;
let spawnProcess;
let commands;
let gate;
let handler;

function reply(request, result, extra = {}) {
  processStub.stdout.write(JSON.stringify({ id: request.id, ok: true, result, ...extra }) + '\n');
}

function response(request, changes = {}) {
  return {
    status: 200,
    url: request.url,
    bodyBase64: Buffer.from('private response').toString('base64'),
    rawHeaders: [['Content-Type', 'text/html']],
    cookies: [],
    ...changes,
  };
}

beforeEach(() => {
  commands = [];
  processStub = new EventEmitter();
  processStub.stdout = new PassThrough();
  processStub.stderr = new PassThrough();
  processStub.kill = jest.fn();
  handler = request => reply(request, response(request));
  processStub.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      commands.push(request);
      process.nextTick(() => {
        if (request.op === 'init')
          reply(request, { version: CURL_CFFI_VERSION, impersonate: DEFAULT_IMPERSONATE });
        else if (request.op === 'close') reply(request, { closed: true });
        else handler(request);
      });
      callback();
    },
  });
  spawnProcess = jest.fn(() => processStub);
  gate = { permit: jest.fn().mockResolvedValue(undefined) };
  transport = new OfficialOrderHttpTransport({ gate, proxy: PROXY, spawnProcess });
});

afterEach(async () => {
  await transport.close();
  jest.useRealTimers();
});

test('代理只在 stdin 初始化；环境白名单、独立 Python、真实内置 profile', async () => {
  process.env.OFFICIAL_TEST_SECRET = 'must-not-inherit';
  try {
    expect(await transport.start()).toEqual({ version: '0.16.3', impersonate: 'chrome150' });
    const args = spawnProcess.mock.calls[0];
    expect(JSON.stringify(args)).not.toContain(PROXY.username);
    expect(JSON.stringify(args)).not.toContain(PROXY.password);
    expect(args[1].slice(0, 2)).toEqual(['-I', '-u']);
    expect(args[2].shell).toBe(false);
    expect(args[2].env.OFFICIAL_TEST_SECRET).toBeUndefined();
    expect(commands).toEqual([{ id: 1, op: 'init', proxy: PROXY, impersonate: 'chrome150' }]);
    await transport.start();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  } finally {
    delete process.env.OFFICIAL_TEST_SECRET;
  }
});

test('每次发出前都等待许可，同一进程会话复用', async () => {
  let permit;
  gate.permit.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        permit = resolve;
      })
  );
  const first = transport.request({ url: URL });
  await new Promise(resolve => setImmediate(resolve));
  expect(commands.map(item => item.op)).toEqual(['init']);
  permit();
  expect((await first).status).toBe(200);
  await transport.request({
    url: URL,
    method: 'POST',
    body: 'challenge',
    headers: { 'Content-Type': 'text/plain' },
  });
  expect(gate.permit).toHaveBeenCalledTimes(2);
  expect(spawnProcess).toHaveBeenCalledTimes(1);
  expect(commands[2].bodyBase64).toBe(Buffer.from('challenge').toString('base64'));
  expect(commands[2].timeoutMs).toBe(30000);
});

test('许可失败与许可后停止都不会发送请求', async () => {
  gate.permit.mockRejectedValueOnce(Object.assign(new Error('private URL'), { code: 'HTTP_429' }));
  await expect(transport.request({ url: URL })).rejects.toMatchObject({
    code: 'HTTP_429',
    message: 'HTTP_429',
  });
  transport.isStopped = () => false;
  gate.permit.mockImplementationOnce(async () => {
    await Promise.resolve();
    transport.isStopped = () => true;
  });
  await expect(transport.request({ url: URL })).rejects.toMatchObject({
    code: 'HTTP_TRANSPORT_STOPPED',
  });
  expect(commands.filter(item => item.op === 'request')).toHaveLength(0);
});

test('返回跳转与多条 Set-Cookie，仅由上层选择下一跳', async () => {
  handler = request =>
    reply(
      request,
      response(request, {
        status: 302,
        rawHeaders: [
          ['Location', 'https://evil.test/secret'],
          ['Set-Cookie', 'a=private-a'],
          ['Set-Cookie', 'b=private-b'],
        ],
        cookies: [
          { name: 'a', value: 'private-a', domain: 'www.apple.com.cn', path: '/', secure: true },
        ],
      })
    );
  const result = await transport.request({ url: URL });
  expect(result.headers.location).toBe('https://evil.test/secret');
  expect(result.headers['set-cookie']).toEqual(['a=private-a', 'b=private-b']);
  expect(result.cookies[0].value).toBe('private-a');
  expect(commands.filter(item => item.op === 'request')).toHaveLength(1);
  await expect(transport.request({ url: result.headers.location })).rejects.toMatchObject({
    code: 'DESTINATION_DENIED',
  });
  expect(gate.permit).toHaveBeenCalledTimes(1);
});

test.each([
  'http://www.apple.com.cn/shop',
  'https://apple.com.cn.evil.test/shop',
  'https://127.0.0.1/',
  'https://www.apple.com.cn:444/',
  'https://user:password@www.apple.com.cn/',
  'https://www.apple.com.cn/#secret',
  'https://www.apple.com.cn/\nsecret',
  'https://www.apple.com.cn\\@evil.test/',
])('不启动进程或请求许可：%s', async url => {
  await expect(transport.request({ url })).rejects.toMatchObject({ code: 'DESTINATION_DENIED' });
  expect(spawnProcess).not.toHaveBeenCalled();
  expect(gate.permit).not.toHaveBeenCalled();
});

test.each([
  { headers: { 'Proxy-Authorization': 'secret' } },
  { headers: { 'User-Agent': 'Chrome/144' } },
  { headers: { 'sec-ch-ua': 'Chrome144' } },
  { headers: { 'X-Header': 'secret\r\nHost: evil.test' } },
  { headers: { Accept: 'a', accept: 'b' } },
  { timeoutMs: 30001 },
  { method: 'DELETE' },
  { method: 'POST', bodyBase64: 'not base64' },
  { method: 'POST', body: Buffer.alloc(1048577) },
  { body: 'unexpected' },
])('拒绝无效请求参数 %#', async extra => {
  await expect(transport.request({ url: URL, ...extra })).rejects.toThrow();
  expect(gate.permit).not.toHaveBeenCalled();
});

test('并发请求立即拒绝，不额外获取许可', async () => {
  let release;
  handler = request => {
    release = () => reply(request, response(request));
  };
  const first = transport.request({ url: URL });
  await new Promise(resolve => setImmediate(resolve));
  await expect(transport.request({ url: URL })).rejects.toMatchObject({
    code: 'HTTP_REQUEST_IN_PROGRESS',
  });
  expect(gate.permit).toHaveBeenCalledTimes(1);
  release();
  await first;
});

test('超时杀死进程，禁止该会话随后重放', async () => {
  await transport.start();
  handler = () => {};
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
  const pending = transport.request({ url: URL, timeoutMs: 100 });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'HTTP_TIMEOUT' });
  await Promise.resolve();
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(100);
  await rejected;
  expect(processStub.kill).toHaveBeenCalledWith('SIGKILL');
  await expect(transport.request({ url: URL })).rejects.toMatchObject({
    code: 'HTTP_TRANSPORT_STOPPED',
  });
  expect(gate.permit).toHaveBeenCalledTimes(1);
});

test.each(['bad-json', 'wrong-id', 'unsolicited', 'oversized', 'wrong-url', 'unknown-error'])(
  '损坏协议终止且不泄密：%s',
  async kind => {
    handler = request => {
      if (kind === 'bad-json') processStub.stdout.write('private invalid output\n');
      if (kind === 'wrong-id') reply(request, {}, { id: request.id + 1 });
      if (kind === 'unsolicited') reply(request, response(request), { ok: 'yes' });
      if (kind === 'oversized') processStub.stdout.write(Buffer.alloc(5767169));
      if (kind === 'wrong-url')
        reply(request, response(request, { url: 'https://www.apple.com.cn/other' }));
      if (kind === 'unknown-error')
        reply(request, null, { ok: false, code: 'secret-private-password' });
    };
    await expect(transport.request({ url: URL })).rejects.toThrow(
      /^HTTP_PROTOCOL_(INVALID|FAILED)$/
    );
    expect(processStub.kill).toHaveBeenCalled();
  }
);

test('Cookie 元数据错误保留固定诊断并终止传输，不返回成功或再次请求', async () => {
  handler = request =>
    reply(request, null, {
      ok: false,
      code: 'HTTP_COOKIE_METADATA_INVALID',
      message: 'private-cookie-value',
    });
  await expect(transport.request({ url: URL })).rejects.toMatchObject({
    code: 'HTTP_COOKIE_METADATA_INVALID',
    message: 'HTTP_COOKIE_METADATA_INVALID',
  });
  expect(transport.closed).toBe(true);
  expect(transport.ready).toBe(false);
  expect(processStub.kill).toHaveBeenCalledWith('SIGKILL');
  await expect(transport.request({ url: URL })).rejects.toMatchObject({
    code: 'HTTP_TRANSPORT_STOPPED',
  });
  expect(gate.permit).toHaveBeenCalledTimes(1);
  expect(commands.filter(item => item.op === 'request')).toHaveLength(1);
});

test('底层 stderr 与异常消息不透出；退出终止在途请求', async () => {
  handler = () => {
    processStub.stderr.write('private-password https://private-url.test');
    processStub.emit('error', new Error('private-password'));
  };
  await expect(transport.request({ url: URL })).rejects.toMatchObject({
    message: 'HTTP_PROCESS_FAILED',
  });
});

test('未知许可错误码不作为可信日志透出', async () => {
  gate.permit.mockRejectedValueOnce(Object.assign(new Error('secret'), { code: 'SECRET_ACCOUNT' }));
  await expect(transport.request({ url: URL })).rejects.toMatchObject({
    code: 'HTTP_TRANSPORT_FAILED',
    message: 'HTTP_TRANSPORT_FAILED',
  });
  expect(commands.filter(item => item.op === 'request')).toHaveLength(0);
});

test('初始化之后 stdin 同步失败也销毁进程', async () => {
  await transport.start();
  processStub.stdin.write = () => {
    throw new Error('private-password');
  };
  await expect(transport.request({ url: URL })).rejects.toMatchObject({
    code: 'HTTP_PROCESS_FAILED',
  });
  expect(processStub.kill).toHaveBeenCalled();
});

test('关闭在途请求直接终止；重复关闭幂等', async () => {
  handler = () => {};
  const pending = transport.request({ url: URL });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'HTTP_TRANSPORT_CLOSED' });
  await new Promise(resolve => setImmediate(resolve));
  await transport.close();
  await rejected;
  await transport.close();
  expect(processStub.kill).toHaveBeenCalled();
});
