jest.mock('../src/utils/logger', () => ({ warn: jest.fn() }));

const migration = require('../migrations/20260922000004-add-recipient-channel');

function queryInterface() {
  const transaction = { id: 'synthetic-transaction' };
  return {
    transaction,
    sequelize: {
      transaction: jest.fn(callback => Promise.resolve(callback(transaction))),
    },
    addColumn: jest.fn(),
    addIndex: jest.fn(),
    removeIndex: jest.fn(),
    removeColumn: jest.fn(),
  };
}

describe('取机人渠道字段 Migration', () => {
  const Sequelize = { STRING: jest.fn(length => ({ type: 'STRING', length })) };

  test('up 只新增可空渠道字段和普通索引，不回填存量内容', async () => {
    const qi = queryInterface();
    await migration.up(qi, Sequelize);

    expect(qi.addColumn).toHaveBeenCalledWith(
      'recipients',
      'channel',
      expect.objectContaining({ allowNull: true, defaultValue: null }),
      { transaction: qi.transaction }
    );
    expect(qi.addIndex).toHaveBeenCalledWith('recipients', ['channel'], {
      name: 'idx_recipients_channel',
      transaction: qi.transaction,
    });
    expect(qi.sequelize).not.toHaveProperty('query');
  });

  test('down 先移除索引再移除字段', async () => {
    const qi = queryInterface();
    await migration.down(qi);

    expect(qi.removeIndex).toHaveBeenCalledWith('recipients', 'idx_recipients_channel', {
      transaction: qi.transaction,
    });
    expect(qi.removeColumn).toHaveBeenCalledWith('recipients', 'channel', {
      transaction: qi.transaction,
    });
    expect(qi.removeIndex.mock.invocationCallOrder[0]).toBeLessThan(
      qi.removeColumn.mock.invocationCallOrder[0]
    );
  });
});
