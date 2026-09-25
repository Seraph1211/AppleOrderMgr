const EMAIL_ORDER_STATUS_CONSTRAINT = 'orders_email_order_status_valid';

async function replaceConstraint(queryInterface, Sequelize, statuses, transaction) {
  await queryInterface.removeConstraint('orders', EMAIL_ORDER_STATUS_CONSTRAINT, { transaction });
  await queryInterface.addConstraint('orders', {
    fields: ['email_order_status'],
    type: 'check',
    name: EMAIL_ORDER_STATUS_CONSTRAINT,
    where: { email_order_status: { [Sequelize.Op.in]: statuses } },
    transaction,
  });
}

module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await replaceConstraint(
          queryInterface,
          Sequelize,
          ['unknown', 'confirmed', 'processing', 'ready_for_pickup', 'picked_up'],
          transaction
        );
      });
    } catch (error) {
      throw new Error('邮件推定已取货状态迁移失败', { cause: error });
    }
  },

  async down(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `UPDATE orders
             SET email_order_status = 'ready_for_pickup'
           WHERE email_order_status = 'picked_up'`,
          { transaction }
        );
        await replaceConstraint(
          queryInterface,
          Sequelize,
          ['unknown', 'confirmed', 'processing', 'ready_for_pickup'],
          transaction
        );
      });
    } catch (error) {
      throw new Error('邮件推定已取货状态迁移回滚失败', { cause: error });
    }
  },
};
