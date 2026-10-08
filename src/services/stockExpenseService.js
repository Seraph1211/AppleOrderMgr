const logger = require('../utils/logger');
const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { encrypt } = require('../utils/fieldEncryption');
const { cents, allocateMoney } = require('../utils/stockMoney');
const { array, choice, instant, text } = require('../utils/stockRules');
const { getRow, assertVersion, updateRow, recordEvent } = require('./stockCommandService');
const { soldUnits } = require('./stockFinanceService');
/** 记录费用当前版本的确定性整数分分摊。 */
async function allocateExpense(ctx, expense, ids) {
  try {
    let units = await soldUnits(ctx, expense.saleId);
    if (expense.scope === 'selected_units') {
      array(ids);
      if (new Set(ids).size !== ids.length || ids.some(id => !units.some(unit => unit.id === id)))
        throw ApiError.badRequest('费用所选实机不属于本单');
      units = units.filter(unit => ids.includes(unit.id));
    }
    const physical = await db.StockUnit.findAll({
      where: { id: { [Op.in]: units.map(unit => unit.stockUnitId) } },
      transaction: ctx.transaction,
    });
    const shares = allocateMoney(
      expense.amount,
      units.map(unit => ({
        id: unit.id,
        serialNumber: physical.find(row => row.id === unit.stockUnitId).serialNumber,
      }))
    );
    await db.StockExpenseAllocation.bulkCreate(
      shares.map(share => ({
        ...share,
        expenseId: expense.id,
        expenseVersion: expense.version,
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      })),
      { transaction: ctx.transaction }
    );
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockExpenseService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 新费用或明确更正，旧分摊版本保留。 */
async function saveExpense(ctx, saleId, id, input) {
  try {
    const current = id ? await getRow('StockExpense', id, ctx) : null;
    if (current) {
      assertVersion(current, input.expectedVersion);
      if (current.status !== 'active') throw ApiError.conflict('费用已作废');
    }
    const sale = await getRow('StockSale', current?.saleId || saleId, ctx);
    if (sale.status !== 'shipped') throw ApiError.conflict('仅已出货销售可登记费用');
    const values = { ...(current?.toJSON() || {}), ...input };
    cents(values.amount, { positive: true });
    const data = {
      saleId: sale.id,
      category: choice(values.category, ['shipping', 'errand', 'consignment', 'other']),
      scope: choice(values.scope, ['all_units', 'selected_units']),
      amount: values.amount,
      occurredAt: instant(
        typeof values.occurredAt === 'string' ? values.occurredAt : values.occurredAt.toISOString()
      ),
      paidByPartyId: values.paidByPartyId || null,
    };
    if (data.paidByPartyId) await getRow('StockParty', data.paidByPartyId, ctx);
    if (input.notes !== undefined)
      data.notesCiphertext = encrypt(text(input.notes, '备注', 2000, true));
    let ids = input.saleUnitIds;
    if (current && !ids && data.scope === 'selected_units')
      ids = (
        await db.StockExpenseAllocation.findAll({
          where: { expenseId: id, expenseVersion: current.version },
          transaction: ctx.transaction,
        })
      ).map(row => row.saleUnitId);
    let expense;
    if (current) expense = await updateRow(ctx, current, data, 'expense_correct');
    else {
      expense = await db.StockExpense.create(
        { ...data, createdBy: ctx.user.id, updatedBy: ctx.user.id },
        { transaction: ctx.transaction }
      );
      await recordEvent(ctx, 'StockExpense', expense, 'expense');
    }
    await allocateExpense(ctx, expense, ids);
    return { expenseId: expense.id, saleId: sale.id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockExpenseService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 作废费用不冲减货款。 */
async function voidExpense(ctx, id, input) {
  try {
    const expense = await getRow('StockExpense', id, ctx);
    assertVersion(expense, input.expectedVersion);
    text(input.reason, '作废原因', 500);
    await updateRow(ctx, expense, { status: 'voided' }, 'expense_void');
    return { expenseId: id, saleId: expense.saleId };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockExpenseService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 费用完整性需用户明确确认。 */
async function feesComplete(ctx, id, input) {
  try {
    const sale = await getRow('StockSale', id, ctx);
    assertVersion(sale, input.expectedVersion);
    if (typeof input.complete !== 'boolean') throw ApiError.badRequest('complete应为布尔值');
    await updateRow(ctx, sale, { feesComplete: input.complete }, 'fees_complete');
    return { saleId: id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockExpenseService',
      code: error.code || error.name,
    });
    throw error;
  }
}
module.exports = { allocateExpense, saveExpense, voidExpense, feesComplete };
