function loadProxyManager() {
  jest.resetModules();

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  jest.doMock('../src/utils/logger', () => logger);
  jest.doMock('../src/utils/config', () => ({
    config: {
      proxy: {
        enabled: true,
        apiUrl: 'https://proxy.example/api',
        maxFailCount: 2,
      },
    },
  }));

  return {
    proxyManager: require('../src/utils/proxyManager'),
    logger,
  };
}

describe('proxyManager sensitive logging', () => {
  test('does not log proxy username or password when response format is invalid', () => {
    const { proxyManager, logger } = loadProxyManager();

    const responseData = {
      code: 0,
      data: {
        count: 1,
      },
    };
    responseData.data['proxy_list'] = '1.2.3.4:8080:test_user:test_password';

    const result = proxyManager.parseProxyResponse(responseData);

    expect(result).toEqual([]);
    const loggedPayload = JSON.stringify(logger.error.mock.calls);
    expect(loggedPayload).not.toContain('test_user');
    expect(loggedPayload).not.toContain('test_password');
    expect(loggedPayload).toContain('proxyListCount');
  });

  test('masks proxy strings to host and port only', () => {
    const { proxyManager } = loadProxyManager();

    expect(proxyManager.maskProxyString('1.2.3.4:8080:test_user:test_password'))
      .toBe('1.2.3.4:8080');
  });
});
