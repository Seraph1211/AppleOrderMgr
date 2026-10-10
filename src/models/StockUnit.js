const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockUnit',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      deviceNumber: {
        type: DataTypes.INTEGER,
        allowNull: false,
        autoIncrement: true,
        unique: true,
        field: 'device_number',
      },
      serialNumber: { type: DataTypes.STRING(12), allowNull: false, field: 'serial_number' },
      orderNumberText: { type: DataTypes.STRING(100), allowNull: true, field: 'order_number_text' },
      notesCiphertext: { type: DataTypes.TEXT, allowNull: true, field: 'notes_ciphertext' },
      extraExpenseAmount: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
        field: 'extra_expense_amount',
      },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
      state: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'registered',
        field: 'state',
      },
      locationId: { type: DataTypes.UUID, allowNull: true, field: 'location_id' },
      returnedAt: { type: DataTypes.DATE, allowNull: true, field: 'returned_at' },
      returnPreviousState: {
        type: DataTypes.STRING(16),
        allowNull: true,
        field: 'return_previous_state',
      },
      returnLocationId: { type: DataTypes.UUID, allowNull: true, field: 'return_location_id' },
      lifecycleIssue: { type: DataTypes.STRING(40), allowNull: true, field: 'lifecycle_issue' },
      returnDecisionFingerprint: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'return_decision_fingerprint',
      },
      acquiredOn: { type: DataTypes.DATEONLY, allowNull: true, field: 'acquired_on' },
      firstReceivedAt: { type: DataTypes.DATE, allowNull: true, field: 'first_received_at' },
      costStatus: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
        field: 'cost_status',
      },
      officialCostAmount: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
        field: 'official_cost_amount',
      },
      priceId: { type: DataTypes.UUID, allowNull: true, field: 'price_id' },
      costSource: { type: DataTypes.STRING(16), allowNull: true, field: 'cost_source' },
      costBasisCiphertext: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'cost_basis_ciphertext',
      },
      originMode: { type: DataTypes.STRING(24), allowNull: false, field: 'origin_mode' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_units', underscored: true, timestamps: true }
  );
