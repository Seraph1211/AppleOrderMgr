import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBrowserOrder, BROWSER_EXTENSION_ID } from '../src/utils/browserOrderRefresh.js';

function fakeRuntime() {
  let messageListener;
  let disconnectListener;
  const sent = [];
  let disconnected = false;
  const port = {
    onMessage: { addListener: fn => { messageListener = fn; } },
    onDisconnect: { addListener: fn => { disconnectListener = fn; } },
    postMessage: message => sent.push(message),
    disconnect: () => { disconnected = true; },
  };
  return { sent, get disconnected() { return disconnected; }, message: msg => messageListener(msg), drop: () => disconnectListener(), runtime: { connect: id => { assert.equal(id, BROWSER_EXTENSION_ID); return port; } } };
}

test('任务票据不发送给扩展，每次许可完成后才能确认请求', async () => {
  const fake = fakeRuntime();
  let resolvePermit;
  const result = collectBrowserOrder({
    runtime: fake.runtime,
    task: () => Promise.resolve({ ticket: 'private-ticket', orderUrl: 'https://example.com/order', orderNumber: 'W1234567890', expiresAt: '2026-09-20T00:00:00Z' }),
    permit: () => new Promise(resolve => { resolvePermit = resolve; }),
  });
  await fake.message({ type: 'ready' });
  assert.equal(JSON.stringify(fake.sent).includes('private-ticket'), false);
  const permitting = fake.message({ type: 'permit', id: 1 });
  assert.equal(fake.sent.length, 1);
  resolvePermit();
  await permitting;
  assert.deepEqual(fake.sent[1], { type: 'permit', id: 1, allowed: true });
  await fake.message({ type: 'result', page: { orderJson: { orderDetail: {} } } });
  assert.deepEqual(await result, { orderJson: { orderDetail: {} } });
  assert.equal(fake.disconnected, true);
});

test('用户取消后晚到的结果不能变成成功', async () => {
  const fake = fakeRuntime();
  const controller = new AbortController();
  const result = collectBrowserOrder({ runtime: fake.runtime, signal: controller.signal, task: () => Promise.resolve({}), permit: () => Promise.resolve() });
  const rejected = assert.rejects(result, /取消/);
  controller.abort();
  await fake.message({ type: 'result', page: { fake: true } });
  await rejected;
  assert.equal(fake.disconnected, true);
});

test('不支持扩展时立即明确失败，不创建系统任务', async () => {
  let started = false;
  await assert.rejects(collectBrowserOrder({ runtime: undefined, task: () => { started = true; }, permit: () => Promise.resolve() }), /桌面 Chrome/);
  assert.equal(started, false);
});

test('服务器拒绝请求许可时关闭连接，不提交浏览器成功结果', async () => {
  const fake = fakeRuntime();
  const result = collectBrowserOrder({ runtime: fake.runtime, task: () => Promise.resolve({}), permit: () => Promise.reject(new Error('权限已撤销')) });
  const rejected = assert.rejects(result, /权限已撤销/);
  await fake.message({ type: 'ready' });
  await fake.message({ type: 'permit', id: 1 });
  await rejected;
  assert.equal(fake.sent.some(message => message.allowed), false);
  assert.equal(fake.disconnected, true);
});

test('失败诊断仅保留有界状态码与计数，剔除额外敏感内容', async () => {
  const fake = fakeRuntime();
  const result = collectBrowserOrder({ runtime: fake.runtime, task: () => Promise.resolve({}), permit: () => Promise.resolve() });
  const rejected = assert.rejects(result, error => {
    assert.deepEqual(error.diagnostics, { documentStatuses: [200], fetchOrderStatuses: [541], requestCount: 46 });
    assert.equal(JSON.stringify(error.diagnostics).includes('private'), false);
    return true;
  });
  await fake.message({ type: 'result', error: '官网未返回有效详情', diagnostics: { documentStatuses: [200, 'private-url'], fetchOrderStatuses: [541], requestCount: 46, cookie: 'private-cookie', parsedBodies: -1, networkFailures: 1001 } });
  await rejected;
});
