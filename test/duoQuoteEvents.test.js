jest.mock('../src/models', () => ({
  sequelize: { query: jest.fn() },
  DuoQuotePricingSetting: { findByPk: jest.fn() },
}));
const { EventEmitter } = require('events');
const { DuoQuoteEvents, CHANNEL } = require('../src/services/duoQuoteEvents');

class Listener extends EventEmitter {
  constructor() {
    super();
    this.connect = jest.fn(() => Promise.resolve());
    this.query = jest.fn(() => Promise.resolve());
    this.end = jest.fn(() => Promise.resolve());
  }
}
function request(ip = '127.0.0.1') {
  const req = new EventEmitter();
  req.ip = ip;
  req.socket = { setTimeout: jest.fn() };
  return req;
}
function response() {
  const res = new EventEmitter();
  res.headers = {};
  res.headersSent = false;
  res.writableEnded = false;
  res.setHeader = (key, value) => {
    res.headers[key] = value;
  };
  res.flushHeaders = () => {
    res.headersSent = true;
  };
  res.write = jest.fn(() => true);
  res.end = jest.fn(() => {
    res.writableEnded = true;
    res.emit('close');
  });
  res.destroy = jest.fn(() => {
    res.destroyed = true;
    res.emit('close');
  });
  res.setTimeout = jest.fn();
  return res;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
let hub;
let pg;
let readVersion;
beforeEach(() => {
  process.env.QUOTE_DUO_PUBLIC_ENABLED = 'true';
  pg = new Listener();
  readVersion = jest.fn(() => Promise.resolve(0));
  hub = new DuoQuoteEvents({ createClient: () => pg, readVersion, heartbeatMs: 10 });
});
afterEach(async () => {
  await hub.stop();
  delete process.env.QUOTE_DUO_PUBLIC_ENABLED;
});

test('按首连接懒启动一个PG监听，多匿名流共享，仅版本白名单和禁缓冲头', async () => {
  expect(pg.connect).not.toHaveBeenCalled();
  const a = response();
  const b = response();
  await Promise.all([hub.subscribe(request(), a), hub.subscribe(request('other'), b)]);
  expect(pg.connect).toHaveBeenCalledTimes(1);
  expect(pg.query).toHaveBeenCalledWith(`LISTEN ${CHANNEL}`);
  expect(a.headers).toMatchObject({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  expect(a.write.mock.calls[0][0]).toBe(
    'retry: 3000\nid: 0\nevent: quote-version\ndata: {"version":0}\n\n'
  );
  pg.emit('notification', { channel: CHANNEL, payload: '{"version":1}' });
  expect(a.write.mock.calls[1][0]).toBe('id: 1\nevent: quote-version\ndata: {"version":1}\n\n');
  expect(b.write.mock.calls[1][0]).toBe(a.write.mock.calls[1][0]);
  pg.emit('notification', { channel: CHANNEL, payload: '{"version":1,"markup":50}' });
  pg.emit('notification', { channel: CHANNEL, payload: '{"version":"2"}' });
  pg.emit('notification', { channel: CHANNEL, payload: '{"version":0}' });
  expect(a.write).toHaveBeenCalledTimes(2);
});

test('首连读取版本期间收到更新不能被旧读取覆盖或漏掉', async () => {
  const pending = deferred();
  readVersion.mockResolvedValueOnce(0).mockImplementationOnce(() => pending.promise);
  const res = response();
  const opening = hub.subscribe(request(), res);
  await tick();
  pg.emit('notification', { channel: CHANNEL, payload: '{"version":7}' });
  expect(res.write).not.toHaveBeenCalled();
  pending.resolve(0);
  await opening;
  expect(res.write.mock.calls[0][0]).toContain('data: {"version":7}');
});

test('数据库恢复后读当前修订号校准已打开流，不要求重播历史payload', async () => {
  const a = response();
  await hub.subscribe(request(), a);
  const next = new Listener();
  hub.createClient = () => next;
  pg.emit('error', new Error('offline'));
  readVersion.mockResolvedValue(9);
  await hub.ensureReady();
  expect(next.query).toHaveBeenCalledWith(`LISTEN ${CHANNEL}`);
  expect(a.write.mock.calls.at(-1)[0]).toContain('data: {"version":9}');
});

test('心跳保持连接、背压/关闭释放IP计数与最后PG连接', async () => {
  const req = request();
  const res = response();
  await hub.subscribe(req, res);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(res.write.mock.calls.some(([text]) => text === ': heartbeat\n\n')).toBe(true);
  res.write.mockReturnValueOnce(false);
  pg.emit('notification', { channel: CHANNEL, payload: '{"version":2}' });
  await tick();
  expect(hub.clients.size).toBe(0);
  expect(hub.ipCounts.size).toBe(0);
  expect(res.destroy).toHaveBeenCalledTimes(1);
  expect(res.end).not.toHaveBeenCalled();
  expect(pg.end).toHaveBeenCalledTimes(1);
});

test('未初始化流时请求断开也释放，pending握手停止不阻塞HTTP结束', async () => {
  const pending = deferred();
  pg.connect.mockImplementation(() => pending.promise);
  const req = request();
  const res = response();
  const opening = hub.subscribe(req, res);
  await hub.stop();
  expect(res.end).toHaveBeenCalled();
  expect(hub.clients.size).toBe(0);
  pending.resolve();
  await opening;
});

test('暂停、限额与监听失败返回受控错误，不留下幽灵连接', async () => {
  process.env.QUOTE_DUO_PUBLIC_ENABLED = 'false';
  await expect(hub.subscribe(request(), response())).rejects.toMatchObject({
    code: 'QUOTE_PAGE_PAUSED',
  });
  process.env.QUOTE_DUO_PUBLIC_ENABLED = 'true';
  hub.maxPerIp = 1;
  const res = response();
  await hub.subscribe(request(), res);
  await expect(hub.subscribe(request(), response())).rejects.toMatchObject({
    statusCode: 429,
    code: 'DUO_EVENTS_LIMITED',
  });
  res.emit('close');
  pg = new Listener();
  pg.connect.mockRejectedValueOnce(new Error('private connection detail'));
  await expect(hub.subscribe(request(), response())).rejects.toMatchObject({
    statusCode: 503,
    code: 'DUO_EVENTS_UNAVAILABLE',
  });
  expect(hub.clients.size).toBe(0);
  expect(hub.ipCounts.size).toBe(0);
});
