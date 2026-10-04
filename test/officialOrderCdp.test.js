/* eslint-disable no-magic-numbers -- 覆盖 CDP 协议编号和超时边界。 */
const Cdp = require('../src/services/officialOrderCdp');
const ORIGINAL_WEBSOCKET = global.WebSocket;
let socket;
class MockSocket {
  constructor() {
    this.listeners = {};
    socket = this;
  }
  addEventListener(name, handler) {
    (this.listeners[name] ||= []).push(handler);
  }
  emit(name, value) {
    for (const handler of this.listeners[name] || []) handler(value);
  }
  send(value) {
    this.sent = JSON.parse(value);
  }
  close() {
    this.emit('close');
  }
}
beforeEach(() => {
  global.WebSocket = MockSocket;
});
afterEach(() => {
  global.WebSocket = ORIGINAL_WEBSOCKET;
  jest.useRealTimers();
});
async function connected() {
  try {
    const cdp = new Cdp();
    const opening = cdp.open('ws://127.0.0.1/test');
    socket.emit('open');
    await opening;
    return cdp;
  } catch (error) {
    error.component = 'fixture';
    throw error;
  }
}
test('响应按 id 关联，跨会话事件和乱序回复不串单', async () => {
  const cdp = await connected();
  const observer = jest.fn();
  cdp.on('event', observer);
  const first = cdp.send('Network.enable', {}, 's1');
  const second = cdp.send('Fetch.enable', {}, 's2');
  expect(socket.sent.sessionId).toBe('s2');
  socket.emit('message', { data: JSON.stringify({ id: 2, result: { second: true } }) });
  socket.emit('message', { data: JSON.stringify({ id: 1, result: { first: true } }) });
  socket.emit('message', {
    data: JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 's1' }),
  });
  expect(await first).toEqual({ first: true });
  expect(await second).toEqual({ second: true });
  expect(observer).toHaveBeenCalledWith({ method: 'Fetch.requestPaused', sessionId: 's1' });
  expect(cdp.pending.size).toBe(0);
  cdp.close();
});
test('协议错误保留方法供取消分类，未知或坏消息不会冒充有效结果', async () => {
  const cdp = await connected();
  const fault = jest.fn();
  cdp.on('fault', fault);
  const command = cdp.send('Fetch.continueRequest');
  socket.emit('message', { data: JSON.stringify({ id: 999, result: {} }) });
  socket.emit('message', {
    data: JSON.stringify({ id: 1, error: { message: 'Invalid InterceptionId' } }),
  });
  await expect(command).rejects.toMatchObject({
    code: 'CDP_COMMAND_FAILED',
    method: 'Fetch.continueRequest',
  });
  socket.emit('message', { data: 'not-json' });
  expect(fault).toHaveBeenCalledWith(expect.objectContaining({ code: 'CDP_INVALID_MESSAGE' }));
  cdp.close();
});
test('超时、断开及写入错误释放待处理队列', async () => {
  jest.useFakeTimers();
  const cdp = await connected();
  const timedOut = cdp.send('Network.enable');
  const assertion = expect(timedOut).rejects.toMatchObject({ code: 'CDP_TIMEOUT' });
  jest.advanceTimersByTime(12000);
  await assertion;
  const disconnected = cdp.send('Fetch.enable');
  cdp.close();
  await expect(disconnected).rejects.toMatchObject({ code: 'CDP_CLOSED' });
  socket.send = () => {
    throw new Error('closed');
  };
  await expect(cdp.send('Fetch.enable')).rejects.toMatchObject({ code: 'CDP_CLOSED' });
  expect(cdp.pending.size).toBe(0);
});
test('连接失败返回稳定错误码', async () => {
  const cdp = new Cdp();
  const pending = cdp.open('ws://127.0.0.1/test');
  socket.emit('error');
  await expect(pending).rejects.toMatchObject({ code: 'CDP_OPEN_FAILED' });
});
