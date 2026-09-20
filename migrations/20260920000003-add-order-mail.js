module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        const timestamps = {
          created_at: { type: Sequelize.DATE, allowNull: false },
          updated_at: { type: Sequelize.DATE, allowNull: false },
        };
        await queryInterface.createTable(
          'order_mail_messages',
          {
            id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
            mailbox_identity_hash: { type: Sequelize.STRING(64), allowNull: false },
            uid_validity: { type: Sequelize.STRING(100), allowNull: false },
            email_uid: { type: Sequelize.BIGINT, allowNull: false },
            order_number: { type: Sequelize.STRING(50), allowNull: false },
            mime_sha256: { type: Sequelize.STRING(64), allowNull: false },
            metadata: { type: Sequelize.JSONB },
            raw_content: { type: Sequelize.TEXT },
            email_date: { type: Sequelize.DATE },
            expires_at: { type: Sequelize.DATE, allowNull: false },
            ...timestamps,
          },
          { transaction }
        );
        await queryInterface.addIndex(
          'order_mail_messages',
          ['mailbox_identity_hash', 'uid_validity', 'email_uid'],
          { unique: true, name: 'order_mail_messages_identity', transaction }
        );
        await queryInterface.addIndex(
          'order_mail_messages',
          ['mailbox_identity_hash', 'mime_sha256'],
          { unique: true, name: 'order_mail_messages_content', transaction }
        );
        await queryInterface.addIndex('order_mail_messages', ['order_number', 'email_date'], {
          transaction,
        });
        const reference = (model, type) => ({
          type,
          allowNull: false,
          references: { model, key: 'id' },
          onDelete: 'RESTRICT',
        });
        await queryInterface.createTable(
          'order_mail_deliveries',
          {
            id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
            order_id: reference('orders', Sequelize.INTEGER),
            message_id: reference('order_mail_messages', Sequelize.UUID),
            actor_user_id: reference('users', Sequelize.INTEGER),
            idempotency_key: { type: Sequelize.STRING(100), allowNull: false },
            payload: { type: Sequelize.JSONB, allowNull: false },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'queued' },
            attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            not_before: { type: Sequelize.DATE, allowNull: false },
            started_at: { type: Sequelize.DATE },
            sent_at: { type: Sequelize.DATE },
            error_code: { type: Sequelize.STRING(50) },
            ...timestamps,
          },
          { transaction }
        );
        await queryInterface.addIndex(
          'order_mail_deliveries',
          ['actor_user_id', 'idempotency_key'],
          { unique: true, transaction }
        );
        await queryInterface.addIndex('order_mail_deliveries', ['status', 'not_before'], {
          transaction,
        });
        await queryInterface.createTable(
          'order_mail_states',
          {
            mailbox_identity_hash: {
              type: Sequelize.STRING(64),
              primaryKey: true,
              allowNull: false,
            },
            is_connected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            last_scan_started_at: { type: Sequelize.DATE },
            last_scan_succeeded_at: { type: Sequelize.DATE },
            last_scan_error_code: { type: Sequelize.STRING(50) },
            last_scan_duration_ms: { type: Sequelize.INTEGER },
            received_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            ignored_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            ...timestamps,
          },
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('订单邮件迁移或合成验证失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        for (const table of ['order_mail_deliveries', 'order_mail_messages', 'order_mail_states'])
          await queryInterface.dropTable(table, { transaction });
      });
    } catch (error) {
      throw new Error('订单邮件迁移或合成验证失败', { cause: error });
    }
  },
};
