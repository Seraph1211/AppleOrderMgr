'use strict';

/** 新增设备绑定表，唯一约束处理跨订单并发重复扫描。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.createTable(
          'pickup_devices',
          {
            id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
            order_id: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: { model: 'orders', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'RESTRICT',
            },
            serial_number: { type: Sequelize.STRING(12), allowNull: false, unique: true },
            imei: { type: Sequelize.STRING(15), allowNull: false, unique: true },
            serial_barcode: { type: Sequelize.STRING(64), allowNull: false },
            imei_barcode: { type: Sequelize.STRING(64), allowNull: false },
            scanned_by: {
              type: Sequelize.INTEGER,
              allowNull: true,
              references: { model: 'users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'SET NULL',
            },
            created_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          { transaction }
        );
        await queryInterface.addIndex('pickup_devices', ['order_id', 'created_at'], {
          name: 'idx_pickup_devices_order_created',
          transaction,
        });
        await queryInterface.sequelize.query(
          `ALTER TABLE pickup_devices
           ADD CONSTRAINT chk_pickup_devices_serial CHECK (serial_number ~ '^([A-Z0-9]{10}|[A-Z0-9]{12})$'),
           ADD CONSTRAINT chk_pickup_devices_imei CHECK (imei ~ '^[0-9]{15}$')`,
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('创建设备绑定表失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.dropTable('pickup_devices', { transaction });
      });
    } catch (error) {
      throw new Error('回退设备绑定表失败', { cause: error });
    }
  },
};
