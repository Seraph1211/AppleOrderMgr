const { Op } = require('sequelize');
const { createService } = require('../src/services/aosTaskConfigService');

function models(instances) {
  return {
    MonitorInstance: { findAll: jest.fn().mockResolvedValue(instances) },
    AosDevice: { findAll: jest.fn().mockResolvedValue([]) },
    AosTaskConfig: { findAll: jest.fn().mockResolvedValue([]) },
    AosTaskConfigVersion: { findAll: jest.fn().mockResolvedValue([]) },
  };
}

test('实例超过1000明确拒绝，不返回截断统计或继续查询无序配置头', async () => {
  const db = models(
    Array.from({ length: 1001 }, (_, index) => ({ id: `instance-${index}`, deviceId: 'device' }))
  );
  await expect(createService(db).list()).rejects.toMatchObject({
    statusCode: 422,
    code: 'TASK_INSTANCE_LIMIT',
  });
  expect(db.MonitorInstance.findAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 1001 }));
  expect(db.AosDevice.findAll).not.toHaveBeenCalled();
  expect(db.AosTaskConfig.findAll).not.toHaveBeenCalled();
});

test('配置头和设备只查询本次实例集合，不能被历史无关记录挤出', async () => {
  const db = models([
    { id: 'instance-b', deviceId: 'device-a', localId: 'local-b', label: 'B号实例', active: true },
    { id: 'instance-c', deviceId: 'device-a', localId: 'local-c', label: 'C号实例', active: true },
  ]);
  db.AosDevice.findAll.mockResolvedValue([{ id: 'device-a', name: 'US_A', enabled: true }]);
  db.AosTaskConfig.findAll.mockResolvedValue([
    { instanceId: 'instance-c', currentVersionId: 'version-c', revision: 1 },
  ]);
  db.AosTaskConfigVersion.findAll.mockResolvedValue([
    { id: 'version-c', number: 1, taskCount: 55, cityCount: 25, specCount: 6 },
  ]);
  const result = await createService(db).list();
  expect(db.AosDevice.findAll).toHaveBeenCalledWith({
    where: { id: { [Op.in]: ['device-a'] } },
    attributes: ['id', 'name', 'enabled'],
  });
  expect(db.AosTaskConfig.findAll).toHaveBeenCalledWith({
    where: { instanceId: { [Op.in]: ['instance-b', 'instance-c'] } },
  });
  expect(result.items[1]).toMatchObject({
    instanceId: 'instance-c',
    status: 'active',
    taskCount: 55,
    currentVersionNumber: 1,
  });
  expect(result.items[0]).toMatchObject({ status: 'missing', serverName: 'US_A' });
});

test('没有实例返回完整空列表，不扫描设备与历史配置', async () => {
  const db = models([]);
  await expect(createService(db).list()).resolves.toEqual({ items: [] });
  expect(db.AosDevice.findAll).not.toHaveBeenCalled();
  expect(db.AosTaskConfig.findAll).not.toHaveBeenCalled();
});
