const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { scopeOrderWhere } = require('./orderAccessService');
const {
  requirePermissions,
  assertVersion,
  updateRow,
  recordEvent,
  getRow,
} = require('./stockCommandService');
const { text, choice } = require('../utils/stockRules');
const {
  RETURN_STATUS,
  explicitSerials,
  returnFingerprint,
  returnDecision,
} = require('./stockLifecycleRules');

/** 在调用方事务内读取白名单检查记录。 */
async function checkForOrder(orderId, transaction) {
  try {
    const rows = await db.sequelize.query(
      'SELECT * FROM stock_order_checks WHERE order_id=:orderId',
      {
        replacements: { orderId },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    return rows[0] || null;
  } catch (error) {
    logger.warn('库存退货观测读取失败', { code: error.code || error.name });
    throw error;
  }
}

/** 内部执行器使用独立系统审计身份，不冒用管理员，不向浏览器开放。 */
async function systemContext(transaction, orderId) {
  try {
    const op = await db.StockOperation.create(
      {
        actorUserId: null,
        actorKey: 'system:stock_returns',
        requestKey: crypto.randomUUID(),
        action: 'lifecycle.observe',
        requestHash: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
        resultRefs: { orderId },
      },
      { transaction }
    );
    return { transaction, user: { id: null, username: '库存系统状态核对' }, operationId: op.id };
  } catch (error) {
    logger.warn('库存系统审计创建失败', { code: error.code || error.name });
    throw error;
  }
}

/** 使用同一订单全部绑定判断映射完整性，任何歧义禁止按订单数量批量退货。 */
async function applyCheck(ctx, orderId, check) {
  try {
    const bindings = await db.PickupDevice.findAll({
      where: { orderId },
      transaction: ctx.transaction,
    });
    const units = await db.StockUnit.findAll({
      where: { id: bindings.map(row => row.stockUnitId).filter(Boolean) },
      transaction: ctx.transaction,
    });
    const returns = check.items.filter(item => item.rawStatus === RETURN_STATUS);
    const explicit = returns.flatMap(item => explicitSerials(item, item.quantity));
    const allSerials = check.items.flatMap(item => explicitSerials(item, item.quantity));
    const known = new Set(units.map(unit => unit.serialNumber));
    const manual = check.manual_serials;
    const ambiguous =
      !manual &&
      returns.length > 0 &&
      (returns.some(
        item => explicitSerials(item, item.quantity).length !== item.quantity || !item.quantity
      ) ||
        new Set(allSerials).size !== allSerials.length ||
        explicit.some(sn => !known.has(sn)));
    const matched = new Set(manual || (ambiguous ? [] : explicit));
    for (const unit of units) {
      const values = returnDecision(unit, {
        hasReturn: returns.length > 0,
        matched: matched.has(unit.serialNumber),
        ambiguous,
        fingerprint: check.fingerprint,
      });
      if (unit.returnDecisionFingerprint && unit.returnDecisionFingerprint !== check.fingerprint)
        values.returnDecisionFingerprint = null;
      if (values.state === 'returned') values.returnedAt = new Date();
      if (Object.entries(values).some(([key, value]) => unit[key] !== value)) {
        if (!ctx.operationId) ctx = await systemContext(ctx.transaction, orderId);
        await updateRow(ctx, unit, values, 'lifecycle.return');
      }
    }
    return { ledgerUnitIds: units.map(unit => unit.id) };
  } catch (error) {
    logger.warn('库存退货状态应用失败', { orderId, code: error.code || error.name });
    throw error;
  }
}

/** 已验证官网结果的内部附带写入，调用方必须先获取库存锁。失败保留最近成功证据。 */
async function observe(transaction, orderId, result, errorCode, previousStatus = null) {
  try {
    const bound = await db.PickupDevice.count({ where: { orderId }, transaction });
    if (!bound) return;
    const items = result?.items || [];
    const fingerprint = result ? returnFingerprint(items) : null;
    await db.sequelize.query(
      `INSERT INTO stock_order_checks(order_id,items,fingerprint,observed_at,checked_at,error_code,pickup_verified)
      VALUES(:orderId,CAST(:items AS jsonb),:fingerprint,:observed,now(),:error,:picked)
      ON CONFLICT(order_id) DO UPDATE SET checked_at=now(),error_code=EXCLUDED.error_code,pickup_verified=stock_order_checks.pickup_verified OR EXCLUDED.pickup_verified,
        items=CASE WHEN :success THEN EXCLUDED.items ELSE stock_order_checks.items END,
        manual_serials=CASE WHEN :success AND stock_order_checks.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint THEN NULL ELSE stock_order_checks.manual_serials END,
        fingerprint=CASE WHEN :success THEN EXCLUDED.fingerprint ELSE stock_order_checks.fingerprint END,
        observed_at=CASE WHEN :success THEN EXCLUDED.observed_at ELSE stock_order_checks.observed_at END`,
      {
        replacements: {
          orderId,
          items: JSON.stringify(items),
          fingerprint,
          observed: result?.observedAt || null,
          error: result ? null : errorCode,
          success: Boolean(result),
          picked:
            String(previousStatus || '')
              .split('|')
              .some(value => value.trim() === 'PICKED_UP') ||
            items.some(item => item.rawStatus === 'PICKED_UP'),
        },
        transaction,
      }
    );
    const settings = result ? await db.StockSetting.findByPk(1, { transaction }) : null;
    if (result && settings?.enabled) {
      await applyCheck({ transaction }, orderId, await checkForOrder(orderId, transaction));
    }
  } catch (error) {
    logger.warn('库存退货观测保存失败', { orderId, code: error.code || error.name });
    throw error;
  }
}

async function accessibleOrder(ctx, orderId) {
  try {
    requirePermissions(ctx, 'stock.read', 'orders.read');
    if (!Number.isSafeInteger(Number(orderId)) || Number(orderId) < 1)
      throw ApiError.badRequest('订单编号无效');
    const order = await db.Order.findOne({
      where: scopeOrderWhere(ctx.user, { id: Number(orderId) }),
      transaction: ctx.transaction,
    });
    if (!order) throw ApiError.notFound('订单不存在或不可访问');
    return order;
  } catch (error) {
    logger.debug('退货订单权限检查失败', { code: error.code || error.name });
    throw error;
  }
}

/** 提供订单内完整 SN 清单供人工选择，不返回官网原始响应。 */
async function returnReview(ctx, orderId) {
  try {
    const order = await accessibleOrder(ctx, orderId);
    const check = await checkForOrder(order.id, ctx.transaction);
    const bindings = await db.PickupDevice.findAll({
      where: { orderId: order.id },
      transaction: ctx.transaction,
    });
    const units = await db.StockUnit.findAll({
      where: { id: bindings.map(b => b.stockUnitId).filter(Boolean) },
      attributes: ['id', 'serialNumber', 'state', 'version', 'lifecycleIssue'],
      order: [['id', 'ASC']],
      transaction: ctx.transaction,
    });
    let reviewFingerprint = null;
    if (check?.fingerprint) {
      reviewFingerprint = crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            observation: check.fingerprint,
            manual: check.manual_serials,
            units: units.map(unit => [unit.id, unit.version]),
          })
        )
        .digest('hex');
    }
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      fingerprint: reviewFingerprint,
      hasReturn: Boolean(check?.items.some(item => item.rawStatus === RETURN_STATUS)),
      returnQuantity:
        check?.items
          .filter(item => item.rawStatus === RETURN_STATUS)
          .reduce((n, item) => n + item.quantity, 0) || 0,
      serialNumbers: check?.manual_serials || [],
      units,
      observedAt: check?.observed_at || null,
    };
  } catch (error) {
    logger.warn('读取退货核对失败', { code: error.code || error.name });
    throw error;
  }
}

/** 人工确认整单退货 SN 集合，明确排除同单其他设备；幂等及锁由台账命令提供。 */
async function confirmReturns(ctx, orderId, input) {
  try {
    requirePermissions(ctx, 'stock.correct', 'stock.receive');
    ctx.reason = text(input.reason, '核实依据', 500, true);
    const review = await returnReview(ctx, orderId);
    if (!review.hasReturn || !review.fingerprint || input.fingerprint !== review.fingerprint)
      throw ApiError.conflict('官网观测已变化或尚无有效退货记录，请刷新核对');
    const sns = input.serialNumbers;
    if (
      !Array.isArray(sns) ||
      !sns.length ||
      sns.length > 100 ||
      new Set(sns).size !== sns.length ||
      sns.some(sn => !review.units.some(unit => unit.serialNumber === sn)) ||
      (review.returnQuantity > 0 && sns.length !== review.returnQuantity)
    )
      throw ApiError.badRequest('请选择与官网退货数量一致的本订单 SN；不得推测缺失设备');
    const check = await checkForOrder(review.orderId, ctx.transaction);
    // 明确官网 SN 与人工选项冲突时拒绝，不能用人工映射覆盖明确证据。
    const explicit = check.items
      .filter(item => item.rawStatus === RETURN_STATUS)
      .flatMap(item => explicitSerials(item, item.quantity));
    if (explicit.some(sn => !sns.includes(sn)))
      throw ApiError.conflict('所选 SN 与官网明确退货 SN 冲突');
    await db.sequelize.query(
      'UPDATE stock_order_checks SET manual_serials=CAST(:sns AS jsonb) WHERE order_id=:id',
      {
        replacements: { sns: JSON.stringify(sns), id: review.orderId },
        transaction: ctx.transaction,
      }
    );
    // 即使单台状态未变，也保存本次人工映射依据。
    const mappedUnits = await db.StockUnit.findAll({
      where: { id: review.units.map(value => value.id) },
      transaction: ctx.transaction,
    });
    for (const unit of mappedUnits) {
      await updateRow(ctx, unit, { returnDecisionFingerprint: null }, 'lifecycle.confirm_mapping');
      await recordEvent(
        ctx,
        'StockUnit',
        {
          ...unit.toJSON(),
          selectedForReturn: sns.includes(unit.serialNumber),
          observationFingerprint: check.fingerprint,
        },
        'lifecycle.mapping_evidence'
      );
    }
    return await applyCheck(ctx, review.orderId, { ...check, ['manual_serials']: sns });
  } catch (error) {
    logger.warn('人工退货确认失败', { code: error.code || error.name });
    throw error;
  }
}

/** 核实已售冲突或退货撤销；恢复不触碰销售和资金，原仓必须仍有效。 */
async function resolveReturn(ctx, id, input) {
  try {
    requirePermissions(ctx, 'stock.correct', 'stock.receive');
    ctx.reason = text(input.reason, '核实依据', 500, true);
    const unit = await getRow('StockUnit', id, ctx);
    if (!unit) throw ApiError.notFound();
    assertVersion(unit, input.expectedVersion);
    const binding = await db.PickupDevice.findOne({
      where: { stockUnitId: id },
      transaction: ctx.transaction,
    });
    if (!binding) throw ApiError.conflict('设备来源订单已变化');
    await accessibleOrder(ctx, binding.orderId);
    const check = await checkForOrder(binding.orderId, ctx.transaction);
    if (!check?.fingerprint) throw ApiError.conflict('请先完成官网检查');
    const resolution = choice(input.resolution, ['keep_sold', 'restore_previous']);
    let values;
    if (resolution === 'keep_sold') {
      if (unit.state !== 'sold' || unit.lifecycleIssue !== 'sold_return_conflict')
        throw ApiError.conflict('设备不处于已售退货冲突');
      values = { lifecycleIssue: null, returnDecisionFingerprint: check.fingerprint };
    } else {
      if (unit.state !== 'returned' || unit.lifecycleIssue !== 'return_withdrawn')
        throw ApiError.conflict('仅允许恢复官网已撤销退货且人工核实的设备');
      if (unit.returnPreviousState === 'in_stock') {
        const location = await db.StockLocation.findByPk(unit.returnLocationId, {
          transaction: ctx.transaction,
        });
        if (!location?.isActive || location.kind !== 'warehouse')
          throw ApiError.conflict('原仓库不可用，请先恢复仓库配置');
      }
      values = {
        state: unit.returnPreviousState,
        locationId: unit.returnLocationId,
        returnedAt: null,
        returnPreviousState: null,
        returnLocationId: null,
        lifecycleIssue: null,
        returnDecisionFingerprint: null,
      };
    }
    await updateRow(ctx, unit, values, 'lifecycle.resolve');
    return { ledgerUnitIds: [id] };
  } catch (error) {
    logger.warn('退货异常核实失败', { code: error.code || error.name });
    throw error;
  }
}
module.exports = { checkForOrder, observe, returnReview, confirmReturns, resolveReturn };
