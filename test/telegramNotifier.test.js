jest.mock('axios', () => ({
  post: jest.fn().mockResolvedValue({ data: { ok: true } }),
}));

function loadTelegramNotifier(overrides = {}) {
  jest.resetModules();

  jest.doMock('../src/utils/logger', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }));

  jest.doMock('../src/utils/config', () => ({
    config: {
      telegram: {
        enabled: overrides.enabled !== false,
        botToken: 'test-token',
        chatId: 'test-chat',
        proxyUrl: overrides.proxyUrl || '',
        timeout: 1000,
      },
    },
  }));

  jest.doMock('socks-proxy-agent', () => ({
    SocksProxyAgent: jest.fn((proxyUrl) => ({ kind: 'socks', proxyUrl })),
  }));

  jest.doMock('https-proxy-agent', () => ({
    HttpsProxyAgent: jest.fn((proxyUrl) => ({ kind: 'https', proxyUrl })),
  }));

  return require('../src/utils/telegramNotifier');
}

describe('telegramNotifier proxy support', () => {
  test('builds agent config for socks5h proxy URLs', () => {
    const { buildTelegramAgentConfig } = loadTelegramNotifier();
    const requestOptions = buildTelegramAgentConfig('socks5h://user:pass@127.0.0.1:1080');

    expect(requestOptions.proxy).toBe(false);
    expect(requestOptions.httpAgent).toBeDefined();
    expect(requestOptions.httpsAgent).toBeDefined();
    expect(requestOptions.httpAgent.kind).toBe('socks');
  });

  test('passes socks proxy as agents to axios instead of axios proxy option', async () => {
    const { sendTelegramAlert } = loadTelegramNotifier({
      proxyUrl: 'socks5h://user:pass@127.0.0.1:1080',
    });
    const axios = require('axios');

    await expect(sendTelegramAlert('测试告警', { orderNumber: 'W1234567890' }))
      .resolves
      .toBe(true);

    const requestOptions = axios.post.mock.calls[0][2];
    expect(requestOptions.proxy).toBe(false);
    expect(requestOptions.httpAgent).toBeDefined();
    expect(requestOptions.httpsAgent).toBeDefined();
    expect(requestOptions.httpAgent.kind).toBe('socks');
  });
});
