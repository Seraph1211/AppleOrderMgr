const Backfill = require('../src/services/aosAccountBackfill');

function fixture({ unlockFailure = false, releaseFailure = false } = {}) {
  const connection = {
    query: jest.fn(sql => {
      if (sql.includes('try_advisory')) return Promise.resolve({ rows: [{ locked: true }] });
      if (unlockFailure) return Promise.reject(new Error('synthetic unlock'));
      return Promise.resolve({ rows: [] });
    }),
    end: jest.fn(() => Promise.resolve()),
  };
  const manager = {
    getConnection: jest.fn(() => Promise.resolve(connection)),
    releaseConnection: jest.fn(() =>
      releaseFailure ? Promise.reject(new Error('synthetic release')) : Promise.resolve()
    ),
    pool: { destroy: jest.fn(() => Promise.resolve()) },
  };
  const models = {
    sequelize: { connectionManager: manager },
    AosAccountIndexState: { findAll: jest.fn(() => Promise.resolve([])) },
  };
  const worker = new Backfill(models);
  worker.nextDiscovery = Infinity;
  return { worker, manager, connection };
}

test('正常空闲回填释放会话锁和连接，不生成工作队列', async () => {
  const { worker, manager, connection } = fixture();
  expect(await worker.tick()).toEqual({ idle: true });
  expect(connection.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock(20261026,1)');
  expect(manager.releaseConnection).toHaveBeenCalledTimes(1);
  expect(manager.pool.destroy).not.toHaveBeenCalled();
});

test('解锁异常销毁连接而非送回池，避免其他会话永远busy', async () => {
  const { worker, manager, connection } = fixture({ unlockFailure: true });
  await expect(worker.tick()).resolves.toEqual({ idle: true });
  expect(manager.pool.destroy).toHaveBeenCalledWith(connection);
  expect(manager.releaseConnection).not.toHaveBeenCalled();
});

test('正常release异常也销毁连接且tick不抛未处理拒绝', async () => {
  const { worker, manager, connection } = fixture({ releaseFailure: true });
  await expect(worker.tick()).resolves.toEqual({ idle: true });
  expect(manager.pool.destroy).toHaveBeenCalledWith(connection);
});

test('销毁连接失败时关闭原连接以释放数据库会话锁', async () => {
  const { worker, manager, connection } = fixture({ unlockFailure: true });
  manager.pool.destroy.mockRejectedValue(new Error('synthetic pool failure'));
  await expect(worker.tick()).resolves.toEqual({ idle: true });
  expect(connection.end).toHaveBeenCalledTimes(1);
});
