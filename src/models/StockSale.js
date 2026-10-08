const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockSale',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      saleNo: { type: DataTypes.STRING(32), allowNull: false, field: 'sale_no' },
      channel: { type: DataTypes.STRING(16), allowNull: false, field: 'channel' },
      simpleLedger: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'simple_ledger',
      },
      paymentVerification: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'known',
        field: 'payment_verification',
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'draft',
        field: 'status',
      },
      pendingCollectorId: { type: DataTypes.UUID, allowNull: true, field: 'pending_collector_id' },
      pendingCollectedAt: { type: DataTypes.DATE, allowNull: true, field: 'pending_collected_at' },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      salespersonId: { type: DataTypes.UUID, allowNull: true, field: 'salesperson_id' },
      handlerId: { type: DataTypes.UUID, allowNull: true, field: 'handler_id' },
      consigneeLocationId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'consignee_location_id',
      },
      shippedAt: { type: DataTypes.DATE, allowNull: true, field: 'shipped_at' },
      isHistorical: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_historical',
      },
      feesComplete: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'fees_complete',
      },
      notesCiphertext: { type: DataTypes.TEXT, allowNull: true, field: 'notes_ciphertext' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_sales', underscored: true, timestamps: true }
  );
