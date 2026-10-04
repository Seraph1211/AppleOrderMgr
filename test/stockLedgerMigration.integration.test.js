/** 第二份台账迁移独立演练。只运行于新建并已迁移至第一份库存迁移的1008合成库。 */
const crypto = require('crypto');
const logger = require('../src/utils/logger');
const { Sequelize } = require('sequelize');
const enabled = process.env.RUN_STOCK_LEDGER_MIGRATION === 'true';
if (
  enabled &&
  (process.env.DB_NAME !== 'apple_order_mgr_stock_test_1008' ||
    process.env.DB_NAME_TEST !== process.env.DB_NAME ||
    process.env.DATABASE_URL)
)
  throw new Error('台账迁移演练仅允许独立合成库1008');

(enabled ? describe : describe.skip)('简化台账迁移真实 PostgreSQL', () => {
  const migration = require('../migrations/20261004000002-simplify-stock-ledger');
  const config = require('../config/config').test;
  const sequelize = new Sequelize(config.database, config.username, config.password, {
    ...config,
    logging: false,
  });
  const queryInterface = sequelize.getQueryInterface();
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ids = Object.fromEntries(
    [
      'product',
      'location',
      'person',
      'unit',
      'sale',
      'line',
      'saleUnit',
      'collection',
      'receipt',
      'allocation',
    ].map(key => [key, crypto.randomUUID()])
  );
  let oldSnapshot;

  async function query(sql, replacements = {}) {
    try {
      return (await sequelize.query(sql, { replacements }))[0];
    } catch (error) {
      logger.debug('台账合成验证未完成', { code: error.code || error.name });
      throw error;
    }
  }
  async function snapshot() {
    try {
      const result = {};
      for (const [table, key, excluded] of [
        ['stock_products', 'product', []],
        ['stock_locations', 'location', []],
        ['stock_parties', 'person', []],
        ['stock_units', 'unit', ['order_number_text', 'notes_ciphertext', 'extra_expense_amount']],
        ['stock_sales', 'sale', ['simple_ledger', 'payment_verification']],
        ['stock_sale_lines', 'line', []],
        ['stock_sale_units', 'saleUnit', []],
        ['stock_collections', 'collection', []],
        ['stock_receipts', 'receipt', []],
        ['stock_receipt_allocations', 'allocation', []],
      ]) {
        const [row] = await query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE id=:id`, {
          id: ids[key],
        });
        result[table] = row?.row;
        for (const field of excluded) if (result[table]) delete result[table][field];
      }
      return result;
    } catch (error) {
      logger.debug('台账合成验证未完成', { code: error.code || error.name });
      throw error;
    }
  }

  beforeAll(async () => {
    try {
      await sequelize.authenticate();
      const [row] = await query(
        "SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_units' AND column_name='order_number_text'"
      );
      if (row.n !== 0)
        throw new Error('迁移演练库已有第二份结构/证据；拒绝自动回退或清空，请另行准备空白库');
    } catch (error) {
      logger.debug('台账合成验证未完成', { code: error.code || error.name });
      throw error;
    }
  });
  afterAll(async () => {
    try {
      await sequelize.close();
    } catch (error) {
      logger.debug('台账合成验证未完成', { code: error.code || error.name });
      throw error;
    }
  });

  test('空增量数据up/down/up正式迁移可恢复旧非空约束', async () => {
    await migration.up(queryInterface);
    let [columns] = await query(
      "SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_units' AND column_name IN ('order_number_text','notes_ciphertext','extra_expense_amount')"
    );
    expect(columns.n).toBe(3);
    const nullable = await query(
      "SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND ((table_name='stock_sale_units' AND column_name='from_location_id') OR (table_name IN ('stock_collections','stock_receipts') AND column_name='received_at'))"
    );
    expect(nullable).toHaveLength(3);
    expect(nullable.every(row => row.is_nullable === 'YES')).toBe(true);
    await migration.down(queryInterface);
    [columns] = await query(
      "SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_units' AND column_name='order_number_text'"
    );
    expect(columns.n).toBe(0);
    const notNull = await query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND ((table_name='stock_sale_units' AND column_name='from_location_id') OR (table_name IN ('stock_collections','stock_receipts') AND column_name='received_at'))"
    );
    expect(notNull.every(row => row.is_nullable === 'NO')).toBe(true);
    await migration.up(queryInterface);
    await migration.down(queryInterface);
  });

  test('带旧单台销售及部分到账迁移保留每个旧字段，仍允许无增量资料down', async () => {
    await query(
      `
      INSERT INTO stock_products(id,model_key,model_name,storage_gb,color_key,color_name)
        VALUES(:product,:name,'迁移合成机',256,:color,'蓝色');
      INSERT INTO stock_locations(id,name,kind,city) VALUES(:location,:name,'warehouse','重庆');
      INSERT INTO stock_parties(id,name,party_type,roles) VALUES(:person,:name,'external_person','["salesperson","handler"]');
      INSERT INTO stock_units(id,serial_number,product_id,state,origin_mode,acquired_on,cost_status,official_cost_amount,cost_source,first_received_at)
        VALUES(:unit,:serial,:product,'sold','current','2026-10-02','confirmed',8000.01,'manual','2026-10-03T00:00:00+08:00');
      INSERT INTO stock_sales(id,sale_no,channel,status,salesperson_id,handler_id,shipped_at)
        VALUES(:sale,:saleNo,'local','shipped',:person,:person,'2026-10-04T00:00:00+08:00');
      INSERT INTO stock_sale_lines(id,sale_id,product_id,quantity) VALUES(:line,:sale,:product,1);
      INSERT INTO stock_sale_units(id,sale_line_id,stock_unit_id,from_location_id,status,sale_amount,cost_amount_snapshot,product_snapshot)
        VALUES(:saleUnit,:line,:unit,:location,'shipped',9000.02,8000.01,'{}');
      INSERT INTO stock_collections(id,sale_id,destination,collector_id,amount,received_at)
        VALUES(:collection,:sale,'agent',:person,9000.02,'2026-10-04T01:00:00+08:00');
      INSERT INTO stock_receipts(id,source,payer_id,amount,received_at)
        VALUES(:receipt,'agent_transfer',:person,1000.01,'2026-10-05T02:00:00+08:00');
      INSERT INTO stock_receipt_allocations(id,receipt_id,collection_id,sale_unit_id,amount)
        VALUES(:allocation,:receipt,:collection,:saleUnit,1000.01);`,
      {
        ...ids,
        name: `迁移${suffix}`,
        color: `blue${suffix}`,
        serial: `M${suffix}001`,
        saleNo: `MIGRATION-${suffix}`,
      }
    );
    oldSnapshot = await snapshot();
    await migration.up(queryInterface);
    expect(await snapshot()).toEqual(oldSnapshot);
    expect(
      (
        await query(
          'SELECT simple_ledger AS "simpleLedger",payment_verification AS "paymentVerification" FROM stock_sales WHERE id=:sale',
          ids
        )
      )[0]
    ).toEqual({ simpleLedger: false, paymentVerification: 'known' });
    await migration.down(queryInterface);
    expect(await snapshot()).toEqual(oldSnapshot);
    await migration.up(queryInterface);
    expect(await snapshot()).toEqual(oldSnapshot);
  });

  test('新增费用数据库约束拒绝负数和NaN，未知货款仅历史简化记录允许', async () => {
    for (const amount of ['-0.01', 'NaN']) {
      await expect(
        query('UPDATE stock_units SET extra_expense_amount=:amount WHERE id=:unit', {
          ...ids,
          amount,
        })
      ).rejects.toMatchObject({ original: { code: '23514' } });
    }
    await expect(
      query("UPDATE stock_sales SET payment_verification='unknown' WHERE id=:sale", ids)
    ).rejects.toMatchObject({ original: { code: '23514' } });
    await expect(
      query("UPDATE stock_units SET acquired_on=NULL,cost_source='catalog' WHERE id=:unit", ids)
    ).rejects.toMatchObject({ original: { code: '23514' } });
    await expect(
      query('UPDATE stock_sales SET salesperson_id=NULL WHERE id=:sale', ids)
    ).rejects.toMatchObject({ original: { code: '23514' } });
    expect(await snapshot()).toEqual(oldSnapshot);
  });

  test('新历史空字段/人工成本日期允许落库，有增量资料拒绝down且整套旧新资料保留', async () => {
    const historical = crypto.randomUUID();
    const manualUnit = crypto.randomUUID();
    await query(
      `
      INSERT INTO stock_units(id,serial_number,product_id,state,origin_mode,cost_status,official_cost_amount,cost_source,order_number_text,extra_expense_amount)
        VALUES(:manualUnit,:serial,:product,'registered','current','confirmed',8000.00,'manual',:orderNumber,0.00);
      INSERT INTO stock_sales(id,sale_no,channel,status,shipped_at,is_historical,simple_ledger,payment_verification)
        VALUES(:historical,:saleNo,'local','shipped','2026-09-01T00:00:00+08:00',true,true,'unknown');`,
      {
        ...ids,
        manualUnit,
        historical,
        serial: `M${suffix}002`,
        orderNumber: `W${suffix}`,
        saleNo: `HISTORY-${suffix}`,
      }
    );
    await expect(migration.down(queryInterface)).rejects.toThrow('已有业务资料');
    expect(await snapshot()).toEqual(oldSnapshot);
    expect(
      (
        await query(
          'SELECT cost_status AS "costStatus",acquired_on AS "acquiredOn",official_cost_amount AS "officialCostAmount",order_number_text AS "orderNumberText",extra_expense_amount AS "extraExpenseAmount" FROM stock_units WHERE id=:id',
          { id: manualUnit }
        )
      )[0]
    ).toEqual({
      costStatus: 'confirmed',
      acquiredOn: null,
      officialCostAmount: '8000.00',
      orderNumberText: `W${suffix}`,
      extraExpenseAmount: '0.00',
    });
    expect(
      (
        await query(
          'SELECT salesperson_id AS "salespersonId",handler_id AS "handlerId",simple_ledger AS "simpleLedger",payment_verification AS "paymentVerification" FROM stock_sales WHERE id=:id',
          { id: historical }
        )
      )[0]
    ).toEqual({
      salespersonId: null,
      handlerId: null,
      simpleLedger: true,
      paymentVerification: 'unknown',
    });
  });
});
