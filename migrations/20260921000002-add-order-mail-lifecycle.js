module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        const addOrderColumn = (name, definition) =>
          queryInterface.addColumn('orders', name, definition, { transaction });
        await addOrderColumn('email_order_status', {
          type: Sequelize.STRING(30),
          allowNull: false,
          defaultValue: 'unknown',
        });
        await addOrderColumn('email_payment_status', {
          type: Sequelize.STRING(20),
          allowNull: false,
          defaultValue: 'unknown',
        });
        await addOrderColumn('email_status_needs_review', {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        });
        await addOrderColumn('email_status_review_reasons', {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: [],
        });
        await addOrderColumn('email_status_version', {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        });
        await addOrderColumn('email_status_evidence_at', { type: Sequelize.DATE });
        await addOrderColumn('email_pickup_info', { type: Sequelize.JSONB });
        await addOrderColumn('email_pickup_date', { type: Sequelize.DATEONLY });
        await addOrderColumn('email_lifecycle_updated_at', { type: Sequelize.DATE });
        await queryInterface.addColumn('order_mail_messages', 'received_at', Sequelize.DATE, {
          transaction,
        });
        await queryInterface.sequelize.query(
          'UPDATE order_mail_messages SET received_at = created_at WHERE received_at IS NULL',
          { transaction }
        );

        const timestamps = {
          created_at: { type: Sequelize.DATE, allowNull: false },
          updated_at: { type: Sequelize.DATE, allowNull: false },
        };
        await queryInterface.createTable(
          'order_mail_processing_jobs',
          {
            id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
            message_id: {
              type: Sequelize.UUID,
              allowNull: false,
              unique: true,
              references: { model: 'order_mail_messages', key: 'id' },
              onDelete: 'CASCADE',
            },
            status: { type: Sequelize.STRING(30), allowNull: false, defaultValue: 'pending' },
            attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            not_before: { type: Sequelize.DATE, allowNull: false },
            lease_expires_at: { type: Sequelize.DATE },
            last_error_code: { type: Sequelize.STRING(50) },
            completed_at: { type: Sequelize.DATE },
            ...timestamps,
          },
          { transaction }
        );
        await queryInterface.addIndex('order_mail_processing_jobs', ['status', 'not_before'], {
          transaction,
        });

        await queryInterface.createTable(
          'order_mail_events',
          {
            id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
            message_id: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'order_mail_messages', key: 'id' },
              onDelete: 'RESTRICT',
            },
            order_id: {
              type: Sequelize.INTEGER,
              references: { model: 'orders', key: 'id' },
              onDelete: 'SET NULL',
            },
            revision: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            source: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'parser' },
            actor_user_id: {
              type: Sequelize.INTEGER,
              references: { model: 'users', key: 'id' },
              onDelete: 'SET NULL',
            },
            template_type: { type: Sequelize.STRING(50), allowNull: false },
            authenticity_status: { type: Sequelize.STRING(30), allowNull: false },
            order_status: { type: Sequelize.STRING(30) },
            payment_status: { type: Sequelize.STRING(20) },
            pickup_info: { type: Sequelize.JSONB },
            products: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            evidence: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            needs_review: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            review_reasons: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            reason: { type: Sequelize.STRING(500) },
            rule_version: { type: Sequelize.STRING(50), allowNull: false },
            parsed_at: { type: Sequelize.DATE, allowNull: false },
            applied_at: { type: Sequelize.DATE },
            superseded_at: { type: Sequelize.DATE },
            ...timestamps,
          },
          { transaction }
        );
        await queryInterface.addIndex('order_mail_events', ['message_id', 'revision'], {
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('order_mail_events', ['order_id', 'parsed_at'], {
          transaction,
        });
        await queryInterface.addIndex(
          'order_mail_events',
          ['message_id', 'source', 'superseded_at'],
          { transaction }
        );
        for (const [name, fields] of [
          ['idx_orders_email_order_status', ['email_order_status']],
          ['idx_orders_email_payment_status', ['email_payment_status']],
          ['idx_orders_email_pickup_date', ['email_pickup_date']],
        ]) {
          await queryInterface.addIndex('orders', fields, { name, transaction });
        }
        await queryInterface.addConstraint('orders', {
          fields: ['email_order_status'],
          type: 'check',
          name: 'orders_email_order_status_valid',
          where: {
            email_order_status: {
              [Sequelize.Op.in]: ['unknown', 'confirmed', 'processing', 'ready_for_pickup'],
            },
          },
          transaction,
        });
        await queryInterface.addConstraint('orders', {
          fields: ['email_payment_status'],
          type: 'check',
          name: 'orders_email_payment_status_valid',
          where: { email_payment_status: { [Sequelize.Op.in]: ['unknown', 'paid'] } },
          transaction,
        });
      });
    } catch (error) {
      throw new Error('订单邮件生命周期迁移失败', { cause: error });
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.dropTable('order_mail_events', { transaction });
        await queryInterface.dropTable('order_mail_processing_jobs', { transaction });
        for (const name of [
          'email_lifecycle_updated_at',
          'email_pickup_date',
          'email_pickup_info',
          'email_status_evidence_at',
          'email_status_version',
          'email_status_review_reasons',
          'email_status_needs_review',
          'email_payment_status',
          'email_order_status',
        ]) {
          await queryInterface.removeColumn('orders', name, { transaction });
        }
        await queryInterface.removeColumn('order_mail_messages', 'received_at', { transaction });
      });
    } catch (error) {
      throw new Error('订单邮件生命周期迁移回滚失败', { cause: error });
    }
  },
};
