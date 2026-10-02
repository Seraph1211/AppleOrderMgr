jest.mock('fs', () => ({ readFileSync: jest.fn() }));
jest.mock('../src/services/inventoryValidationClient', () => ({
  readProxy: jest.fn(),
  requestOnce: jest.fn(),
}));
jest.mock('../src/services/inventoryValidationProxy', () => ({ acquireProxy: jest.fn() }));
const fs = require('fs');
const { readProxy, requestOnce } = require('../src/services/inventoryValidationClient');
const { acquireProxy } = require('../src/services/inventoryValidationProxy');
const InventoryDriver = require('../src/services/inventoryDriver');
const { encrypt } = require('../src/utils/fieldEncryption');
describe('库存出口严格边界', () => {
  let state;
  let gate;
  beforeEach(() => {
    jest.clearAllMocks();
    state = {};
    gate = {
      locked: jest.fn(work => Promise.resolve(work(state, Date.now(), {}))),
      save: jest.fn().mockResolvedValue(),
    };
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    readProxy.mockImplementation(file => ({ label: file, url: 'http://user:pass@proxy.test:80' }));
    requestOnce.mockResolvedValue({ id: 'attempt', outcome: 'INVENTORY_VALID' });
  });
  test('主出口已隔离才使用预配置备用，不直连', async () => {
    try {
      state.pausedEgress = { main: 'PROXY_AUTH_FAILED' };
      const driver = new InventoryDriver(gate, { proxyFile: 'main', backupFile: 'backup' });
      expect((await driver.proxy()).label).toBe('backup');
      await driver.request('inventory', { skus: ['TEST1CH/A'], location: '100000' });
      expect(requestOnce.mock.calls[0][0].proxy.label).toBe('backup');
    } catch (error) {
      throw new Error('出口测试失败', { cause: error });
    }
  });
  test('动态端点加密缓存、单次提取，541 不通过再提取同供应商绕过', async () => {
    try {
      fs.readFileSync.mockReturnValue(
        JSON.stringify({ apiUrl: 'https://api.yiyouip.com/index.php?num=100' })
      );
      acquireProxy.mockResolvedValue({
        url: 'http://user:pass@proxy.test:80',
        expiresAt: Date.now() + 240000,
      });
      const driver = new InventoryDriver(gate, { apiFile: 'private-file' });
      expect((await driver.proxy()).label).toBe('yiyou-main');
      expect(state.proxyCache.cipher).toMatch(/^enc:/);
      await driver.proxy();
      expect(acquireProxy).toHaveBeenCalledTimes(1);
      state.requiredAlternateEgress = 'yiyou-main';
      expect((await driver.request('inventory', {})).outcome).toBe('NO_HEALTHY_PROXY');
      expect(acquireProxy).toHaveBeenCalledTimes(1);
    } catch (error) {
      throw new Error('动态出口测试失败', { cause: error });
    }
  });
  test('可用缓存不暴露密文，网络错误只返回脱敏结果', async () => {
    try {
      state.proxyCache = {
        expiresAt: Date.now() + 240000,
        cipher: encrypt('http://user:pass@proxy.test:80'),
      };
      const driver = new InventoryDriver(gate, { apiFile: 'private-file' });
      requestOnce.mockRejectedValue(new Error('sensitive-proxy-password'));
      expect(await driver.request('inventory', {})).toEqual({ outcome: 'NO_HEALTHY_PROXY' });
      expect(acquireProxy).not.toHaveBeenCalled();
    } catch (error) {
      throw new Error('错误脱敏测试失败', { cause: error });
    }
  });
});
