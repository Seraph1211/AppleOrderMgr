jest.mock('../src/services/quotePricingService', () => ({
  getPublicQuotes: jest.fn(),
}));

const express = require('express');
const quotePricingService = require('../src/services/quotePricingService');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use('/api/public', require('../src/routes/publicQuotes'));
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  jest.clearAllMocks();
  quotePricingService.getPublicQuotes.mockResolvedValue({
    enabled: true,
    items: [],
  });
});

test.each(['/api/public/apple-quotes', '/api/public/iphone18-quotes'])(
  '%s 返回同一公开报价并禁止缓存',
  async path => {
    const response = await fetch(`${baseUrl}${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      success: true,
      data: { enabled: true, items: [] },
    });
    expect(quotePricingService.getPublicQuotes).toHaveBeenCalledTimes(1);
  }
);
