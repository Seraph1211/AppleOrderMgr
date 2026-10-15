jest.mock('../src/services/inventoryValidationClient', () => ({
  readProxy: jest.fn(),
  requestOnce: jest.fn(),
}));
jest.mock('../src/services/inventoryTunnel', () => jest.fn());
const { readProxy, requestOnce } = require('../src/services/inventoryValidationClient');
const InventoryTunnel = require('../src/services/inventoryTunnel');
const InventoryDriver = require('../src/services/inventoryDriver');

describe('库存唯一 IPRoyal 出口', () => {
  let select;
  beforeEach(() => {
    jest.clearAllMocks();
    select = jest.fn().mockResolvedValue({ label: 'iproyal-main', url: 'private' });
    InventoryTunnel.mockImplementation(() => ({ select }));
    readProxy.mockReturnValue({
      label: 'iproyal-main',
      url: 'private',
      tunnel: { provider: 'iproyal' },
    });
    requestOnce.mockResolvedValue({ id: 'attempt', outcome: 'INVENTORY_VALID' });
  });
  test('唯一配置必须先验证出口，忽略备用与旧API配置', async () => {
    const driver = new InventoryDriver(
      {},
      {
        proxyFile: 'main',
        backupFile: 'old-backup',
        apiFile: 'old-api',
      }
    );
    expect(await driver.request('inventory', {})).toMatchObject({ outcome: 'INVENTORY_VALID' });
    expect(readProxy).toHaveBeenCalledTimes(1);
    expect(readProxy).toHaveBeenCalledWith('main');
    expect(select).toHaveBeenCalledTimes(1);
    expect(requestOnce.mock.calls[0][0].proxy).toEqual({ label: 'iproyal-main', url: 'private' });
  });
  test.each([
    { label: 'yiyou-main' },
    { label: 'iproyal-main', tunnel: { provider: 'fanproxy' } },
    { label: 'iproyal-main' },
  ])('错误来源关闭请求 %#', async proxy => {
    readProxy.mockReturnValue(proxy);
    const driver = new InventoryDriver({}, { proxyFile: 'main' });
    expect(await driver.request('inventory', {})).toEqual({ outcome: 'NO_HEALTHY_PROXY' });
    expect(requestOnce).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
  test('并发调用合并验证，网络请求仍逐个进入闸门', async () => {
    const driver = new InventoryDriver({}, { proxyFile: 'main' });
    const results = await Promise.all(
      Array.from({ length: 3 }, () => driver.request('inventory', {}))
    );
    expect(results.every(x => x.outcome === 'INVENTORY_VALID')).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
    expect(requestOnce).toHaveBeenCalledTimes(3);
  });
  test.each(['PROXY_PROVIDER_COOLDOWN', 'PROXY_RECOVERY_EXHAUSTED', 'REQUEST_IN_FLIGHT'])(
    '保护结果 %s 保留且不发请求',
    async outcome => {
      select.mockRejectedValue(
        Object.assign(new Error('secret'), {
          inventoryOutcome: outcome,
          until: 123,
        })
      );
      const driver = new InventoryDriver({}, { proxyFile: 'main' });
      expect(await driver.request('inventory', {})).toEqual({ outcome, until: 123 });
      expect(requestOnce).not.toHaveBeenCalled();
    }
  );
  test('原始错误不得泄露认证地址，失败后允许重新读取配置', async () => {
    readProxy.mockImplementationOnce(() => {
      throw new Error('http://user:private@host');
    });
    const driver = new InventoryDriver({}, { proxyFile: 'main' });
    expect(await driver.request('inventory', {})).toEqual({ outcome: 'NO_HEALTHY_PROXY' });
    expect(await driver.request('inventory', {})).toMatchObject({ outcome: 'INVENTORY_VALID' });
  });
});
