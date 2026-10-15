const express = require('express');
const ApiError = require('../src/utils/ApiError');
jest.mock('../src/services/identityApiService', () => ({ verify: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
const service = require('../src/services/identityApiService');
const logger = require('../src/utils/logger');
const CARD = '110101199001010015';
const TOKEN = 'A'.repeat(43);
let server;
let root;
const query = () => new URLSearchParams({ name: '合成测试', idCardNumber: CARD, token: TOKEN });
async function request(path, options = {}) {
  try {
    return await fetch(root + path, {
      ...options,
      headers: { 'X-Forwarded-Proto': 'https', ...options.headers },
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error('合成请求失败');
  }
}
beforeAll(async () => {
  try {
    const app = express();
    app.set('trust proxy', 1);
    app.use('/api/internal/v1/identity', require('../src/routes/internalIdentity'));
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    root = `http://127.0.0.1:${server.address().port}`;
  } catch (error) {
    throw error instanceof Error ? error : new Error('合成HTTP启动失败');
  }
});
afterAll(async () => {
  try {
    await new Promise(resolve => server.close(resolve));
  } catch (error) {
    throw error instanceof Error ? error : new Error('合成HTTP关闭失败');
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  service.verify.mockImplementation((input, _verify, onAuthenticated) => {
    onAuthenticated({ userId: 4, tokenId: 'synthetic-token-id' });
    return Promise.resolve({ verificationId: 25, status: 'matched', matched: true, reused: false });
  });
});
test('确定结果同步返回且日志只留安全审计编号', async () => {
  const response = await request(`/api/internal/v1/identity/verify?${query()}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  expect(await response.json()).toMatchObject({
    success: true,
    data: { matched: true, verificationId: 25 },
  });
  const entries = JSON.stringify(logger.info.mock.calls);
  expect(entries).not.toContain(CARD);
  expect(entries).not.toContain(TOKEN);
  expect(logger.info).toHaveBeenCalledWith(
    '内部身份核验访问',
    expect.objectContaining({ userId: 4, verificationId: 25 })
  );
});
test.each(['HEAD', 'POST', 'PUT', 'OPTIONS'])('%s被显式405拒绝，不执行付费GET', async method => {
  const response = await request(`/api/internal/v1/identity/verify?${query()}`, { method });
  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('GET');
  expect(service.verify).not.toHaveBeenCalled();
});
test('HTTP不跳转并拒绝执行', async () => {
  const response = await request(`/api/internal/v1/identity/verify?${query()}`, {
    headers: { 'X-Forwarded-Proto': 'http' },
  });
  expect(response.status).toBe(400);
  expect(response.headers.get('location')).toBeNull();
  expect(service.verify).not.toHaveBeenCalled();
});
test.each(['name=重复', 'name[]=嵌套', 'callback=jsonp', 'token=重复', 'extra=未约定'])(
  '拒绝额外或重复参数%s',
  async extra => {
    const response = await request(`/api/internal/v1/identity/verify?${query()}&${extra}`);
    expect(response.status).toBe(400);
    expect(service.verify).not.toHaveBeenCalled();
  }
);
test('所有未知异常移除SQL、URI、身份与令牌', async () => {
  service.verify.mockRejectedValueOnce(
    new Error(`SQL /verify?name=合成测试&idCardNumber=${CARD}&token=${TOKEN}`)
  );
  const response = await request(`/api/internal/v1/identity/verify?${query()}`);
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).not.toContain(CARD);
  expect(body).not.toContain(TOKEN);
  expect(body).not.toContain('SQL');
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain(CARD);
});
test('限流返回Retry-After；已调用未知返回核验编号和null判定', async () => {
  service.verify.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMIT', '请求过于频繁'));
  const rate = await request(`/api/internal/v1/identity/verify?${query()}`);
  expect(rate.status).toBe(429);
  expect(rate.headers.get('retry-after')).toBe('1');
  const error = new ApiError(504, 'RESULT_UNKNOWN', '超时未知');
  Object.assign(error, { verificationId: 26, resultStatus: 'unknown', providerCalled: true });
  service.verify.mockRejectedValueOnce(error);
  const result = await request(`/api/internal/v1/identity/verify?${query()}`);
  expect(result.status).toBe(504);
  expect(await result.json()).toMatchObject({
    success: false,
    status: 'unknown',
    matched: null,
    providerCalled: true,
    verificationId: 26,
  });
});
test('前缀下404和错误路径从不输出query或核验', async () => {
  for (const path of [
    '/api/internal/v1/identity/not-found',
    '/API/internal/v1/identity/not-found',
    '/api/internal/v1/identity/%ZZ',
  ]) {
    const response = await request(`${path}?${query()}`);
    expect([400, 404]).toContain(response.status);
    expect(await response.text()).not.toContain(CARD);
  }
  expect(service.verify).not.toHaveBeenCalled();
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain(TOKEN);
});

test('令牌缺失统一401，姓名或证件缺失仍为400，均不执行核验', async () => {
  const missingToken = await request(
    `/api/internal/v1/identity/verify?${new URLSearchParams({ name: '合成测试', idCardNumber: CARD })}`
  );
  expect(missingToken.status).toBe(401);
  expect(await missingToken.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  const missingName = await request(
    `/api/internal/v1/identity/verify?${new URLSearchParams({ token: TOKEN, idCardNumber: CARD })}`
  );
  expect(missingName.status).toBe(400);
  expect(service.verify).not.toHaveBeenCalled();
});
