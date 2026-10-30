jest.mock('../src/services/quotePricingService', () => ({
  getPublicQuotes: jest.fn(),
}));
jest.mock('../src/services/duoQuoteService', () => ({ getPublicDuoQuotes: jest.fn() }));
jest.mock('../src/services/duoQuoteHistoryService', () => ({
  getPublicDuoQuoteHistory: jest.fn(),
}));

const express = require('express');
const quotePricingService = require('../src/services/quotePricingService');
const duoQuoteService = require('../src/services/duoQuoteService');
const duoQuoteHistoryService = require('../src/services/duoQuoteHistoryService');

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

test('应该匿名读取独立Duo数据并禁止缓存', async () => {
  duoQuoteService.getPublicDuoQuotes.mockResolvedValue({
    enabled: true,
    items: [{ retailPrice: 27650, premiumAmount: 1150 }],
  });
  const response = await fetch(`${baseUrl}/api/public/duo-quotes`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json()).data.items[0].premiumAmount).toBe(1150);
  expect(quotePricingService.getPublicQuotes).not.toHaveBeenCalled();
});

test('应该匿名读取Duo价格走势并透传范围', async () => {
  duoQuoteHistoryService.getPublicDuoQuoteHistory.mockResolvedValue({
    range: '30d',
    capacities: [],
  });
  const response = await fetch(`${baseUrl}/api/public/duo-quotes/history?range=30d`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json()).data.range).toBe('30d');
  expect(duoQuoteHistoryService.getPublicDuoQuoteHistory).toHaveBeenCalledWith(
    expect.objectContaining({ range: '30d' })
  );
});
