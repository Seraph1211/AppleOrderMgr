const { fault, validateSample, hash } = require('./officialOrderSupport');

const MAX_RECEIPT_AGE_MS = 86400000;
const REQUIRED_PERMISSIONS = ['orders.read', 'pickups.read', 'pickups.edit'];
const ACTION = 'official.receipt_bind';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** 对活动设备身份计算确定性摘要；不读取或改变库存数量、成本及销售状态。 */
function deviceSetHash(devices) {
  return hash(
    JSON.stringify(
      devices
        .map(value => ({
          id: value.id,
          orderId: value.orderId,
          serialNumber: value.serialNumber,
          stockUnitId: value.stockUnitId || null,
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    )
  );
}

/** 验证内部绑定契约，错误码不携带订单凭据或其他订单信息。 */
function validateReceiptBinding(payload, now = Date.now(), allowHistorical = false) {
  if (
    !payload ||
    payload.version !== 1 ||
    !UUID.test(payload.requestKey || '') ||
    !UUID.test(payload.batchId || '') ||
    !Number.isSafeInteger(payload.orderId) ||
    payload.orderId <= 0 ||
    !Number.isSafeInteger(payload.actorUserId) ||
    payload.actorUserId <= 0 ||
    !/^W\d{10}$/.test(payload.orderNumber || '') ||
    !/^[a-f0-9]{32}$/.test(payload.orderBeforeHash || '') ||
    !/^[a-f0-9]{64}$/.test(payload.devicesBeforeHash || '')
  )
    throw fault('RECEIPT_BINDING_INPUT_INVALID');
  const receipt = payload.receipt;
  const observed = Date.parse(receipt?.observedAt);
  if (
    !receipt ||
    !Number.isSafeInteger(receipt.runId) ||
    receipt.runId <= 0 ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256 || '') ||
    !/^[a-f0-9]{64}$/.test(receipt.detailSha256 || '') ||
    receipt.egressVerified !== true ||
    receipt.requestCoverageVerified !== true ||
    !Number.isFinite(observed) ||
    observed > now ||
    (!allowHistorical && now - observed > MAX_RECEIPT_AGE_MS)
  )
    throw fault('RECEIPT_BINDING_PROOF_INVALID');
  const items = payload.items;
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.length > 100 ||
    items.some(
      item =>
        !/^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(item.serialNumber || '') ||
        !/[A-Z]/.test(item.serialNumber) ||
        typeof item.partNumber !== 'string' ||
        !item.partNumber.trim() ||
        typeof item.productName !== 'string' ||
        !item.productName.trim()
    )
  )
    throw fault('RECEIPT_BINDING_SERIAL_INVALID');
  const serials = items.map(item => item.serialNumber).sort();
  if (new Set(serials).size !== serials.length) throw fault('RECEIPT_BINDING_SERIAL_INVALID');
  return { serials, serialsHash: hash(JSON.stringify(serials)) };
}

async function currentActor(deps, actorUserId, transaction) {
  try {
    const user = await deps.db.User.findByPk(actorUserId, { transaction });
    if (!user || user.role !== 'admin' || user.status !== 'active' || user.deletedAt)
      throw fault('RECEIPT_ACTOR_INVALID');
    const permissions = await deps.getEffectivePermissions(user, { transaction });
    if (REQUIRED_PERMISSIONS.some(code => !permissions.includes(code)))
      throw fault('RECEIPT_PERMISSION_DENIED');
    return user;
  } catch (error) {
    error.component = 'officialReceiptActor';
    throw error;
  }
}

async function orderSnapshot(db, orderId, transaction, lock = false) {
  try {
    const [rows] = await db.sequelize.query(
      `SELECT o.id,o.order_number AS "orderNumber",o.email_order_status AS status,
       md5(to_jsonb(o)::text) AS hash FROM orders o WHERE id=:id${lock ? ' FOR UPDATE' : ''}`,
      { replacements: { id: orderId }, transaction }
    );
    if (rows.length !== 1) throw fault('RECEIPT_ORDER_MISSING');
    return rows[0];
  } catch (error) {
    error.component = 'officialReceiptOrderSnapshot';
    throw error;
  }
}

/** 单事务批量绑定一张订单的全部设备；复用生产 StockOperation 幂等与库存审计。 */
async function bindOfficialReceipt(payload, deps) {
  try {
    const { serials, serialsHash } = validateReceiptBinding(payload);
    const db = deps.db;
    const user = await currentActor(deps, payload.actorUserId);
    if (!db.StockUnit || !db.StockOperation || !deps.stock.runCommand || !deps.units.bindSource)
      throw fault('RECEIPT_RUNTIME_UNSUPPORTED');
    return await deps.stock.runCommand(
      user,
      payload,
      ACTION,
      REQUIRED_PERMISSIONS,
      async ctx => {
        try {
          if (ctx.user.role !== 'admin') throw fault('RECEIPT_ACTOR_INVALID');
          const transaction = ctx.transaction;
          const before = await orderSnapshot(db, payload.orderId, transaction, true);
          if (
            before.orderNumber !== payload.orderNumber ||
            before.status !== 'picked_up' ||
            before.hash !== payload.orderBeforeHash
          )
            throw fault('RECEIPT_ORDER_CHANGED');
          const devices = await db.PickupDevice.findAll({
            where: {
              [deps.Op.or]: [
                { orderId: payload.orderId },
                { serialNumber: { [deps.Op.in]: serials } },
              ],
            },
            transaction,
          });
          if (
            devices.some(
              device => device.orderId !== payload.orderId || !serials.includes(device.serialNumber)
            )
          )
            throw fault('RECEIPT_DEVICE_CONFLICT');
          if (deviceSetHash(devices) !== payload.devicesBeforeHash)
            throw fault('RECEIPT_DEVICE_SNAPSHOT_CHANGED');
          const existingUnits = await db.StockUnit.findAll({
            where: { serialNumber: { [deps.Op.in]: serials } },
            transaction,
          });
          if (existingUnits.some(unit => unit.orderNumberText))
            throw fault('RECEIPT_STOCK_SOURCE_CONFLICT');
          if (
            devices.some(
              device =>
                device.stockUnitId &&
                !existingUnits.some(
                  unit =>
                    unit.id === device.stockUnitId && unit.serialNumber === device.serialNumber
                )
            )
          )
            throw fault('RECEIPT_STOCK_BINDING_CONFLICT');
          let newBindings = 0;
          const deviceIds = [];
          for (const serial of serials) {
            const existing = devices.find(device => device.serialNumber === serial);
            const unit = await deps.units.ensureUnit(ctx, serial);
            const device = await deps.units.bindSource(ctx, unit, payload.orderId, undefined, {
              legacy: true,
            });
            if (!device || device.orderId !== payload.orderId || device.serialNumber !== serial)
              throw fault('RECEIPT_BIND_RESPONSE_INVALID');
            if (!existing) newBindings += 1;
            deviceIds.push(device.id);
          }
          const after = await orderSnapshot(db, payload.orderId, transaction);
          if (before.hash !== after.hash) throw fault('RECEIPT_ORDER_MUTATED');
          return {
            outcome: 'RECEIPT_BOUND',
            orderId: payload.orderId,
            batchId: payload.batchId,
            receiptRunId: payload.receipt.runId,
            receiptSha256: payload.receipt.sha256,
            detailSha256: payload.receipt.detailSha256,
            serialsHash,
            serialCount: serials.length,
            newBindings,
            deviceIds,
            orderBeforeHash: before.hash,
            orderAfterHash: after.hash,
            manualPickupUnchanged: true,
            inventoryReceiveCreated: false,
          };
        } catch (error) {
          error.component = 'officialReceiptBindingTransaction';
          throw error;
        }
      },
      { allowDisabled: true }
    );
  } catch (error) {
    error.component = 'officialReceiptBinding';
    throw error;
  }
}

/** 结果未知时仅只读对账；取得同一库存锁后才检查事务标记，避免观察未提交结果。 */
async function reconcileOfficialReceipt(payload, deps) {
  try {
    const { serials, serialsHash } = validateReceiptBinding(payload, Date.now(), true);
    const db = deps.db;
    return await db.sequelize.transaction(async transaction => {
      try {
        await db.sequelize.query('SET TRANSACTION READ ONLY', { transaction });
        await deps.stock.lockStock(transaction);
        await currentActor(deps, payload.actorUserId, transaction);
        const operation = await db.StockOperation.findOne({
          where: { actorKey: String(payload.actorUserId), requestKey: payload.requestKey },
          transaction,
        });
        if (!operation) return { outcome: 'RECEIPT_NOT_APPLIED', orderId: payload.orderId };
        const refs = operation.resultRefs;
        if (
          operation.action !== ACTION ||
          refs?.outcome !== 'RECEIPT_BOUND' ||
          refs.orderId !== payload.orderId ||
          refs.receiptSha256 !== payload.receipt.sha256 ||
          refs.detailSha256 !== payload.receipt.detailSha256 ||
          refs.batchId !== payload.batchId ||
          refs.receiptRunId !== payload.receipt.runId ||
          refs.serialsHash !== serialsHash
        )
          throw fault('RECEIPT_OPERATION_CONFLICT');
        const order = await orderSnapshot(db, payload.orderId, transaction);
        const devices = await db.PickupDevice.findAll({
          where: { orderId: payload.orderId },
          transaction,
        });
        if (
          order.orderNumber !== payload.orderNumber ||
          order.hash !== refs.orderAfterHash ||
          devices.length !== serials.length ||
          devices.some(
            device =>
              !serials.includes(device.serialNumber) ||
              !refs.deviceIds.includes(device.id) ||
              !device.stockUnitId
          )
        )
          throw fault('RECEIPT_READBACK_CONFLICT');
        const units = await db.StockUnit.findAll({
          where: { serialNumber: { [deps.Op.in]: serials } },
          transaction,
        });
        if (
          units.length !== serials.length ||
          devices.some(
            device =>
              !units.some(
                unit => unit.id === device.stockUnitId && unit.serialNumber === device.serialNumber
              )
          )
        )
          throw fault('RECEIPT_READBACK_CONFLICT');
        const result = { ...refs };
        delete result._permissions;
        return { ...result, outcome: 'RECEIPT_READBACK_VERIFIED' };
      } catch (error) {
        error.component = 'officialReceiptReconcileTransaction';
        throw error;
      }
    });
  } catch (error) {
    error.component = 'officialReceiptReconcile';
    throw error;
  }
}

/** 采集前单次只读快照；账号档案、订单凭据和设备状态一起校验，秘密只进入私密输入。 */
async function readReceiptInput(orderId, actorUserId, deps) {
  try {
    if (
      !Number.isSafeInteger(orderId) ||
      orderId <= 0 ||
      !Number.isSafeInteger(actorUserId) ||
      actorUserId <= 0
    )
      throw fault('RECEIPT_INPUT_INVALID');
    const db = deps.db;
    return await db.sequelize.transaction(async transaction => {
      try {
        await db.sequelize.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', {
          transaction,
        });
        await currentActor(deps, actorUserId, transaction);
        const [rows] = await db.sequelize.query(
          `SELECT o.id,o.order_number,o.order_url,o.apple_id,o.apple_password,o.apple_id_ref,o.email_order_status,
          md5(to_jsonb(o)::text) AS row_hash,
          (SELECT coalesce(json_agg(candidate),'[]'::json) FROM (SELECT a.id,a.apple_id,a.password,a.status FROM apple_ids a
            WHERE a.id=o.apple_id_ref OR lower(btrim(a.apple_id))=lower(btrim(o.apple_id)) ORDER BY a.id LIMIT 3) candidate) AS account_candidates
          FROM orders o WHERE o.id=:id`,
          { replacements: { id: orderId }, transaction }
        );
        const row = rows[0];
        if (!row || row.email_order_status !== 'picked_up')
          throw fault('RECEIPT_ORDER_NOT_PICKED_UP');
        const account = String(row.apple_id || '')
          .trim()
          .toLowerCase();
        const matches = row.account_candidates.filter(
          candidate => String(candidate.apple_id).trim().toLowerCase() === account
        );
        if (
          matches.length !== 1 ||
          (row.apple_id_ref && matches[0].id !== row.apple_id_ref) ||
          matches[0].status === '异常'
        )
          throw fault('RECEIPT_ACCOUNT_CONFLICT');
        const password = deps.decrypt(matches[0].password);
        if (!password || !row.apple_password || deps.decrypt(row.apple_password) !== password)
          throw fault('RECEIPT_CREDENTIAL_CONFLICT');
        const sample = validateSample({
          id: row.id,
          orderNumber: row.order_number,
          url: row.order_url,
          email: row.apple_id.trim(),
          password,
          beforeRowHash: row.row_hash,
          snapshotPasswordMatches: true,
          credentialSource: 'accountRegistry',
        });
        const devices = await db.PickupDevice.findAll({ where: { orderId }, transaction });
        return {
          samples: [sample],
          actorUserId,
          devicesBeforeHash: deviceSetHash(devices),
          previousDeviceCount: devices.length,
        };
      } catch (error) {
        error.component = 'officialReceiptInputTransaction';
        throw error;
      }
    });
  } catch (error) {
    error.component = 'officialReceiptInput';
    throw error;
  }
}

/** 一次 SQL 冻结批次身份；每次真正采集仍重新读取并校验凭据与设备。 */
async function readReceiptPlan(orderIds, actorUserId, deps) {
  try {
    if (
      !Array.isArray(orderIds) ||
      !orderIds.length ||
      orderIds.length > 10000 ||
      new Set(orderIds).size !== orderIds.length ||
      orderIds.some(id => !Number.isSafeInteger(id) || id < 1)
    )
      throw fault('RECEIPT_PLAN_INVALID');
    return await deps.db.sequelize.transaction(async transaction => {
      try {
        await deps.db.sequelize.query('SET TRANSACTION READ ONLY', { transaction });
        await currentActor(deps, actorUserId, transaction);
        const [rows] = await deps.db.sequelize.query(
          `SELECT id,order_number AS "orderNumber",
          lower(btrim(apple_id)) AS account,email_order_status AS status,order_url IS NOT NULL AS "hasUrl"
          FROM orders WHERE id IN (:ids)`,
          { replacements: { ids: orderIds }, transaction }
        );
        const byId = new Map(rows.map(row => [row.id, row]));
        return orderIds.map(orderId => {
          const row = byId.get(orderId);
          if (!row || row.status !== 'picked_up' || !row.hasUrl || !row.account)
            return { orderId, outcome: 'RECEIPT_ORDER_NOT_ELIGIBLE' };
          return {
            orderId,
            outcome: 'RECEIPT_READY',
            accountHash: hash(row.account),
            identity: hash(JSON.stringify([orderId, row.orderNumber, hash(row.account)])),
          };
        });
      } catch (error) {
        error.component = 'officialReceiptPlanTransaction';
        throw error;
      }
    });
  } catch (error) {
    error.component = 'officialReceiptPlan';
    throw error;
  }
}

module.exports = {
  deviceSetHash,
  validateReceiptBinding,
  bindOfficialReceipt,
  reconcileOfficialReceipt,
  readReceiptInput,
  readReceiptPlan,
};
