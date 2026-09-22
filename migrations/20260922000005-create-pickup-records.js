'use strict';

/** 创建取货记录、凭证元数据和追加式修改历史。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(
        `ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_role;
         ALTER TABLE users ADD CONSTRAINT chk_users_role
         CHECK (role IN ('admin', 'operator', 'pickupStaff', 'readOnly'));`,
        { transaction }
      );
      const userRef = {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      };
      const timestamps = {
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      };
      await queryInterface.createTable(
        'pickup_records',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
          order_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            unique: true,
            references: { model: 'orders', key: 'id' },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
          picked_up_at: { type: Sequelize.DATE, allowNull: true },
          settlement_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
          settlement_person: { type: Sequelize.STRING(100), allowNull: true },
          notes: { type: Sequelize.TEXT, allowNull: true },
          last_updated_by: userRef,
          version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addConstraint('pickup_records', {
        fields: ['status'],
        type: 'check',
        name: 'chk_pickup_records_status',
        where: { status: ['pending', 'picked_up', 'exception'] },
        transaction,
      });
      await queryInterface.addIndex('pickup_records', ['status', 'updated_at'], {
        name: 'idx_pickup_records_status_updated',
        transaction,
      });

      await queryInterface.createTable(
        'pickup_evidence',
        {
          id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
          pickup_record_id: {
            type: Sequelize.BIGINT,
            allowNull: false,
            references: { model: 'pickup_records', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          kind: { type: Sequelize.STRING(20), allowNull: false },
          object_key: { type: Sequelize.STRING(500), allowNull: false, unique: true },
          original_name: { type: Sequelize.STRING(255), allowNull: false },
          content_type: { type: Sequelize.STRING(100), allowNull: false },
          size_bytes: { type: Sequelize.BIGINT, allowNull: false },
          uploaded_by: userRef,
          created_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
        },
        { transaction }
      );
      await queryInterface.addConstraint('pickup_evidence', {
        fields: ['kind'],
        type: 'check',
        name: 'chk_pickup_evidence_kind',
        where: { kind: ['pickup', 'settlement'] },
        transaction,
      });
      await queryInterface.addIndex('pickup_evidence', ['pickup_record_id', 'kind'], {
        name: 'idx_pickup_evidence_record_kind',
        transaction,
      });

      await queryInterface.createTable(
        'pickup_record_events',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
          pickup_record_id: {
            type: Sequelize.BIGINT,
            allowNull: false,
            references: { model: 'pickup_records', key: 'id' },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },
          order_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: 'orders', key: 'id' },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },
          actor_user_id: userRef,
          actor_name: { type: Sequelize.STRING(100), allowNull: false },
          event_type: { type: Sequelize.STRING(30), allowNull: false },
          changes: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
          before_version: { type: Sequelize.INTEGER, allowNull: false },
          after_version: { type: Sequelize.INTEGER, allowNull: false },
          created_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
        },
        { transaction }
      );
      await queryInterface.addIndex('pickup_record_events', ['pickup_record_id', 'created_at'], {
        name: 'idx_pickup_record_events_record_created',
        transaction,
      });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(
        `UPDATE users SET role = 'operator' WHERE role = 'pickupStaff';
         ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_role;
         ALTER TABLE users ADD CONSTRAINT chk_users_role
         CHECK (role IN ('admin', 'operator', 'readOnly'));`,
        { transaction }
      );
      await queryInterface.dropTable('pickup_record_events', { transaction });
      await queryInterface.dropTable('pickup_evidence', { transaction });
      await queryInterface.dropTable('pickup_records', { transaction });
    });
  },
};
