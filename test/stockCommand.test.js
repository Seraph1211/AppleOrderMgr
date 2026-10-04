const crypto = require('crypto');
const db = require('../src/models');
const { runCommand } = require('../src/services/stockCommandService');

jest.mock('../src/utils/logger', () => ({ warn: jest.fn(), debug: jest.fn() }));

describe('库存命令数据库异常分类', () => {
  afterEach(() => jest.restoreAllMocks());

  const rejectDatabaseError = async (
    code,
    message = 'database failure',
    name = 'SequelizeDatabaseError'
  ) => {
    try {
      const error = Object.assign(new Error(message), { name, original: { code, message } });
      jest.spyOn(db.sequelize, 'transaction').mockRejectedValue(error);
      return await runCommand(
        { id: 1 },
        { requestKey: crypto.randomUUID() },
        'failure_test',
        [],
        jest.fn()
      );
    } catch (error) {
      error.message = `库存错误分类回归：${error.message}`;
      throw error;
    }
  };

  test.each(['08000', '08006', '08P01', '57P01', '57P02', '57P03', 'ECONNRESET', 'EPIPE'])(
    '连接错误 %s 可使用原键重试',
    async code => {
      await expect(rejectDatabaseError(code)).rejects.toMatchObject({
        statusCode: 503,
        code: 'STOCK_CONNECTION_LOST',
      });
    }
  );

  test('无 SQLSTATE 的意外断连也可重试', async () => {
    await expect(
      rejectDatabaseError(undefined, 'Connection terminated unexpectedly')
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'STOCK_CONNECTION_LOST',
    });
  });

  test.each(['55P03', '57014', '40P01'])('锁等待、超时和死锁 %s 可重试', async code => {
    await expect(rejectDatabaseError(code)).rejects.toMatchObject({
      statusCode: 503,
      code: 'STOCK_BUSY',
    });
  });

  test.each(['23514', '23503', '22P02'])('真实约束/字段错误 %s 保持 400', async code => {
    await expect(rejectDatabaseError(code)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  test('内部 SQL 错误不误报客户字段错误', async () => {
    await expect(rejectDatabaseError('42601')).rejects.toMatchObject({
      name: 'SequelizeDatabaseError',
    });
  });
});
